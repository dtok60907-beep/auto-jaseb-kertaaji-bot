-- Approval-required Grup LPM remains non-terminal and cannot release its send command.

begin;
insert into auth.users (id) values ('18181818-1818-1818-1818-181818181818');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', null, 'JASEB_WORKER', 'Approval worker', decode('00', 'hex'), 1, 'READY');
insert into public.workflow_operations (id, user_id, account_id, operation_type, idempotency_key, payload)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb81', '18181818-1818-1818-1818-181818181818', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'BROADCAST', 'approval-operation-0001', '{}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number)
values ('cccccccc-cccc-cccc-cccc-cccccccccc81', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb81', '@lpm_approval', 0, 1);
insert into public.workflow_commands (operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb81', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'SEND_TEXT', '@lpm_approval', 'approval-command-0001', '{}', 'cccccccc-cccc-cccc-cccc-cccccccccc81');
select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 60)) then 1 else 0 end;

select 1 / case when (select previous_status = 'QUEUED' from public.claim_next_broadcast_preparation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1)) then 1 else 0 end;
select 1 / case when public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc81', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1, 'CHECKING', 'JOINING') then 1 else 0 end;
select 1 / case when public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc81', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1, 'JOINING', 'WAITING_APPROVAL', 'JOIN_APPROVAL_PENDING', 30) then 1 else 0 end;
select 1 / case when (select status = 'WAITING_APPROVAL' from public.workflow_operations where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb81') then 1 else 0 end;
select 1 / case when (select preparation_approval_requested_at is not null and last_error_code = 'JOIN_APPROVAL_PENDING' from public.broadcast_targets where id = 'cccccccc-cccc-cccc-cccc-cccccccccc81') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1, 60)) then 1 else 0 end;

update public.broadcast_targets set preparation_available_at = now() - interval '1 second' where id = 'cccccccc-cccc-cccc-cccc-cccccccccc81';
select 1 / case when (select previous_status = 'WAITING_APPROVAL' from public.claim_next_broadcast_preparation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1)) then 1 else 0 end;
select 1 / case when not public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc81', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee81', 1, 'CHECKING', 'READY') then 1 else 0 end;
select 1 / case when public.transition_broadcast_preparation('cccccccc-cccc-cccc-cccc-cccccccccc81', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1, 'CHECKING', 'READY') then 1 else 0 end;
select 1 / case when exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa81', 'dddddddd-dddd-dddd-dddd-dddddddddd81', 1, 60)) then 1 else 0 end;

rollback;
