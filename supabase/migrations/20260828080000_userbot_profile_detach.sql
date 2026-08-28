create or replace function public.detach_userbot_profile_account(p_user_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  profile_id_value uuid;
begin
  select id into profile_id_value from public.userbot_profiles
   where user_id = p_user_id for update;
  if not found then return false; end if;

  update public.userbot_profile_accounts
     set status = 'DETACHED', detached_at = now()
   where profile_id = profile_id_value and status = 'ATTACHED';

  update public.userbot_profiles
     set active_account_id = null, status = 'DISCONNECTED', updated_at = now()
   where id = profile_id_value;
  return true;
end;
$$;

revoke all on function public.detach_userbot_profile_account(uuid) from public;
