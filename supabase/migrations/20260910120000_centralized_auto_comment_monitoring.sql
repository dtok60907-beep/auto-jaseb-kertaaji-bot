-- Centralized Auto Komen ingestion. A MONITOR account owns the persistent
-- Telegram update stream; buyer USERBOT accounts are only used to deliver a
-- comment after a user-specific rule has matched.

alter table public.telegram_accounts
  drop constraint telegram_accounts_account_type_check,
  add constraint telegram_accounts_account_type_check
    check (account_type in ('JASEB_WORKER', 'USERBOT', 'MONITOR'));

alter table public.telegram_accounts
  add column monitor_active boolean not null default false;

create unique index telegram_accounts_one_active_monitor_idx
  on public.telegram_accounts (monitor_active)
  where account_type = 'MONITOR' and monitor_active;

alter table public.telegram_account_auth_flows
  drop constraint telegram_account_auth_flows_account_type_check,
  add constraint telegram_account_auth_flows_account_type_check
    check (account_type in ('JASEB_WORKER', 'USERBOT', 'MONITOR'));

create table public.auto_comment_monitor_sources (
  id uuid primary key default extensions.gen_random_uuid(),
  source_channel_ref text not null check (char_length(btrim(source_channel_ref)) between 1 and 256),
  normalized_ref text generated always as (lower(btrim(source_channel_ref))) stored unique,
  provider_peer_id text unique,
  monitor_account_id uuid references public.telegram_accounts(id) on delete set null,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'JOINING', 'READY', 'ACCESS_REQUIRED', 'FAILED_RETRYABLE', 'FAILED_FINAL')),
  last_post_id bigint check (last_post_id is null or last_post_id > 0),
  last_event_at timestamptz,
  last_error_code text,
  retry_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index auto_comment_monitor_sources_account_idx
  on public.auto_comment_monitor_sources (monitor_account_id, status, retry_at);

alter table public.auto_comment_channel_targets
  add column monitor_source_id uuid references public.auto_comment_monitor_sources(id) on delete restrict,
  add column central_monitor_start_post_id bigint
    check (central_monitor_start_post_id is null or central_monitor_start_post_id > 0);

insert into public.auto_comment_monitor_sources (source_channel_ref)
select distinct on (lower(btrim(source_channel_ref))) source_channel_ref
  from public.auto_comment_channel_targets
 order by lower(btrim(source_channel_ref)), created_at, id
on conflict (normalized_ref) do nothing;

update public.auto_comment_channel_targets target
   set monitor_source_id = source.id
  from public.auto_comment_monitor_sources source
 where source.normalized_ref = lower(btrim(target.source_channel_ref));

-- Continue from the oldest durable per-user polling cursor. Candidate
-- uniqueness makes re-reading the overlap harmless, while choosing the oldest
-- cursor prevents a buyer that was behind from losing posts during cutover.
update public.auto_comment_monitor_sources source
   set last_post_id = checkpoint.last_post_id
  from (
    select monitor_source_id, min(monitoring_last_post_id) as last_post_id
      from public.auto_comment_channel_targets
     where monitoring_last_post_id is not null
     group by monitor_source_id
  ) checkpoint
 where checkpoint.monitor_source_id = source.id;

update public.auto_comment_channel_targets target
   set central_monitor_start_post_id = coalesce(target.monitoring_last_post_id, source.last_post_id)
  from public.auto_comment_monitor_sources source
 where source.id = target.monitor_source_id;

alter table public.auto_comment_channel_targets
  alter column monitor_source_id set not null;

create index auto_comment_channel_targets_monitor_source_idx
  on public.auto_comment_channel_targets (monitor_source_id)
  where active;

create function public.assign_auto_comment_monitor_source()
returns trigger
language plpgsql
set search_path = public
as $$
declare source_id uuid;
begin
  insert into public.auto_comment_monitor_sources (source_channel_ref)
  values (new.source_channel_ref)
  on conflict (normalized_ref) do update
     set source_channel_ref = excluded.source_channel_ref
  returning id into source_id;
  new.monitor_source_id := source_id;
  select last_post_id into new.central_monitor_start_post_id
    from public.auto_comment_monitor_sources
   where id = source_id;
  return new;
end;
$$;

create trigger auto_comment_channel_targets_assign_monitor_source
before insert or update of source_channel_ref
on public.auto_comment_channel_targets
for each row execute function public.assign_auto_comment_monitor_source();

create function public.cleanup_auto_comment_monitor_source()
returns trigger
language plpgsql
set search_path = public
as $$
declare previous_source_id uuid := old.monitor_source_id;
begin
  if tg_op = 'UPDATE' and new.monitor_source_id is not distinct from previous_source_id then
    return new;
  end if;
  delete from public.auto_comment_monitor_sources source
   where source.id = previous_source_id
     and not exists (
       select 1 from public.auto_comment_channel_targets target
        where target.monitor_source_id = source.id
     );
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger auto_comment_channel_targets_cleanup_monitor_source
after delete or update of monitor_source_id
on public.auto_comment_channel_targets
for each row execute function public.cleanup_auto_comment_monitor_source();

create table public.auto_comment_monitor_events (
  id uuid primary key default extensions.gen_random_uuid(),
  source_id uuid not null references public.auto_comment_monitor_sources(id) on delete cascade,
  provider_post_id bigint not null check (provider_post_id > 0),
  content text not null check (char_length(content) <= 4096),
  provider_posted_at timestamptz,
  status text not null default 'PENDING' check (status in ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner uuid,
  lease_until timestamptz,
  last_error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source_id, provider_post_id)
);

create index auto_comment_monitor_events_pending_idx
  on public.auto_comment_monitor_events (status, received_at)
  where status in ('PENDING', 'PROCESSING');

create function public.notify_auto_comment_monitor_config()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_notify('jaseb_auto_comment_monitor', 'reload');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger auto_comment_targets_monitor_reload
after insert or delete or update of active, source_channel_ref, resolution_status, account_id
on public.auto_comment_channel_targets
for each row execute function public.notify_auto_comment_monitor_config();
create trigger auto_comment_divisions_monitor_reload
after insert or delete or update of active, mode, account_id
on public.auto_comment_divisions
for each row execute function public.notify_auto_comment_monitor_config();
create trigger auto_comment_mappings_monitor_reload
after insert or delete on public.auto_comment_division_channels
for each row execute function public.notify_auto_comment_monitor_config();
create trigger auto_comment_keywords_monitor_reload
after insert or delete or update of keyword on public.auto_comment_division_keywords
for each row execute function public.notify_auto_comment_monitor_config();
create trigger auto_comment_templates_monitor_reload
after insert or delete or update of text_content, active, display_order
on public.auto_comment_division_templates
for each row execute function public.notify_auto_comment_monitor_config();
create trigger entitlements_monitor_reload
after insert or delete or update of status, expires_at, package_snapshot
on public.entitlements
for each row execute function public.notify_auto_comment_monitor_config();
create trigger userbot_profiles_monitor_reload
after insert or delete or update of status, active_account_id
on public.userbot_profiles
for each row execute function public.notify_auto_comment_monitor_config();
create trigger telegram_accounts_monitor_reload
after insert or delete or update of status, monitor_active, encrypted_session
on public.telegram_accounts
for each row execute function public.notify_auto_comment_monitor_config();

-- Keep discussion preparation in the existing userbot runtime, but make the
-- old 5-second monitoring work permanently non-due. The central monitor owns
-- all post ingestion after this migration.
create or replace view public.auto_comment_runtime_eligible_targets
with (security_invoker = true)
as
select target.id as channel_target_id,
       target.user_id,
       target.account_id,
       target.resolution_status,
       target.resolution_available_at,
       null::timestamptz as monitoring_available_at,
       exists (
         select 1 from public.auto_comment_division_channels mapping
          where mapping.channel_target_id = target.id
       ) as has_division
  from public.auto_comment_channel_targets target
  join public.telegram_accounts account on account.id = target.account_id
 where target.active
   and account.status = 'READY'
   and exists (
     select 1 from public.entitlements entitlement
      where entitlement.user_id = target.user_id
        and entitlement.status = 'ACTIVE'
        and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = 'USERBOT'
        and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
   )
   and exists (
     select 1 from public.userbot_profiles profile
      where profile.user_id = target.user_id
        and profile.status = 'CONNECTED'
        and profile.active_account_id = target.account_id
   );

create or replace function public.begin_telegram_account_auth_flow(
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
declare flow_row public.telegram_account_auth_flows%rowtype;
begin
  if p_account_type not in ('JASEB_WORKER', 'USERBOT', 'MONITOR') then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_TYPE';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 900 then
    raise exception using errcode = 'P0001', message = 'INVALID_AUTH_FLOW_TTL';
  end if;
  perform 1 from public.app_users where id = p_user_id and telegram_user_id is not null for update;
  if not found then raise exception using errcode = 'P0001', message = 'APP_USER_NOT_READY'; end if;

  update public.telegram_account_auth_flows
     set status = 'EXPIRED', encrypted_state = null, encryption_key_version = null,
         finalized_at = now(), version = version + 1
   where user_id = p_user_id and account_type = p_account_type
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING')
     and expires_at <= now();

  select * into flow_row from public.telegram_account_auth_flows
   where user_id = p_user_id and account_type = p_account_type
     and status in ('CREATED', 'CODE_REQUIRED', 'PASSWORD_REQUIRED', 'VERIFYING') for update;
  if found then
    return query select 'ACTIVE_FLOW_EXISTS'::text, flow_row.id, flow_row.status, flow_row.version, flow_row.expires_at;
    return;
  end if;
  insert into public.telegram_account_auth_flows (user_id, account_type, expires_at)
  values (p_user_id, p_account_type, now() + make_interval(secs => p_ttl_seconds)) returning * into flow_row;
  return query select 'CREATED'::text, flow_row.id, flow_row.status, flow_row.version, flow_row.expires_at;
end;
$$;

create or replace function public.complete_telegram_account_auth_flow(
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
returns table (result_status text, account_id uuid, account_label text, auth_flow_version bigint)
language plpgsql
set search_path = public
as $$
declare
  flow_row public.telegram_account_auth_flows%rowtype;
  account_row public.telegram_accounts%rowtype;
  normalized_label text;
  expected_owner_user_id uuid;
begin
  if p_account_type not in ('JASEB_WORKER', 'USERBOT', 'MONITOR') then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_TYPE';
  end if;
  if p_account_id is null then raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_ID'; end if;
  if p_provider_user_id is null or p_provider_user_id <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_PROVIDER_USER_ID';
  end if;
  normalized_label := btrim(p_label);
  if char_length(normalized_label) not between 1 and 80 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_ACCOUNT_LABEL';
  end if;
  if p_encrypted_session is null or octet_length(p_encrypted_session) not between 41 and 65576
     or p_encryption_key_version is null or p_encryption_key_version < 1 then
    raise exception using errcode = 'P0001', message = 'INVALID_TELEGRAM_SESSION_ENVELOPE';
  end if;

  select * into flow_row from public.telegram_account_auth_flows
   where id = p_auth_flow_id and user_id = p_user_id and account_type = p_account_type for update;
  if not found then return query select 'NOT_FOUND'::text, null::uuid, null::text, null::bigint; return; end if;
  if flow_row.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED') then
    return query select 'FLOW_TERMINAL'::text, flow_row.completed_account_id, null::text, flow_row.version; return;
  end if;
  if flow_row.expires_at <= now() then
    update public.telegram_account_auth_flows
       set status = 'EXPIRED', encrypted_state = null, encryption_key_version = null,
           finalized_at = now(), version = version + 1
     where id = flow_row.id returning * into flow_row;
    return query select 'FLOW_EXPIRED'::text, null::uuid, null::text, flow_row.version; return;
  end if;
  if p_expected_version is distinct from flow_row.version then
    return query select 'VERSION_CONFLICT'::text, null::uuid, null::text, flow_row.version; return;
  end if;
  if flow_row.status <> 'VERIFYING' then
    return query select 'STATUS_MISMATCH'::text, null::uuid, null::text, flow_row.version; return;
  end if;

  expected_owner_user_id := case when p_account_type = 'USERBOT' then p_user_id else null end;
  perform pg_advisory_xact_lock(p_provider_user_id);
  select * into account_row from public.telegram_accounts where provider_user_id = p_provider_user_id for update;
  if found and (account_row.account_type <> p_account_type
    or account_row.owner_user_id is distinct from expected_owner_user_id) then
    return query select 'ACCOUNT_ALREADY_CONNECTED'::text, null::uuid, null::text, flow_row.version; return;
  end if;
  if found and account_row.id is distinct from p_account_id then
    return query select 'ACCOUNT_ID_MISMATCH'::text, account_row.id, account_row.label, flow_row.version; return;
  end if;

  if p_account_type = 'MONITOR' then
    update public.telegram_accounts
       set monitor_active = false, updated_at = now()
     where account_type = 'MONITOR'
       and monitor_active
       and id is distinct from p_account_id;
  end if;

  if found then
    update public.telegram_accounts
       set label = normalized_label,
           encrypted_session = p_encrypted_session,
           encryption_key_version = p_encryption_key_version,
           status = 'READY',
           monitor_active = case when p_account_type = 'MONITOR' then true else monitor_active end,
           session_authenticated_at = now(), session_revoked_at = null,
           last_runtime_error_code = null, last_runtime_error_at = null,
           runtime_retry_at = null, updated_at = now()
     where id = account_row.id returning * into account_row;
  else
    insert into public.telegram_accounts (
      id, owner_user_id, account_type, label, encrypted_session, encryption_key_version,
      provider_user_id, status, session_authenticated_at, monitor_active
    ) values (
      p_account_id, expected_owner_user_id, p_account_type, normalized_label,
      p_encrypted_session, p_encryption_key_version, p_provider_user_id, 'READY', now(),
      p_account_type = 'MONITOR'
    ) returning * into account_row;
  end if;

  if p_account_type = 'USERBOT' then perform public.switch_userbot_profile_account(p_user_id, account_row.id); end if;
  update public.telegram_account_auth_flows
     set status = 'SUCCEEDED', encrypted_state = null, encryption_key_version = null,
         completed_account_id = account_row.id, finalized_at = now(), version = version + 1
   where id = flow_row.id returning * into flow_row;
  return query select 'CONNECTED'::text, account_row.id, account_row.label, flow_row.version;
end;
$$;

alter table public.auto_comment_monitor_sources enable row level security;
alter table public.auto_comment_monitor_events enable row level security;
revoke all on public.auto_comment_monitor_sources, public.auto_comment_monitor_events from public, anon, authenticated;
revoke all on function public.assign_auto_comment_monitor_source() from public, anon, authenticated;
revoke all on function public.cleanup_auto_comment_monitor_source() from public, anon, authenticated;
revoke all on function public.notify_auto_comment_monitor_config() from public, anon, authenticated;
revoke all on function public.begin_telegram_account_auth_flow(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.complete_telegram_account_auth_flow(uuid, text, uuid, bigint, uuid, bigint, text, bytea, integer) from public, anon, authenticated;
grant execute on function public.begin_telegram_account_auth_flow(uuid, text, integer) to service_role;
grant execute on function public.complete_telegram_account_auth_flow(uuid, text, uuid, bigint, uuid, bigint, text, bytea, integer) to service_role;

comment on table public.auto_comment_monitor_sources is
  'Canonical Telegram source channels observed once by the centralized MONITOR account and shared by buyer subscriptions.';
comment on table public.auto_comment_monitor_events is
  'Short-lived durable inbox for Telegram channel posts before user-specific matching; source/message uniqueness makes recovery idempotent.';
comment on column public.telegram_accounts.monitor_active is
  'Admin-controlled runtime enablement used only by MONITOR accounts.';
