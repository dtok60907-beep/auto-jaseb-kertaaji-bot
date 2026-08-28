-- A user-owned profile keeps Userbot settings and subscription independent from a
-- connected Telegram account. account_id remains the current execution account for
-- backward-compatible workers; switching updates it atomically.

create table public.userbot_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  active_account_id uuid references public.telegram_accounts(id) on delete set null,
  status text not null default 'DISCONNECTED'
    check (status in ('CONNECTED', 'DISCONNECTED', 'NEEDS_REAUTH')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.userbot_profile_accounts (
  profile_id uuid not null references public.userbot_profiles(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  status text not null check (status in ('ATTACHED', 'DETACHED')),
  attached_at timestamptz not null default now(),
  detached_at timestamptz,
  primary key (profile_id, account_id),
  check ((status = 'DETACHED') = (detached_at is not null))
);

create unique index userbot_profile_one_attached_account_idx
  on public.userbot_profile_accounts (profile_id) where status = 'ATTACHED';
create unique index userbot_account_one_attached_profile_idx
  on public.userbot_profile_accounts (account_id) where status = 'ATTACHED';

insert into public.userbot_profiles (user_id, active_account_id, status)
select owner_user_id, (array_agg(id order by id))[1], 'CONNECTED'
  from public.telegram_accounts
 where account_type = 'USERBOT'
 group by owner_user_id
on conflict (user_id) do nothing;

insert into public.userbot_profile_accounts (profile_id, account_id, status)
select profile.id, profile.active_account_id, 'ATTACHED'
  from public.userbot_profiles profile
 where profile.active_account_id is not null
on conflict do nothing;

alter table public.auto_comment_divisions
  add column profile_id uuid references public.userbot_profiles(id) on delete restrict;
alter table public.auto_comment_channel_targets
  add column profile_id uuid references public.userbot_profiles(id) on delete restrict;

update public.auto_comment_divisions division
   set profile_id = profile.id
  from public.userbot_profiles profile
 where profile.user_id = division.user_id;

update public.auto_comment_channel_targets target
   set profile_id = profile.id
  from public.userbot_profiles profile
 where profile.user_id = target.user_id;

alter table public.auto_comment_divisions alter column profile_id set not null;
alter table public.auto_comment_channel_targets alter column profile_id set not null;

create or replace function public.assign_userbot_profile()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  profile_id_value uuid;
begin
  select id into profile_id_value from public.userbot_profiles where user_id = new.user_id;
  if not found then
    insert into public.userbot_profiles (user_id, active_account_id, status)
    values (new.user_id, new.account_id, 'CONNECTED') returning id into profile_id_value;
    insert into public.userbot_profile_accounts (profile_id, account_id, status)
    values (profile_id_value, new.account_id, 'ATTACHED') on conflict do nothing;
  end if;
  new.profile_id := profile_id_value;
  return new;
end;
$$;

create trigger auto_comment_divisions_assign_profile
before insert or update of user_id, account_id on public.auto_comment_divisions
for each row execute function public.assign_userbot_profile();
create trigger auto_comment_channel_targets_assign_profile
before insert or update of user_id, account_id on public.auto_comment_channel_targets
for each row execute function public.assign_userbot_profile();

drop index public.auto_comment_divisions_user_account_name_unique_idx;
drop index public.auto_comment_divisions_account_active_idx;
drop index public.auto_comment_channel_targets_account_channel_unique_idx;
drop index public.auto_comment_channel_targets_account_active_idx;

create unique index auto_comment_divisions_profile_name_unique_idx
  on public.auto_comment_divisions (profile_id, lower(btrim(name)));
create index auto_comment_divisions_profile_active_idx
  on public.auto_comment_divisions (profile_id, created_at desc) where active;
create unique index auto_comment_channel_targets_profile_channel_unique_idx
  on public.auto_comment_channel_targets (profile_id, lower(btrim(source_channel_ref)));
create index auto_comment_channel_targets_profile_active_idx
  on public.auto_comment_channel_targets (profile_id, created_at desc) where active;

alter table public.auto_comment_channel_targets
  drop constraint auto_comment_channel_targets_resolution_status_check,
  add constraint auto_comment_channel_targets_resolution_status_check
    check (resolution_status in ('QUEUED', 'CHECKING', 'READY', 'NEEDS_REVALIDATION', 'FAILED_FINAL'));

create or replace function public.switch_userbot_profile_account(
  p_user_id uuid,
  p_account_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  profile_row public.userbot_profiles%rowtype;
begin
  select * into profile_row from public.userbot_profiles
   where user_id = p_user_id for update;
  if not found then
    insert into public.userbot_profiles (user_id) values (p_user_id)
    returning * into profile_row;
  end if;

  if not exists (
    select 1 from public.telegram_accounts
     where id = p_account_id and owner_user_id = p_user_id
       and account_type = 'USERBOT' and status = 'READY'
  ) then
    raise exception using errcode = '42501', message = 'userbot account is not ready for this user';
  end if;

  update public.userbot_profile_accounts
     set status = 'DETACHED', detached_at = now()
   where profile_id = profile_row.id and status = 'ATTACHED';

  insert into public.userbot_profile_accounts (profile_id, account_id, status, attached_at, detached_at)
  values (profile_row.id, p_account_id, 'ATTACHED', now(), null)
  on conflict (profile_id, account_id)
  do update set status = 'ATTACHED', attached_at = now(), detached_at = null;

  update public.userbot_profiles
     set active_account_id = p_account_id, status = 'CONNECTED', updated_at = now()
   where id = profile_row.id;

  update public.auto_comment_divisions set account_id = p_account_id
   where profile_id = profile_row.id;
  update public.auto_comment_channel_targets
     set account_id = p_account_id, discussion_target_ref = null,
         resolution_status = 'NEEDS_REVALIDATION', last_error_code = null,
         updated_at = now()
   where profile_id = profile_row.id;

  return profile_row.id;
end;
$$;

create trigger userbot_profiles_set_updated_at before update on public.userbot_profiles
for each row execute function public.set_updated_at();

alter table public.userbot_profiles enable row level security;
alter table public.userbot_profile_accounts enable row level security;
create policy userbot_profiles_owner_read on public.userbot_profiles
for select using (user_id = auth.uid());
create policy userbot_profile_accounts_owner_read on public.userbot_profile_accounts
for select using (exists (select 1 from public.userbot_profiles profile where profile.id = userbot_profile_accounts.profile_id and profile.user_id = auth.uid()));

revoke all on function public.switch_userbot_profile_account(uuid, uuid) from public;
