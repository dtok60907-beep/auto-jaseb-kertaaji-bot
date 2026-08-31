-- R3-003: account switching/detach must fence the runtime immediately while
-- retaining the user-owned profile, subscription, settings, and saved sessions.

create or replace function public.switch_userbot_profile_account(
  p_user_id uuid,
  p_account_id uuid
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  account_row public.telegram_accounts%rowtype;
  profile_row public.userbot_profiles%rowtype;
  previous_account_id uuid;
begin
  select * into account_row
    from public.telegram_accounts
   where id = p_account_id
     and owner_user_id = p_user_id
     and account_type = 'USERBOT'
   for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'USERBOT_ACCOUNT_NOT_FOUND';
  end if;
  if account_row.status <> 'READY' or account_row.encrypted_session is null then
    raise exception using errcode = '55000', message = 'USERBOT_ACCOUNT_NOT_READY';
  end if;

  select * into profile_row
    from public.userbot_profiles
   where user_id = p_user_id
   for update;
  if not found then
    insert into public.userbot_profiles (user_id)
    values (p_user_id)
    returning * into profile_row;
  end if;

  if profile_row.active_account_id = p_account_id
     and profile_row.status = 'CONNECTED' then
    return profile_row.id;
  end if;
  previous_account_id := profile_row.active_account_id;

  update public.userbot_profile_accounts
     set status = 'DETACHED', detached_at = now()
   where profile_id = profile_row.id and status = 'ATTACHED';

  insert into public.userbot_profile_accounts (
    profile_id, account_id, status, attached_at, detached_at
  ) values (
    profile_row.id, p_account_id, 'ATTACHED', now(), null
  )
  on conflict (profile_id, account_id)
  do update set status = 'ATTACHED', attached_at = now(), detached_at = null;

  update public.userbot_profiles
     set active_account_id = p_account_id,
         status = 'CONNECTED',
         updated_at = now()
   where id = profile_row.id;

  -- Settings belong to the profile. Only their execution account changes.
  update public.auto_comment_divisions
     set account_id = p_account_id
   where profile_id = profile_row.id;
  update public.auto_comment_channel_targets
     set account_id = p_account_id,
         discussion_target_ref = null,
         resolution_status = 'NEEDS_REVALIDATION',
         last_error_code = null,
         updated_at = now()
   where profile_id = profile_row.id;

  -- Expire rather than delete so the next runtime acquisition increments its
  -- fencing token and cannot suffer an ABA token collision with a stale runner.
  update public.account_leases
     set lease_until = now(), updated_at = now()
   where account_id in (previous_account_id, p_account_id)
     and lease_until > now();

  return profile_row.id;
end;
$$;

create or replace function public.detach_userbot_profile_account(p_user_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  profile_row public.userbot_profiles%rowtype;
begin
  select * into profile_row
    from public.userbot_profiles
   where user_id = p_user_id
   for update;
  if not found then return false; end if;

  update public.userbot_profile_accounts
     set status = 'DETACHED', detached_at = now()
   where profile_id = profile_row.id and status = 'ATTACHED';

  update public.userbot_profiles
     set active_account_id = null,
         status = 'DISCONNECTED',
         updated_at = now()
   where id = profile_row.id;

  update public.account_leases
     set lease_until = now(), updated_at = now()
   where account_id = profile_row.active_account_id
     and lease_until > now();

  return true;
end;
$$;

revoke all on function public.switch_userbot_profile_account(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.detach_userbot_profile_account(uuid)
  from public, anon, authenticated;
grant execute on function public.switch_userbot_profile_account(uuid, uuid)
  to service_role;
grant execute on function public.detach_userbot_profile_account(uuid)
  to service_role;

comment on function public.switch_userbot_profile_account(uuid, uuid)
  is 'Atomically switches a user-owned READY account, rebinds profile settings, and fences old runtime ownership.';
comment on function public.detach_userbot_profile_account(uuid)
  is 'Idempotently disconnects execution and expires its runtime lease while retaining session, settings, and subscription.';
