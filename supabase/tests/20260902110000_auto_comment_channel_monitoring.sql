-- Monitoring poll claims are paced, scoped to READY targets with an attached
-- division, and the checkpoint never moves backwards.

begin;
insert into public.app_users (id) values ('39393939-3939-3939-3939-393939393939');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '39393939-3939-3939-3939-393939393939',
  '{"packageId":"monitoring-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '39393939-3939-3939-3939-393939393939', 'USERBOT', 'Monitoring userbot', decode('00', 'hex'), 1, 'READY');
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', '39393939-3939-3939-3939-393939393939', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', 'Monitoring division', 'AUTO_SEND');

select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 60)) then 1 else 0 end;

-- A READY target with no division attached is never claimed.
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', '39393939-3939-3939-3939-393939393939', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '@menfess_unattached', '@menfess_unattached_discussion', 'READY');
select 1 / case when not exists (select 1 from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)) then 1 else 0 end;

-- Attach a division: the target becomes claimable, monitoring_last_post_id starts null.
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39');
select 1 / case when (
  select monitoring_last_post_id is null and source_channel_ref = '@menfess_unattached'
    from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)
) then 1 else 0 end;

-- Claiming again immediately finds nothing: the poll interval paced it forward.
select 1 / case when not exists (select 1 from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)) then 1 else 0 end;

-- Seed the checkpoint (the first-poll "establish a baseline" step).
select 1 / case when public.advance_auto_comment_monitoring_checkpoint('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 100) then 1 else 0 end;
select 1 / case when (select monitoring_last_post_id = 100 from public.auto_comment_channel_targets where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39') then 1 else 0 end;

-- The checkpoint never moves backwards even if an out-of-order id is reported.
select 1 / case when public.advance_auto_comment_monitoring_checkpoint('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 50) then 1 else 0 end;
select 1 / case when (select monitoring_last_post_id = 100 from public.auto_comment_channel_targets where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39') then 1 else 0 end;
select 1 / case when public.advance_auto_comment_monitoring_checkpoint('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 150) then 1 else 0 end;
select 1 / case when (select monitoring_last_post_id = 150 from public.auto_comment_channel_targets where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39') then 1 else 0 end;

-- A stale or wrong fencing token cannot advance the checkpoint.
select 1 / case when not public.advance_auto_comment_monitoring_checkpoint('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 2, 200) then 1 else 0 end;
select 1 / case when (select monitoring_last_post_id = 150 from public.auto_comment_channel_targets where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39') then 1 else 0 end;

-- A deactivated target, or one no longer READY, is never claimed.
update public.auto_comment_channel_targets set monitoring_available_at = now() - interval '1 second' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39';
update public.auto_comment_channel_targets set active = false where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39';
select 1 / case when not exists (select 1 from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)) then 1 else 0 end;
update public.auto_comment_channel_targets set active = true, resolution_status = 'WAITING_APPROVAL' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39';
select 1 / case when not exists (select 1 from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)) then 1 else 0 end;
update public.auto_comment_channel_targets set resolution_status = 'READY' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39';
select 1 / case when exists (select 1 from public.claim_next_auto_comment_monitoring('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '99999999-9999-9999-9999-999999999939', 1, 30)) then 1 else 0 end;

rollback;
