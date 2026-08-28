-- Jaseb client product foundation.
-- Supabase provides auth.users and auth.uid(); application writes use service_role.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table public.package_catalog (
  id uuid primary key default extensions.gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  package_type text not null check (package_type in ('JASEB_WORKER', 'USERBOT')),
  price_idr bigint not null check (price_idr >= 0),
  duration_days integer not null check (duration_days > 0),
  features text[] not null default '{}'::text[]
    check (features <@ array['JASEB', 'AUTO_COMMENT_MF']::text[])
    check (cardinality(features) > 0)
    check (package_type <> 'USERBOT' or features @> array['JASEB', 'AUTO_COMMENT_MF']::text[]),
  max_targets_per_minute integer not null check (max_targets_per_minute > 0),
  max_accounts integer not null check (max_accounts > 0),
  interval_min_seconds integer not null check (interval_min_seconds >= 0),
  interval_max_seconds integer not null check (interval_max_seconds >= interval_min_seconds),
  display_order integer not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index package_catalog_public_order_idx
  on public.package_catalog (display_order, created_at)
  where active;

create table public.entitlements (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  package_id uuid references public.package_catalog(id) on delete set null,
  package_snapshot jsonb not null
    check (jsonb_typeof(package_snapshot) = 'object')
    check (package_snapshot ?& array['packageId', 'packageType', 'features', 'maxTargetsPerMinute', 'maxAccounts', 'intervalMinSeconds', 'intervalMaxSeconds']),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'EXPIRED', 'REVOKED', 'CANCELLED')),
  starts_at timestamptz not null,
  expires_at timestamptz not null check (expires_at > starts_at),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index entitlements_user_status_idx on public.entitlements (user_id, status, expires_at);

create table public.telegram_accounts (
  id uuid primary key default extensions.gen_random_uuid(),
  owner_user_id uuid references auth.users(id) on delete cascade,
  account_type text not null check (account_type in ('JASEB_WORKER', 'USERBOT')),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  encrypted_session bytea not null,
  encryption_key_version integer not null check (encryption_key_version > 0),
  status text not null default 'DISCONNECTED' check (status in ('DISCONNECTED', 'READY', 'DEGRADED', 'REVOKED', 'DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (account_type <> 'USERBOT' or owner_user_id is not null)
);

create index telegram_accounts_owner_idx on public.telegram_accounts (owner_user_id, status);

create table public.workflow_operations (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  operation_type text not null check (operation_type in ('BROADCAST', 'AUTO_COMMENT')),
  status text not null default 'QUEUED'
    check (status in ('QUEUED', 'CHECKING', 'JOINING', 'READY', 'SENDING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED')),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 8 and 128),
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
    check (not (payload ?| array['session', 'api_hash', 'otp', 'string_session'])),
  error_code text,
  error_message text,
  correlation_id uuid not null default extensions.gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index workflow_operations_user_created_idx
  on public.workflow_operations (user_id, created_at desc);
create index workflow_operations_queue_idx
  on public.workflow_operations (status, created_at)
  where status in ('QUEUED', 'CHECKING', 'READY', 'SENDING', 'FAILED_RETRYABLE');

create table public.workflow_commands (
  id uuid primary key default extensions.gen_random_uuid(),
  operation_id uuid not null references public.workflow_operations(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  kind text not null check (kind in ('SEND_TEXT', 'COMMENT_TEXT')),
  target_id text not null check (char_length(btrim(target_id)) between 1 and 256),
  idempotency_key text not null unique check (char_length(btrim(idempotency_key)) between 8 and 192),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'CLAIMED', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object')
    check (not (payload ?| array['session', 'api_hash', 'otp', 'string_session'])),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  available_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_owner uuid,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_id, kind, target_id)
);

create index workflow_commands_claim_idx
  on public.workflow_commands (status, available_at, created_at)
  where status in ('PENDING', 'FAILED_RETRYABLE');
create index workflow_commands_operation_idx on public.workflow_commands (operation_id, created_at);

create table public.account_leases (
  account_id uuid primary key references public.telegram_accounts(id) on delete cascade,
  lease_owner uuid not null,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create or replace function public.validate_operation_account_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_owner uuid;
  account_type text;
begin
  select owner_user_id, telegram_accounts.account_type
    into account_owner, account_type
    from public.telegram_accounts
   where telegram_accounts.id = new.account_id;
  if not found then
    raise exception using errcode = '23503', message = 'workflow operation account does not exist';
  end if;
  if account_type = 'USERBOT' and account_owner is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'userbot account ownership mismatch';
  end if;
  if account_type = 'JASEB_WORKER' and account_owner is not null then
    raise exception using errcode = '42501', message = 'worker account must not have a user owner';
  end if;
  return new;
end;
$$;

create trigger workflow_operations_validate_account_owner
before insert or update of user_id, account_id on public.workflow_operations
for each row execute function public.validate_operation_account_owner();

create or replace function public.validate_command_account_owner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  operation_account uuid;
begin
  select account_id into operation_account
    from public.workflow_operations
   where id = new.operation_id;
  if not found then
    raise exception using errcode = '23503', message = 'workflow command operation does not exist';
  end if;
  if operation_account is distinct from new.account_id then
    raise exception using errcode = '42501', message = 'workflow command account mismatch';
  end if;
  return new;
end;
$$;

create trigger workflow_commands_validate_account_owner
before insert or update of operation_id, account_id on public.workflow_commands
for each row execute function public.validate_command_account_owner();

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger package_catalog_set_updated_at before update on public.package_catalog
for each row execute function public.set_updated_at();
create trigger entitlements_set_updated_at before update on public.entitlements
for each row execute function public.set_updated_at();
create trigger telegram_accounts_set_updated_at before update on public.telegram_accounts
for each row execute function public.set_updated_at();
create trigger workflow_operations_set_updated_at before update on public.workflow_operations
for each row execute function public.set_updated_at();
create trigger workflow_commands_set_updated_at before update on public.workflow_commands
for each row execute function public.set_updated_at();
create trigger account_leases_set_updated_at before update on public.account_leases
for each row execute function public.set_updated_at();

alter table public.package_catalog enable row level security;
alter table public.entitlements enable row level security;
alter table public.telegram_accounts enable row level security;
alter table public.workflow_operations enable row level security;
alter table public.workflow_commands enable row level security;
alter table public.account_leases enable row level security;

create policy package_catalog_authenticated_read on public.package_catalog
  for select to authenticated using (active);
create policy entitlements_owner_read on public.entitlements
  for select to authenticated using (user_id = auth.uid());
create policy workflow_operations_owner_read on public.workflow_operations
  for select to authenticated using (user_id = auth.uid());
create policy workflow_commands_owner_read on public.workflow_commands
  for select to authenticated using (
    exists (
      select 1 from public.workflow_operations operation
      where operation.id = workflow_commands.operation_id
        and operation.user_id = auth.uid()
    )
  );

comment on table public.telegram_accounts is 'Session ciphertext is service-role only; never expose this table through client API.';
comment on table public.account_leases is 'Runtime lease and fencing state; service-role only.';
