-- Apply every migration before R3-001, then seed legacy retained/revoked sessions.

insert into public.app_users (
  id, telegram_user_id, first_name, last_authenticated_at
) values (
  '31313131-3131-4131-8131-313131313131', 900001103,
  'Upgrade Owner', '2026-08-31 10:00:00+00'
);

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, provider_user_id,
  encrypted_session, encryption_key_version, status
) values
  (
    '32323232-3232-4232-8232-323232323232',
    '31313131-3131-4131-8131-313131313131', 'USERBOT', 'Retained session',
    900001104, decode('010203', 'hex'), 1, 'READY'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    '31313131-3131-4131-8131-313131313131', 'USERBOT', 'Legacy revoked session',
    900001105, decode('040506', 'hex'), 1, 'REVOKED'
  );

insert into public.userbot_profiles (
  user_id, active_account_id, status, broadcast_interval_seconds
) values (
  '31313131-3131-4131-8131-313131313131',
  '33333333-3333-4333-8333-333333333333', 'CONNECTED', 43
);

insert into public.userbot_profile_accounts (profile_id, account_id, status)
select id, '33333333-3333-4333-8333-333333333333', 'ATTACHED'
  from public.userbot_profiles
 where user_id = '31313131-3131-4131-8131-313131313131';
