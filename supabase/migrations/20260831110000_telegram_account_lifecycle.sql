-- R3-001: durable Telegram-account lifecycle without coupling product settings,
-- subscriptions, or Mini App identity to a replaceable Telegram session.

alter table public.telegram_accounts
  alter column encrypted_session drop not null,
  alter column encryption_key_version drop not null,
  add column session_authenticated_at timestamptz,
  add column session_revoked_at timestamptz;

alter table public.telegram_accounts
  drop constraint telegram_accounts_status_check,
  add constraint telegram_accounts_status_check
    check (status in ('CONNECTING', 'DISCONNECTED', 'READY', 'DEGRADED', 'REVOKED', 'DISABLED'));

update public.telegram_accounts
   set session_authenticated_at = coalesce(session_authenticated_at, created_at)
 where encrypted_session is not null;

-- A historical REVOKED row never keeps usable session material after this migration.
update public.telegram_accounts
   set encrypted_session = null,
       encryption_key_version = null,
       session_revoked_at = coalesce(session_revoked_at, updated_at, now())
 where status = 'REVOKED';

update public.userbot_profile_accounts link
   set status = 'DETACHED', detached_at = coalesce(link.detached_at, now())
  from public.telegram_accounts account
 where link.account_id = account.id
   and link.status = 'ATTACHED'
   and account.status = 'REVOKED';

update public.userbot_profiles profile
   set active_account_id = null, status = 'NEEDS_REAUTH', updated_at = now()
 where profile.active_account_id in (
   select id from public.telegram_accounts where status = 'REVOKED'
 );

alter table public.telegram_accounts
  add constraint telegram_accounts_session_pair_check check (
    (encrypted_session is null) = (encryption_key_version is null)
  ),
  add constraint telegram_accounts_session_material_check check (
    (status in ('CONNECTING', 'REVOKED') and encrypted_session is null)
    or
    (status in ('DISCONNECTED', 'READY', 'DEGRADED', 'DISABLED') and encrypted_session is not null)
  ),
  add constraint telegram_accounts_session_revocation_check check (
    (status = 'REVOKED' and session_revoked_at is not null)
    or
    (status <> 'REVOKED' and session_revoked_at is null)
  );

create function public.enforce_telegram_account_session_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status = 'REVOKED' then
    new.encrypted_session := null;
    new.encryption_key_version := null;
    new.runtime_retry_at := null;
    new.session_revoked_at := coalesce(new.session_revoked_at, now());
  elsif new.encrypted_session is not null then
    if tg_op = 'INSERT' then
      new.session_authenticated_at := coalesce(new.session_authenticated_at, now());
    elsif new.encrypted_session is distinct from old.encrypted_session then
      new.session_authenticated_at := coalesce(new.session_authenticated_at, now());
    end if;
    new.session_revoked_at := null;
  end if;
  return new;
end;
$$;

create trigger telegram_accounts_enforce_session_lifecycle
before insert or update of status, encrypted_session, encryption_key_version
on public.telegram_accounts
for each row execute function public.enforce_telegram_account_session_lifecycle();

create function public.detach_revoked_userbot_account()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.account_type = 'USERBOT'
     and new.status = 'REVOKED'
     and old.status is distinct from new.status then
    update public.userbot_profile_accounts
       set status = 'DETACHED', detached_at = coalesce(detached_at, now())
     where account_id = new.id and status = 'ATTACHED';

    update public.userbot_profiles
       set active_account_id = null, status = 'NEEDS_REAUTH', updated_at = now()
     where active_account_id = new.id;

    delete from public.account_leases where account_id = new.id;
  end if;
  return new;
end;
$$;

create trigger telegram_accounts_detach_revoked_userbot
after update of status on public.telegram_accounts
for each row execute function public.detach_revoked_userbot_account();

create table public.telegram_account_auth_flows (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  status text not null default 'CREATED'
    check (status in (
      'CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING',
      'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'
    )),
  version bigint not null default 1 check (version > 0),
  encrypted_state bytea,
  encryption_key_version integer,
  completed_account_id uuid references public.telegram_accounts(id) on delete set null,
  last_error_code text,
  expires_at timestamptz not null,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_account_auth_flows_expiry_check
    check (expires_at > created_at),
  constraint telegram_account_auth_flows_state_pair_check check (
    (encrypted_state is null and encryption_key_version is null)
    or
    (
      encrypted_state is not null
      and octet_length(encrypted_state) between 1 and 131072
      and encryption_key_version > 0
    )
  ),
  constraint telegram_account_auth_flows_payload_check check (
    (status = 'CREATED' and encrypted_state is null)
    or
    (status in ('CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING') and encrypted_state is not null)
    or
    (status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') and encrypted_state is null)
  ),
  constraint telegram_account_auth_flows_terminal_check check (
    (
      status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
      and finalized_at is null
      and completed_account_id is null
    )
    or
    (
      status = 'SUCCEEDED'
      and finalized_at is not null
      and completed_account_id is not null
    )
    or
    (
      status in ('FAILED', 'CANCELLED', 'EXPIRED')
      and finalized_at is not null
      and completed_account_id is null
    )
  ),
  constraint telegram_account_auth_flows_error_check check (
    (status = 'FAILED' and last_error_code ~ '^[A-Z][A-Z0-9_]{1,127}$')
    or
    (status <> 'FAILED' and last_error_code is null)
  )
);

create unique index telegram_account_auth_flows_one_active_user_idx
  on public.telegram_account_auth_flows (user_id)
  where status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING');
create index telegram_account_auth_flows_expiry_idx
  on public.telegram_account_auth_flows (expires_at, id)
  where status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING');

create trigger telegram_account_auth_flows_set_updated_at
before update on public.telegram_account_auth_flows
for each row execute function public.set_updated_at();

create function public.begin_userbot_auth_flow(
  p_user_id uuid,
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
   where user_id = p_user_id
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and expires_at <= now();

  select * into flow_row
    from public.telegram_account_auth_flows
   where user_id = p_user_id
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
   for update;

  if found then
    return query select 'ACTIVE_FLOW_EXISTS'::text, flow_row.id, flow_row.status,
                        flow_row.version, flow_row.expires_at;
    return;
  end if;

  insert into public.telegram_account_auth_flows (user_id, expires_at)
  values (p_user_id, now() + make_interval(secs => p_ttl_seconds))
  returning * into flow_row;

  return query select 'CREATED'::text, flow_row.id, flow_row.status,
                      flow_row.version, flow_row.expires_at;
end;
$$;

create function public.transition_userbot_auth_flow(
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
    when 'CREATED' then p_next_status in ('CODE_REQUIRED', 'FAILED', 'CANCELLED')
    when 'CODE_REQUIRED' then p_next_status in (
      'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED'
    )
    when 'PASSWORD_REQUIRED' then p_next_status in (
      'PASSWORD_REQUIRED', 'VERIFYING', 'FAILED', 'CANCELLED'
    )
    when 'VERIFYING' then p_next_status in ('VERIFYING', 'FAILED', 'CANCELLED')
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

create function public.expire_userbot_auth_flows(p_at timestamptz default now())
returns integer
language plpgsql
set search_path = public
as $$
declare
  expired_count integer;
begin
  if p_at is null then
    raise exception using errcode = 'P0001', message = 'INVALID_EXPIRY_TIME';
  end if;
  update public.telegram_account_auth_flows
     set status = 'EXPIRED', encrypted_state = null,
         encryption_key_version = null, finalized_at = p_at, version = version + 1
   where status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and expires_at <= p_at;
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

create function public.revoke_userbot_account_session(
  p_user_id uuid,
  p_account_id uuid
)
returns text
language plpgsql
set search_path = public
as $$
declare
  account_row public.telegram_accounts%rowtype;
begin
  select * into account_row
    from public.telegram_accounts
   where id = p_account_id
     and owner_user_id = p_user_id
     and account_type = 'USERBOT'
   for update;
  if not found then return 'NOT_FOUND'; end if;
  if account_row.status = 'REVOKED' then return 'ALREADY_REVOKED'; end if;

  update public.telegram_accounts
     set status = 'REVOKED', last_runtime_error_code = null,
         last_runtime_error_at = null, runtime_retry_at = null, updated_at = now()
   where id = p_account_id;

  -- The revoke trigger marks a Telegram-invalidated profile NEEDS_REAUTH. An
  -- explicit user logout is intentional, so its profile settles as DISCONNECTED.
  update public.userbot_profiles
     set status = 'DISCONNECTED', active_account_id = null, updated_at = now()
   where user_id = p_user_id and active_account_id is null;

  return 'REVOKED';
end;
$$;

alter table public.telegram_account_auth_flows enable row level security;
revoke all on table public.telegram_account_auth_flows from public, anon, authenticated;
revoke all on function public.enforce_telegram_account_session_lifecycle() from public;
revoke all on function public.detach_revoked_userbot_account() from public;
revoke all on function public.begin_userbot_auth_flow(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.transition_userbot_auth_flow(
  uuid, uuid, bigint, text, bytea, integer, text
) from public, anon, authenticated;
revoke all on function public.expire_userbot_auth_flows(timestamptz)
  from public, anon, authenticated;
revoke all on function public.revoke_userbot_account_session(uuid, uuid)
  from public, anon, authenticated;

grant select, insert, update, delete on table public.telegram_account_auth_flows
  to service_role;
grant execute on function public.begin_userbot_auth_flow(uuid, integer) to service_role;
grant execute on function public.transition_userbot_auth_flow(
  uuid, uuid, bigint, text, bytea, integer, text
) to service_role;
grant execute on function public.expire_userbot_auth_flows(timestamptz) to service_role;
grant execute on function public.revoke_userbot_account_session(uuid, uuid) to service_role;

comment on table public.telegram_account_auth_flows
  is 'Short-lived server-only Telegram authorization state; OTP and 2FA values are never persisted.';
comment on function public.begin_userbot_auth_flow(uuid, integer)
  is 'Serializes one bounded active Telegram authorization flow per canonical Mini App user.';
comment on function public.transition_userbot_auth_flow(uuid, uuid, bigint, text, bytea, integer, text)
  is 'Optimistic-version state transition that clears encrypted transient state on every terminal outcome.';
comment on function public.revoke_userbot_account_session(uuid, uuid)
  is 'Atomically destroys a user-owned Userbot session and runtime lease while preserving profile/settings rows.';
