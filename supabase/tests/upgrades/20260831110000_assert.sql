-- Apply R3-001 after the legacy seed, then verify retention and secure cleanup.

select 1 / case when exists (
  select 1 from public.telegram_accounts
   where id = '32323232-3232-4232-8232-323232323232'
     and status = 'READY'
     and encrypted_session = decode('010203', 'hex')
     and encryption_key_version = 1
     and session_authenticated_at is not null
     and session_revoked_at is null
) then 1 else 0 end;

select 1 / case when exists (
  select 1 from public.telegram_accounts
   where id = '33333333-3333-4333-8333-333333333333'
     and status = 'REVOKED'
     and encrypted_session is null
     and encryption_key_version is null
     and session_revoked_at is not null
) then 1 else 0 end;

select 1 / case when exists (
  select 1 from public.userbot_profiles
   where user_id = '31313131-3131-4131-8131-313131313131'
     and active_account_id is null
     and status = 'NEEDS_REAUTH'
     and broadcast_interval_seconds = 43
) then 1 else 0 end;

select 1 / case when exists (
  select 1 from public.userbot_profile_accounts
   where account_id = '33333333-3333-4333-8333-333333333333'
     and status = 'DETACHED'
     and detached_at is not null
) then 1 else 0 end;

select 1 / case when to_regclass('public.telegram_account_auth_flows') is not null
then 1 else 0 end;

select 1 / case when to_regclass(
  'public.telegram_account_auth_flows_completed_account_idx'
) is not null then 1 else 0 end;
