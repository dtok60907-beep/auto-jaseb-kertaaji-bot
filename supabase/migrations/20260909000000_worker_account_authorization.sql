-- Bind every durable OTP/2FA flow to its intended account type. This lets an
-- admin connect ownerless JASEB_WORKER accounts while keeping buyer Userbot
-- authorization isolated at every step.

alter table public.telegram_account_auth_flows
  add column account_type text not null default 'USERBOT'
    check (account_type in ('JASEB_WORKER', 'USERBOT'));

drop index public.telegram_account_auth_flows_one_active_user_idx;
create unique index telegram_account_auth_flows_one_active_user_type_idx
  on public.telegram_account_auth_flows (user_id, account_type)
  where status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING');

create function public.begin_telegram_account_auth_flow(
  p_user_id uuid,
  p_account_type text,
  p_ttl_seconds integer default 600
)
returns table (
  result_status text,
  auth_flow_id uuid,
  auth_flow_status text,
  auth_flow_version bigint,
  auth_flow_expires_at timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  flow_row public.telegram_account_auth_flows%rowtype;
begin
  if p_account_type not in ('JASEB_WORKER', 'USERBOT') then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_TYPE';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 900 then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_TTL';
  end if;
  perform 1 from public.app_users
   where id = p_user_id and telegram_user_id is not null
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'APP_USER_NOT_READY';
  end if;

  update public.telegram_account_auth_flows
     set status = 'EXPIRED', encrypted_state = null,
         encryption_key_version = null, finalized_at = now(), version = version + 1
   where user_id = p_user_id and account_type = p_account_type
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and expires_at <= now();

  select * into flow_row
    from public.telegram_account_auth_flows
   where user_id = p_user_id and account_type = p_account_type
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
   for update;
  if found then
    return query select 'ACTIVE_FLOW_EXISTS'::text, flow_row.id, flow_row.status,
                        flow_row.version, flow_row.expires_at;
    return;
  end if;

  insert into public.telegram_account_auth_flows (user_id, account_type, expires_at)
  values (p_user_id, p_account_type, now() + make_interval(secs => p_ttl_seconds))
  returning * into flow_row;
  return query select 'CREATED'::text, flow_row.id, flow_row.status,
                      flow_row.version, flow_row.expires_at;
end;
$$;

create function public.transition_telegram_account_auth_flow(
  p_user_id uuid,
  p_account_type text,
  p_auth_flow_id uuid,
  p_expected_version bigint,
  p_next_status text,
  p_encrypted_state bytea default null,
  p_encryption_key_version integer default null,
  p_error_code text default null
)
returns table (
  result_status text,
  auth_flow_status text,
  auth_flow_version bigint,
  auth_flow_expires_at timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  flow_row public.telegram_account_auth_flows%rowtype;
  transition_allowed boolean;
begin
  select * into flow_row
    from public.telegram_account_auth_flows
   where id = p_auth_flow_id and user_id = p_user_id and account_type = p_account_type
   for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::text, null::bigint, null::timestamptz;
    return;
  end if;
  if flow_row.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') then
    return query select 'FLOW_TERMINAL'::text, flow_row.status,
                        flow_row.version, flow_row.expires_at;
    return;
  end if;
  if flow_row.expires_at <= now() then
    update public.telegram_account_auth_flows
       set status = 'EXPIRED', encrypted_state = null,
           encryption_key_version = null, finalized_at = now(), version = version + 1
     where id = flow_row.id
     returning * into flow_row;
    return query select 'FLOW_EXPIRED'::text, flow_row.status,
                        flow_row.version, flow_row.expires_at;
    return;
  end if;
  if p_expected_version is distinct from flow_row.version then
    return query select 'VERSION_CONFLICT'::text, flow_row.status,
                        flow_row.version, flow_row.expires_at;
    return;
  end if;

  transition_allowed := case flow_row.status
    when 'CREATED' then p_next_status in ('CODE_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED')
    when 'CODE_REQUIRED' then p_next_status in ('CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED')
    when 'PASSWORD_REQUIRED' then p_next_status in ('PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED')
    when 'VERIFYING' then p_next_status in ('CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED')
    else false
  end;
  if not transition_allowed then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_TRANSITION';
  end if;
  if p_next_status in ('CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and (p_encrypted_state is null or p_encryption_key_version is null or p_encryption_key_version < 1) then
    raise exception using errcode = 'P0001', message = 'AUTH_FLOW_STATE_REQUIRED';
  end if;
  if p_next_status in ('FAILED', 'CANCELLED')
     and (p_encrypted_state is not null or p_encryption_key_version is not null) then
    raise exception using errcode = 'P0001', message = 'AUTH_FLOW_STATE_FORBIDDEN';
  end if;
  if p_next_status = 'FAILED'
     and coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{1,127}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_ERROR';
  end if;
  if p_next_status <> 'FAILED' and p_error_code is not null then
    raise exception using errcode = 'P0001', message = 'AUTH_FLOW_ERROR_FORBIDDEN';
  end if;

  update public.telegram_account_auth_flows
     set status = p_next_status,
         encrypted_state = case when p_next_status in ('FAILED', 'CANCELLED') then null else p_encrypted_state end,
         encryption_key_version = case when p_next_status in ('FAILED', 'CANCELLED') then null else p_encryption_key_version end,
         last_error_code = p_error_code,
         finalized_at = case when p_next_status in ('FAILED', 'CANCELLED') then now() end,
         version = version + 1
   where id = flow_row.id
   returning * into flow_row;
  return query select 'UPDATED'::text, flow_row.status,
                      flow_row.version, flow_row.expires_at;
end;
$$;

create function public.claim_telegram_account_auth_flow_step(
  p_user_id uuid,
  p_account_type text,
  p_auth_flow_id uuid,
  p_expected_version bigint,
  p_expected_status text
)
returns table (
  result_status text,
  auth_flow_status text,
  auth_flow_version bigint,
  auth_flow_expires_at timestamptz,
  auth_flow_encrypted_state bytea,
  auth_flow_encryption_key_version integer
)
language plpgsql
set search_path = public
as $$
declare
  flow_row public.telegram_account_auth_flows%rowtype;
begin
  if p_expected_status not in ('CODE_REQUIRED', 'PASSWORD_REQUIRED') then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_CLAIM_STATUS';
  end if;
  select * into flow_row
    from public.telegram_account_auth_flows
   where id = p_auth_flow_id and user_id = p_user_id and account_type = p_account_type
   for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::text, null::bigint,
      null::timestamptz, null::bytea, null::integer;
    return;
  end if;
  if flow_row.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') then
    return query select 'FLOW_TERMINAL'::text, flow_row.status, flow_row.version,
      flow_row.expires_at, null::bytea, null::integer;
    return;
  end if;
  if flow_row.expires_at <= now() then
    update public.telegram_account_auth_flows
       set status = 'EXPIRED', encrypted_state = null,
           encryption_key_version = null, finalized_at = now(), version = version + 1
     where id = flow_row.id
     returning * into flow_row;
    return query select 'FLOW_EXPIRED'::text, flow_row.status, flow_row.version,
      flow_row.expires_at, null::bytea, null::integer;
    return;
  end if;
  if p_expected_version is distinct from flow_row.version then
    return query select 'VERSION_CONFLICT'::text, flow_row.status, flow_row.version,
      flow_row.expires_at, null::bytea, null::integer;
    return;
  end if;
  if flow_row.status <> p_expected_status then
    return query select 'STATUS_MISMATCH'::text, flow_row.status, flow_row.version,
      flow_row.expires_at, null::bytea, null::integer;
    return;
  end if;
  update public.telegram_account_auth_flows
     set status = 'VERIFYING', version = version + 1
   where id = flow_row.id
   returning * into flow_row;
  return query select 'CLAIMED'::text, flow_row.status, flow_row.version,
    flow_row.expires_at, flow_row.encrypted_state, flow_row.encryption_key_version;
end;
$$;

create function public.complete_telegram_account_auth_flow(
  p_user_id uuid,
  p_account_type text,
  p_auth_flow_id uuid,
  p_expected_version bigint,
  p_account_id uuid,
  p_provider_user_id bigint,
  p_label text,
  p_encrypted_session bytea,
  p_encryption_key_version integer
)
returns table (
  result_status text,
  account_id uuid,
  account_label text,
  auth_flow_version bigint
)
language plpgsql
set search_path = public
as $$
declare
  flow_row public.telegram_account_auth_flows%rowtype;
  account_row public.telegram_accounts%rowtype;
  normalized_label text;
  expected_owner_user_id uuid;
begin
  if p_account_type not in ('JASEB_WORKER', 'USERBOT') then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_TYPE';
  end if;
  if p_account_id is null then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_ID';
  end if;
  if p_provider_user_id is null or p_provider_user_id <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_PROVIDER_USER_ID';
  end if;
  normalized_label := btrim(p_label);
  if char_length(normalized_label) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_LABEL';
  end if;
  if p_encrypted_session is null
     or octet_length(p_encrypted_session) not between 41 and 65576
     or p_encryption_key_version is null
     or p_encryption_key_version < 1 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_SESSION_ENVELOPE';
  end if;

  select * into flow_row
    from public.telegram_account_auth_flows
   where id = p_auth_flow_id and user_id = p_user_id and account_type = p_account_type
   for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::uuid, null::text, null::bigint;
    return;
  end if;
  if flow_row.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') then
    return query select 'FLOW_TERMINAL'::text, flow_row.completed_account_id,
      null::text, flow_row.version;
    return;
  end if;
  if flow_row.expires_at <= now() then
    update public.telegram_account_auth_flows
       set status = 'EXPIRED', encrypted_state = null,
           encryption_key_version = null, finalized_at = now(), version = version + 1
     where id = flow_row.id
     returning * into flow_row;
    return query select 'FLOW_EXPIRED'::text, null::uuid, null::text, flow_row.version;
    return;
  end if;
  if p_expected_version is distinct from flow_row.version then
    return query select 'VERSION_CONFLICT'::text, null::uuid, null::text, flow_row.version;
    return;
  end if;
  if flow_row.status <> 'VERIFYING' then
    return query select 'STATUS_MISMATCH'::text, null::uuid, null::text, flow_row.version;
    return;
  end if;

  expected_owner_user_id := case when p_account_type = 'USERBOT' then p_user_id else null end;
  perform pg_advisory_xact_lock(p_provider_user_id);
  select * into account_row
    from public.telegram_accounts
   where provider_user_id = p_provider_user_id
   for update;
  if found and (
    account_row.account_type <> p_account_type
    or account_row.owner_user_id is distinct from expected_owner_user_id
  ) then
    return query select 'ACCOUNT_ALREADY_CONNECTED'::text, null::uuid,
      null::text, flow_row.version;
    return;
  end if;
  if found and account_row.id is distinct from p_account_id then
    return query select 'ACCOUNT_ID_MISMATCH'::text, account_row.id,
      account_row.label, flow_row.version;
    return;
  end if;

  if found then
    update public.telegram_accounts
       set label = normalized_label,
           encrypted_session = p_encrypted_session,
           encryption_key_version = p_encryption_key_version,
           status = 'READY',
           session_authenticated_at = now(),
           session_revoked_at = null,
           last_runtime_error_code = null,
           last_runtime_error_at = null,
           runtime_retry_at = null,
           updated_at = now()
     where id = account_row.id
     returning * into account_row;
  else
    insert into public.telegram_accounts (
      id, owner_user_id, account_type, label, encrypted_session,
      encryption_key_version, provider_user_id, status, session_authenticated_at
    ) values (
      p_account_id, expected_owner_user_id, p_account_type, normalized_label,
      p_encrypted_session, p_encryption_key_version, p_provider_user_id, 'READY', now()
    ) returning * into account_row;
  end if;

  if p_account_type = 'USERBOT' then
    perform public.switch_userbot_profile_account(p_user_id, account_row.id);
  end if;
  update public.telegram_account_auth_flows
     set status = 'SUCCEEDED', encrypted_state = null,
         encryption_key_version = null, completed_account_id = account_row.id,
         finalized_at = now(), version = version + 1
   where id = flow_row.id
   returning * into flow_row;
  return query select 'CONNECTED'::text, account_row.id,
                      account_row.label, flow_row.version;
end;
$$;

revoke all on function public.begin_telegram_account_auth_flow(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.transition_telegram_account_auth_flow(uuid, text, uuid, bigint, text, bytea, integer, text) from public, anon, authenticated;
revoke all on function public.claim_telegram_account_auth_flow_step(uuid, text, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.complete_telegram_account_auth_flow(uuid, text, uuid, bigint, uuid, bigint, text, bytea, integer) from public, anon, authenticated;
grant execute on function public.begin_telegram_account_auth_flow(uuid, text, integer) to service_role;
grant execute on function public.transition_telegram_account_auth_flow(uuid, text, uuid, bigint, text, bytea, integer, text) to service_role;
grant execute on function public.claim_telegram_account_auth_flow_step(uuid, text, uuid, bigint, text) to service_role;
grant execute on function public.complete_telegram_account_auth_flow(uuid, text, uuid, bigint, uuid, bigint, text, bytea, integer) to service_role;

comment on column public.telegram_account_auth_flows.account_type
  is 'Immutable intent fence preventing Userbot and admin worker authorization flows from being exchanged.';
comment on function public.complete_telegram_account_auth_flow(uuid, text, uuid, bigint, uuid, bigint, text, bytea, integer)
  is 'Completes a fenced Telegram login as either a buyer-owned USERBOT or an ownerless admin JASEB_WORKER account.';
