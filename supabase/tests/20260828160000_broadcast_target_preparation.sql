-- Run after migrations V1 through V17. A broadcast command cannot be claimed before LPM preparation is READY.

begin;
insert into auth.users (id) values ('17171717-1717-1717-1717-171717171717');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', null, 'JASEB_WORKER', 'Preparation worker', decode('00', 'hex'), 1, 'READY');
insert into public.workflow_operations (id, user_id, account_id, operation_type, idempotency_key, payload)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb71', '17171717-1717-1717-1717-171717171717', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'BROADCAST', 'prepare-operation-0001', '{"material":{"kind":"TEXT","text":"promo"}}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number)
values ('cccccccc-cccc-cccc-cccc-cccccccccc71', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb71', '@lpm_prepare', 0, 1);
insert into public.workflow_commands (operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb71', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'SEND_TEXT', '@lpm_prepare', 'prepare-command-0001', '{"material":{"kind":"TEXT","text":"promo"}}', 'cccccccc-cccc-cccc-cccc-cccccccccc71');
select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 60)) then 1 else 0 end;

select 1 / case when not exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 1, 60)) then 1 else 0 end;
select 1 / case when (select telegram_target_ref = '@lpm_prepare' from public.claim_next_broadcast_preparation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 1)) then 1 else 0 end;
select 1 / case when public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc71', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 1, 'CHECKING', 'JOINING') then 1 else 0 end;
select 1 / case when public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc71', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 1, 'JOINING', 'READY') then 1 else 0 end;
select 1 / case when exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa71', 'dddddddd-dddd-dddd-dddd-dddddddddd71', 1, 60)) then 1 else 0 end;
select 1 / case when (select status = 'READY' from public.workflow_operations where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb71') then 1 else 0 end;

rollback;
