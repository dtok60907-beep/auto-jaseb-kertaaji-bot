-- An account whose only pending work is Auto Komen must still be discovered
-- by the engine's runtime scheduler, gated the same way Jasa Sebar is: READY
-- account, an ACTIVE entitlement with AUTO_COMMENT_MF, and the account is the
-- user's currently connected/active userbot profile.

begin;
insert into public.app_users (id) values ('49494949-4949-4949-4949-494949494949');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '49494949-4949-4949-4949-494949494949',
  '{"packageId":"discovery-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49', '49494949-4949-4949-4949-494949494949', 'USERBOT', 'Discovery userbot', decode('00', 'hex'), 1, 'READY');
insert into public.userbot_profiles (user_id, active_account_id, status)
values ('49494949-4949-4949-4949-494949494949', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49', 'CONNECTED');
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb49', '49494949-4949-4949-4949-494949494949', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49', 'Discovery division', 'AUTO_SEND');
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, resolution_status)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49', '49494949-4949-4949-4949-494949494949', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49', '@menfess_discovery', 'QUEUED');

-- A QUEUED channel target alone (no division attached, no broadcast work at
-- all) makes the account discoverable.
select 1 / case when (
  select has_preparation_work and account_type = 'USERBOT'
    from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;

-- Deactivating the channel target removes the account from discovery.
update public.auto_comment_channel_targets set active = false where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49';
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;
update public.auto_comment_channel_targets set active = true where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49';

-- A READY channel target with a division attached and a due monitoring poll
-- is discovered too, even with no resolution work left.
update public.auto_comment_channel_targets
   set resolution_status = 'READY', discussion_target_ref = '@menfess_discovery_discussion',
       monitoring_available_at = now() - interval '1 second'
 where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49';
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb49', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49');
select 1 / case when exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;

-- A monitoring poll that is not due yet is not discovered (as of "now",
-- not the "ignore timing entirely" infinity boundary used above).
update public.auto_comment_channel_targets set monitoring_available_at = now() + interval '1 hour' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49';
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, now(), 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;
update public.auto_comment_channel_targets set monitoring_available_at = now() - interval '1 second' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee49';

-- Without an ACTIVE AUTO_COMMENT_MF entitlement, the account is not discovered
-- even though the poll is due.
update public.entitlements set status = 'REVOKED' where user_id = '49494949-4949-4949-4949-494949494949';
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;
update public.entitlements set status = 'ACTIVE' where user_id = '49494949-4949-4949-4949-494949494949';

-- Without the account being the user's currently connected/active userbot
-- profile, the account is not discovered.
update public.userbot_profiles set active_account_id = null where user_id = '49494949-4949-4949-4949-494949494949';
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa49'
) then 1 else 0 end;

rollback;
