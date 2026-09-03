-- Both a natural expiry and an admin "Cabut akses" revoke must produce the
-- same visible outcome for the affected user: entitlement flips to its
-- terminal status, the connected userbot profile disconnects, and any
-- still-queued Jasa Sebar work gets cancelled with a distinct error code so
-- the two lapse causes stay tellable apart in history.

begin;

insert into public.app_users (id) values ('60606060-6060-6060-6060-606060606060');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('61616161-6161-6161-6161-616161616161', '60606060-6060-6060-6060-606060606060', 'USERBOT', 'Lapse test userbot', decode('00', 'hex'), 1, 'READY');
insert into public.userbot_profiles (id, user_id, active_account_id, status)
values ('62626262-6262-6262-6262-626262626262', '60606060-6060-6060-6060-606060606060', '61616161-6161-6161-6161-616161616161', 'CONNECTED');
insert into public.entitlements (id, user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '63636363-6363-6363-6363-636363636363', '60606060-6060-6060-6060-606060606060',
  '{"packageId":"lapse-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 1
);
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload)
values ('64646464-6464-6464-6464-646464646464', '60606060-6060-6060-6060-606060606060', '61616161-6161-6161-6161-616161616161', 'BROADCAST', 'QUEUED', 'lapse-test-op-1', '{"accountMode":"USERBOT"}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number)
values ('66666666-6666-6666-6666-666666666666', '64646464-6464-6464-6464-646464646464', '@grup_lapse_test', 0, 1);
insert into public.workflow_commands (id, operation_id, account_id, kind, target_id, idempotency_key, status, payload, broadcast_target_id)
values ('65656565-6565-6565-6565-656565656565', '64646464-6464-6464-6464-646464646464', '61616161-6161-6161-6161-616161616161', 'SEND_TEXT', '@grup_lapse_test', 'lapse-test-cmd-1', 'PENDING', '{"text":"halo"}', '66666666-6666-6666-6666-666666666666');

-- Expiry: pretend "now" is past the entitlement's expires_at.
select 1 / case when public.expire_due_entitlements(now() + interval '2 days') = 1 then 1 else 0 end;
select 1 / case when (select status = 'EXPIRED' from public.entitlements where id = '63636363-6363-6363-6363-636363636363') then 1 else 0 end;
select 1 / case when (select status = 'DISCONNECTED' from public.userbot_profiles where id = '62626262-6262-6262-6262-626262626262') then 1 else 0 end;
select 1 / case when (select delivery_status = 'CANCELLED' and last_error_code = 'SUBSCRIPTION_EXPIRED' from public.broadcast_targets where id = '66666666-6666-6666-6666-666666666666') then 1 else 0 end;
select 1 / case when (select status = 'CANCELLED' and last_error_code = 'SUBSCRIPTION_EXPIRED' from public.workflow_commands where id = '65656565-6565-6565-6565-656565656565') then 1 else 0 end;
select 1 / case when (select status = 'CANCELLED' and error_code = 'SUBSCRIPTION_EXPIRED' from public.workflow_operations where id = '64646464-6464-6464-6464-646464646464') then 1 else 0 end;

-- A second call finds nothing new due; the already-EXPIRED row isn't touched again.
select 1 / case when public.expire_due_entitlements(now() + interval '2 days') = 0 then 1 else 0 end;

rollback;

-- Same cascade, but via the admin-initiated revoke path instead of expiry,
-- with a distinct error code so the two causes stay distinguishable.
begin;

insert into public.app_users (id) values ('70707070-7070-7070-7070-707070707070');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('71717171-7171-7171-7171-717171717171', '70707070-7070-7070-7070-707070707070', 'USERBOT', 'Revoke test userbot', decode('00', 'hex'), 1, 'READY');
insert into public.userbot_profiles (id, user_id, active_account_id, status)
values ('72727272-7272-7272-7272-727272727272', '70707070-7070-7070-7070-707070707070', '71717171-7171-7171-7171-717171717171', 'CONNECTED');
insert into public.entitlements (id, user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '73737373-7373-7373-7373-737373737373', '70707070-7070-7070-7070-707070707070',
  '{"packageId":"revoke-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '30 days', 1, 1
);
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload)
values ('74747474-7474-7474-7474-747474747474', '70707070-7070-7070-7070-707070707070', '71717171-7171-7171-7171-717171717171', 'BROADCAST', 'QUEUED', 'revoke-test-op-1', '{"accountMode":"USERBOT"}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number)
values ('76767676-7676-7676-7676-767676767676', '74747474-7474-7474-7474-747474747474', '@grup_revoke_test', 0, 1);
insert into public.workflow_commands (id, operation_id, account_id, kind, target_id, idempotency_key, status, payload, broadcast_target_id)
values ('75757575-7575-7575-7575-757575757575', '74747474-7474-7474-7474-747474747474', '71717171-7171-7171-7171-717171717171', 'SEND_TEXT', '@grup_revoke_test', 'revoke-test-cmd-1', 'PENDING', '{"text":"halo"}', '76767676-7676-7676-7676-767676767676');

select 1 / case when public.revoke_entitlement('73737373-7373-7373-7373-737373737373') = true then 1 else 0 end;
select 1 / case when (select status = 'REVOKED' from public.entitlements where id = '73737373-7373-7373-7373-737373737373') then 1 else 0 end;
select 1 / case when (select status = 'DISCONNECTED' from public.userbot_profiles where id = '72727272-7272-7272-7272-727272727272') then 1 else 0 end;
select 1 / case when (select delivery_status = 'CANCELLED' and last_error_code = 'SUBSCRIPTION_REVOKED' from public.broadcast_targets where id = '76767676-7676-7676-7676-767676767676') then 1 else 0 end;
select 1 / case when (select status = 'CANCELLED' and last_error_code = 'SUBSCRIPTION_REVOKED' from public.workflow_commands where id = '75757575-7575-7575-7575-757575757575') then 1 else 0 end;
select 1 / case when (select status = 'CANCELLED' and error_code = 'SUBSCRIPTION_REVOKED' from public.workflow_operations where id = '74747474-7474-7474-7474-747474747474') then 1 else 0 end;

-- Revoking an already-non-ACTIVE entitlement is a no-op that reports false.
select 1 / case when public.revoke_entitlement('73737373-7373-7373-7373-737373737373') = false then 1 else 0 end;

rollback;
