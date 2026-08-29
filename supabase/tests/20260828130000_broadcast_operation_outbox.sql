-- Run after migrations V1 through V14. Covers Userbot and worker broadcast admission.

begin;

insert into auth.users (id) values
  ('13131313-1313-1313-1313-131313131313'),
  ('14141414-1414-1414-1414-141414141414');

insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values
  ('13131313-1313-1313-1313-131313131313', '{"packageId":"userbot","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}', 'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 10),
  ('14141414-1414-1414-1414-141414141414', '{"packageId":"worker","packageType":"JASEB_WORKER","features":["JASEB"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}', 'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 10);

insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccc31', '13131313-1313-1313-1313-131313131313', 'USERBOT', 'Userbot broadcast', decode('00', 'hex'), 1, 'READY'),
  ('cccccccc-cccc-cccc-cccc-cccccccccc32', null, 'JASEB_WORKER', 'Worker broadcast', decode('00', 'hex'), 1, 'READY');

insert into public.userbot_profiles (user_id, active_account_id, status, broadcast_interval_seconds)
values ('13131313-1313-1313-1313-131313131313', 'cccccccc-cccc-cccc-cccc-cccccccccc31', 'CONNECTED', 45);
insert into public.worker_account_settings (worker_account_id, interval_seconds, active)
values ('cccccccc-cccc-cccc-cccc-cccccccccc32', 0, true);

insert into public.broadcast_materials (id, user_id, kind, text_content)
values ('dddddddd-dddd-dddd-dddd-dddddddddd31', '13131313-1313-1313-1313-131313131313', 'TEXT', 'Promo Userbot');
insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee31', '13131313-1313-1313-1313-131313131313', '@lpm_satu');

select 1 / case when (select result_status = 'CREATED' from public.create_broadcast_operation(
  '13131313-1313-1313-1313-131313131313', 'USERBOT', 'dddddddd-dddd-dddd-dddd-dddddddddd31',
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeee31'::uuid], 'userbot-request-0001'
)) then 1 else 0 end;
select 1 / case when (
  select operation.payload->>'intervalSeconds' = '45' and command.kind = 'SEND_TEXT'
    from public.workflow_operations operation
    join public.workflow_commands command on command.operation_id = operation.id
   where operation.idempotency_key = 'userbot-request-0001'
) then 1 else 0 end;
select 1 / case when (select result_status = 'IDEMPOTENT' from public.create_broadcast_operation(
  '13131313-1313-1313-1313-131313131313', 'USERBOT', 'dddddddd-dddd-dddd-dddd-dddddddddd31',
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeee31'::uuid], 'userbot-request-0001'
)) then 1 else 0 end;

insert into public.broadcast_materials (id, user_id, kind, forward_channel_username, forward_message_id, source_attribution)
values ('dddddddd-dddd-dddd-dddd-dddddddddd32', '14141414-1414-1414-1414-141414141414', 'FORWARD', 'VadeMecums', 204, 'SHOW_SOURCE');
insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee32', '14141414-1414-1414-1414-141414141414', '@lpm_dua');

select 1 / case when (select result_status = 'CREATED' from public.create_broadcast_operation(
  '14141414-1414-1414-1414-141414141414', 'JASEB_WORKER', 'dddddddd-dddd-dddd-dddd-dddddddddd32',
  array['eeeeeeee-eeee-eeee-eeee-eeeeeeeeee32'::uuid], 'worker-request-0001'
)) then 1 else 0 end;
select 1 / case when (
  select command.kind = 'FORWARD_MESSAGE'
     and command.payload->'material'->'source'->>'messageId' = '204'
     and target.interval_seconds = 0
     and exists (select 1 from public.worker_assignments assignment where assignment.operation_id = operation.id and assignment.status = 'RESERVED')
    from public.workflow_operations operation
    join public.workflow_commands command on command.operation_id = operation.id
    join public.broadcast_targets target on target.operation_id = operation.id
   where operation.idempotency_key = 'worker-request-0001'
) then 1 else 0 end;

rollback;
