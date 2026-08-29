-- Run after migrations V1 through V13. A Jasa Sebar profile interval persists across account switches.

begin;

insert into auth.users (id) values ('12121212-1212-1212-1212-121212121212');

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status
)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbba1', '12121212-1212-1212-1212-121212121212', 'USERBOT', 'Userbot pertama', decode('00', 'hex'), 1, 'READY'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbba2', '12121212-1212-1212-1212-121212121212', 'USERBOT', 'Userbot kedua', decode('00', 'hex'), 1, 'READY');

insert into public.userbot_profiles (user_id, broadcast_interval_seconds)
values ('12121212-1212-1212-1212-121212121212', 0);

select public.switch_userbot_profile_account(
  '12121212-1212-1212-1212-121212121212',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbba1'
);

update public.userbot_profiles
   set broadcast_interval_seconds = 90
 where user_id = '12121212-1212-1212-1212-121212121212';

select public.switch_userbot_profile_account(
  '12121212-1212-1212-1212-121212121212',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbba2'
);

select 1 / case when (
  select broadcast_interval_seconds = 90
     and active_account_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbba2'::uuid
    from public.userbot_profiles
   where user_id = '12121212-1212-1212-1212-121212121212'
) then 1 else 0 end;

rollback;
