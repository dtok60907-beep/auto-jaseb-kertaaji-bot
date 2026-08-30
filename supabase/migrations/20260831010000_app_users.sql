-- Canonical application identity for Telegram Mini App users.
-- Business ownership is backend-authenticated and intentionally independent of
-- Supabase email/phone authentication and Telegram runtime sessions.

create table public.app_users (
  id uuid primary key default extensions.gen_random_uuid(),
  telegram_user_id bigint unique,
  first_name text,
  last_name text,
  username text,
  language_code text,
  is_premium boolean not null default false,
  allows_write_to_pm boolean not null default false,
  last_authenticated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_users_telegram_user_id_check check (
    telegram_user_id is null
    or telegram_user_id between 1 and 4503599627370495
  ),
  constraint app_users_identity_completeness_check check (
    (telegram_user_id is null and first_name is null and last_authenticated_at is null)
    or
    (telegram_user_id is not null and first_name is not null and last_authenticated_at is not null)
  ),
  constraint app_users_first_name_check check (
    first_name is null
    or (
      char_length(btrim(first_name)) between 1 and 256
      and position(E'\n' in first_name) = 0
      and position(E'\r' in first_name) = 0
    )
  ),
  constraint app_users_last_name_check check (
    last_name is null
    or (
      char_length(btrim(last_name)) between 1 and 256
      and position(E'\n' in last_name) = 0
      and position(E'\r' in last_name) = 0
    )
  ),
  constraint app_users_username_check check (
    username is null
    or (
      char_length(btrim(username)) between 1 and 64
      and position(E'\n' in username) = 0
      and position(E'\r' in username) = 0
    )
  ),
  constraint app_users_language_code_check check (
    language_code is null
    or (
      char_length(btrim(language_code)) between 1 and 35
      and position(E'\n' in language_code) = 0
      and position(E'\r' in language_code) = 0
    )
  )
);

create trigger app_users_set_updated_at
before update on public.app_users
for each row execute function public.set_updated_at();

-- Preserve every UUID already referenced by business data. Legacy rows remain
-- unlinked until an explicit operator reconciliation; no setting is deleted.
with legacy_user_ids(id) as (
  select created_by from public.package_catalog where created_by is not null
  union select user_id from public.entitlements
  union select owner_user_id from public.telegram_accounts where owner_user_id is not null
  union select user_id from public.workflow_operations
  union select user_id from public.worker_assignments
  union select user_id from public.comment_rules
  union select created_by from public.package_versions where created_by is not null
  union select user_id from public.broadcast_materials
  union select user_id from public.broadcast_lpm_targets
  union select user_id from public.auto_comment_divisions
  union select user_id from public.auto_comment_channel_targets
  union select decided_by_user_id from public.auto_comment_reviews
  union select user_id from public.userbot_profiles
)
insert into public.app_users (id)
select id from legacy_user_ids
on conflict (id) do nothing;

alter table public.package_catalog
  drop constraint package_catalog_created_by_fkey,
  add constraint package_catalog_created_by_fkey
    foreign key (created_by) references public.app_users(id) on delete set null;
alter table public.entitlements
  drop constraint entitlements_user_id_fkey,
  add constraint entitlements_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.telegram_accounts
  drop constraint telegram_accounts_owner_user_id_fkey,
  add constraint telegram_accounts_owner_user_id_fkey
    foreign key (owner_user_id) references public.app_users(id) on delete cascade;
alter table public.workflow_operations
  drop constraint workflow_operations_user_id_fkey,
  add constraint workflow_operations_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.worker_assignments
  drop constraint worker_assignments_user_id_fkey,
  add constraint worker_assignments_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.comment_rules
  drop constraint comment_rules_user_id_fkey,
  add constraint comment_rules_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.package_versions
  drop constraint package_versions_created_by_fkey,
  add constraint package_versions_created_by_fkey
    foreign key (created_by) references public.app_users(id) on delete set null;
alter table public.broadcast_materials
  drop constraint broadcast_materials_user_id_fkey,
  add constraint broadcast_materials_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.broadcast_lpm_targets
  drop constraint broadcast_lpm_targets_user_id_fkey,
  add constraint broadcast_lpm_targets_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.auto_comment_divisions
  drop constraint auto_comment_divisions_user_id_fkey,
  add constraint auto_comment_divisions_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.auto_comment_channel_targets
  drop constraint auto_comment_channel_targets_user_id_fkey,
  add constraint auto_comment_channel_targets_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;
alter table public.auto_comment_reviews
  drop constraint auto_comment_reviews_decided_by_user_id_fkey,
  add constraint auto_comment_reviews_decided_by_user_id_fkey
    foreign key (decided_by_user_id) references public.app_users(id) on delete restrict;
alter table public.userbot_profiles
  drop constraint userbot_profiles_user_id_fkey,
  add constraint userbot_profiles_user_id_fkey
    foreign key (user_id) references public.app_users(id) on delete cascade;

create function public.upsert_telegram_mini_app_user(
  p_telegram_user_id bigint,
  p_first_name text,
  p_last_name text default null,
  p_username text default null,
  p_language_code text default null,
  p_is_premium boolean default false,
  p_allows_write_to_pm boolean default false,
  p_authenticated_at timestamptz default now()
)
returns uuid
language sql
set search_path = public
as $$
  insert into public.app_users (
    telegram_user_id,
    first_name,
    last_name,
    username,
    language_code,
    is_premium,
    allows_write_to_pm,
    last_authenticated_at
  )
  values (
    p_telegram_user_id,
    p_first_name,
    p_last_name,
    p_username,
    p_language_code,
    p_is_premium,
    p_allows_write_to_pm,
    p_authenticated_at
  )
  on conflict (telegram_user_id) do update
     set first_name = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.first_name else app_users.first_name end,
         last_name = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.last_name else app_users.last_name end,
         username = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.username else app_users.username end,
         language_code = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.language_code else app_users.language_code end,
         is_premium = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.is_premium else app_users.is_premium end,
         allows_write_to_pm = case
           when excluded.last_authenticated_at >= app_users.last_authenticated_at
           then excluded.allows_write_to_pm else app_users.allows_write_to_pm end,
         last_authenticated_at = greatest(
           app_users.last_authenticated_at,
           excluded.last_authenticated_at
         )
  returning id;
$$;

alter table public.app_users enable row level security;
revoke all on table public.app_users from public, anon, authenticated;
revoke all on function public.upsert_telegram_mini_app_user(
  bigint, text, text, text, text, boolean, boolean, timestamptz
) from public, anon, authenticated;
grant select, insert, update on table public.app_users to service_role;
grant execute on function public.upsert_telegram_mini_app_user(
  bigint, text, text, text, text, boolean, boolean, timestamptz
) to service_role;

comment on table public.app_users
  is 'Canonical backend-owned Mini App users; independent from Telegram runtime sessions and Supabase email/phone auth.';
comment on column public.app_users.telegram_user_id
  is 'Stable Telegram Mini App user id after initData verification; null only for migration-preserved legacy UUIDs.';
comment on function public.upsert_telegram_mini_app_user(
  bigint, text, text, text, text, boolean, boolean, timestamptz
)
  is 'Atomically resolves one verified Telegram Mini App identity to one stable application UUID.';
