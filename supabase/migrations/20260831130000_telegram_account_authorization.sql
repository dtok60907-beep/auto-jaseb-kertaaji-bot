-- R3-002: atomic claim/finalization primitives for restart-safe Telegram login.
-- External Telegram calls happen outside PostgreSQL, but each call is fenced by
-- auth-flow version and status so duplicate HTTP submissions cannot both proceed.

-- A SUCCEEDED flow must always reference its completed account. SET NULL from
-- R3-001 conflicts with that invariant; true account deletion removes only the
-- corresponding authorization history, while normal logout never deletes rows.
alter table public.telegram_account_auth_flows
  drop constraint telegram_account_auth_flows_completed_account_id_fkey,
  add constraint telegram_account_auth_flows_completed_account_id_fkey
    foreign key (completed_account_id) references public.telegram_accounts(id)
    on delete cascade;

create or replace function public.transition_userbot_auth_flow(
  p_user_id uuid,
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
   where id = p_auth_flow_id and user_id = p_user_id
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
    when 'CODE_REQUIRED' then p_next_status in (
      'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED'
    )
    when 'PASSWORD_REQUIRED' then p_next_status in (
      'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED'
    )
    -- A claimed Telegram call may return to its input state on a retryable user
    -- error, or advance from OTP to 2FA without releasing the version fence.
    when 'VERIFYING' then p_next_status in (
      'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED'
    )
    else false
  end;

  if not transition_allowed then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_TRANSITION';
  end if;
  if p_next_status in ('CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and (
       p_encrypted_state is null
       or p_encryption_key_version is null
       or p_encryption_key_version < 1
     ) then
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
         encrypted_state = case
           when p_next_status in ('FAILED', 'CANCELLED') then null
           else p_encrypted_state
         end,
         encryption_key_version = case
           when p_next_status in ('FAILED', 'CANCELLED') then null
           else p_encryption_key_version
         end,
         last_error_code = p_error_code,
         finalized_at = case when p_next_status in ('FAILED', 'CANCELLED') then now() end,
         version = version + 1
   where id = flow_row.id
   returning * into flow_row;

  return query select 'UPDATED'::text, flow_row.status,
                      flow_row.version, flow_row.expires_at;
end;
$$;

create function public.claim_userbot_auth_flow_step(
  p_user_id uuid,
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
   where id = p_auth_flow_id and user_id = p_user_id
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

create function public.complete_userbot_auth_flow(
  p_user_id uuid,
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
begin
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
   where id = p_auth_flow_id and user_id = p_user_id
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

  -- Provider identity is the global authority, so serialize finalization even
  -- when two different Mini App users finish Telegram login simultaneously.
  perform pg_advisory_xact_lock(p_provider_user_id);
  select * into account_row
    from public.telegram_accounts
   where provider_user_id = p_provider_user_id
   for update;

  if found and (
    account_row.account_type <> 'USERBOT'
    or account_row.owner_user_id is distinct from p_user_id
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
      p_account_id, p_user_id, 'USERBOT', normalized_label, p_encrypted_session,
      p_encryption_key_version, p_provider_user_id, 'READY', now()
    ) returning * into account_row;
  end if;

  perform public.switch_userbot_profile_account(p_user_id, account_row.id);

  update public.telegram_account_auth_flows
     set status = 'SUCCEEDED', encrypted_state = null,
         encryption_key_version = null, completed_account_id = account_row.id,
         finalized_at = now(), version = version + 1
   where id = flow_row.id
   returning * into flow_row;

  return query select 'CONNECTED'::text, account_row.id, account_row.label, flow_row.version;
end;
$$;

revoke all on function public.claim_userbot_auth_flow_step(uuid, uuid, bigint, text)
  from public, anon, authenticated;
revoke all on function public.complete_userbot_auth_flow(
  uuid, uuid, bigint, uuid, bigint, text, bytea, integer
) from public, anon, authenticated;
grant execute on function public.claim_userbot_auth_flow_step(uuid, uuid, bigint, text)
  to service_role;
grant execute on function public.complete_userbot_auth_flow(
  uuid, uuid, bigint, uuid, bigint, text, bytea, integer
) to service_role;

comment on function public.claim_userbot_auth_flow_step(uuid, uuid, bigint, text)
  is 'Atomically claims one OTP or 2FA attempt and returns encrypted state only to the backend role.';
comment on function public.complete_userbot_auth_flow(uuid, uuid, bigint, uuid, bigint, text, bytea, integer)
  is 'Atomically binds verified Telegram identity/session, switches the profile, and clears transient auth state.';
