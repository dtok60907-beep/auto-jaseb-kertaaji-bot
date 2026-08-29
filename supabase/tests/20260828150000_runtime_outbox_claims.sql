-- Run after migrations V1 through V16. Verifies serial command claims and stale-runtime fencing.

begin;

insert into auth.users (id) values ('16161616-1616-1616-1616-161616161616');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', null, 'JASEB_WORKER', 'Outbox worker', decode('00', 'hex'), 1, 'READY');
insert into public.workflow_operations (id, user_id, account_id, operation_type, idempotency_key, payload)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb61', '16161616-1616-1616-1616-161616161616', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'BROADCAST', 'outbox-operation-0001', '{"material":{"kind":"TEXT","text":"promo"}}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number)
values
  ('cccccccc-cccc-cccc-cccc-cccccccccc61', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb61', '@lpm_satu', 0, 1),
  ('cccccccc-cccc-cccc-cccc-cccccccccc62', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb61', '@lpm_dua', 0, 2);
insert into public.workflow_commands (operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb61', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'SEND_TEXT', '@lpm_satu', 'outbox-command-0001', '{"material":{"kind":"TEXT","text":"promo"}}', 'cccccccc-cccc-cccc-cccc-cccccccccc61'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb61', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'SEND_TEXT', '@lpm_dua', 'outbox-command-0002', '{"material":{"kind":"TEXT","text":"promo"}}', 'cccccccc-cccc-cccc-cccc-cccccccccc62');

select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'dddddddd-dddd-dddd-dddd-dddddddddd61', 60
)) then 1 else 0 end;
select 1 / case when (select target.sequence_number = 1 from public.claim_next_workflow_command(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'dddddddd-dddd-dddd-dddd-dddddddddd61', 1, 60
) claimed join public.workflow_commands command on command.id = claimed.command_id join public.broadcast_targets target on target.id = command.broadcast_target_id) then 1 else 0 end;
select 1 / case when public.finish_claimed_workflow_command(
  (select id from public.workflow_commands where broadcast_target_id = 'cccccccc-cccc-cccc-cccc-cccccccccc61'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'dddddddd-dddd-dddd-dddd-dddddddddd61', 1, 'SUCCEEDED'
) then 1 else 0 end;
select 1 / case when (select target.sequence_number = 2 from public.claim_next_workflow_command(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'dddddddd-dddd-dddd-dddd-dddddddddd61', 1, 60
) claimed join public.workflow_commands command on command.id = claimed.command_id join public.broadcast_targets target on target.id = command.broadcast_target_id) then 1 else 0 end;

update public.account_leases set lease_until = now() - interval '1 second'
 where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61';
select 1 / case when (select result_status = 'TAKEN_OVER' and fencing_token = 2 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee61', 60
)) then 1 else 0 end;
select 1 / case when not public.finish_claimed_workflow_command(
  (select id from public.workflow_commands where broadcast_target_id = 'cccccccc-cccc-cccc-cccc-cccccccccc62'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'dddddddd-dddd-dddd-dddd-dddddddddd61', 1, 'SUCCEEDED'
) then 1 else 0 end;
select 1 / case when not exists (select 1 from public.claim_next_workflow_command(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa61', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee61', 2, 60
)) then 1 else 0 end;
select 1 / case when (select status = 'SIDE_EFFECT_UNCERTAIN' and last_error_code = 'ACCOUNT_LEASE_FENCED'
  from public.workflow_commands where broadcast_target_id = 'cccccccc-cccc-cccc-cccc-cccccccccc62'
) then 1 else 0 end;

rollback;
