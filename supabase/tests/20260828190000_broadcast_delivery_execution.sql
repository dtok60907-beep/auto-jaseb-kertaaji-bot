-- F4 database proof: worker reuse, FIFO claim, receipt arrays, account interval,
-- FloodWait scheduling, uncertainty stop, and package-specific expiry.

begin;

insert into auth.users (id) values ('20202020-2020-2020-2020-202020202020');
insert into public.entitlements (id, user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '21212121-2121-2121-2121-212121212121',
  '20202020-2020-2020-2020-202020202020',
  '{"packageId":"worker-f4","packageType":"JASEB_WORKER","features":["JASEB"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 0
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('22222222-2222-2222-2222-222222222221', null, 'JASEB_WORKER', 'Worker F4', decode('00', 'hex'), 1, 'READY');
insert into public.worker_account_settings (worker_account_id, interval_seconds, active)
values ('22222222-2222-2222-2222-222222222221', 30, true);
insert into public.broadcast_materials (id, user_id, kind, text_content)
values ('23232323-2323-2323-2323-232323232323', '20202020-2020-2020-2020-202020202020', 'TEXT', 'Promo F4');
insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref, label)
values
  ('24242424-2424-2424-2424-242424242421', '20202020-2020-2020-2020-202020202020', '@lpm_f4_satu', 'F4 satu'),
  ('24242424-2424-2424-2424-242424242422', '20202020-2020-2020-2020-202020202020', '@lpm_f4_dua', 'F4 dua'),
  ('24242424-2424-2424-2424-242424242423', '20202020-2020-2020-2020-202020202020', '@lpm_f4_tiga', 'F4 tiga');

select 1 / case when (select result_status = 'CREATED' from public.create_broadcast_operation(
  '20202020-2020-2020-2020-202020202020', 'JASEB_WORKER', '23232323-2323-2323-2323-232323232323',
  array['24242424-2424-2424-2424-242424242421'::uuid, '24242424-2424-2424-2424-242424242422'::uuid],
  'f4-worker-operation-0001'
)) then 1 else 0 end;
select 1 / case when (select result_status = 'CREATED' from public.create_broadcast_operation(
  '20202020-2020-2020-2020-202020202020', 'JASEB_WORKER', '23232323-2323-2323-2323-232323232323',
  array['24242424-2424-2424-2424-242424242423'::uuid],
  'f4-worker-operation-0002'
)) then 1 else 0 end;

select 1 / case when (
  select count(*) = 1 and min(worker_account_id::text) = '22222222-2222-2222-2222-222222222221'
    from public.worker_assignments
   where user_id = '20202020-2020-2020-2020-202020202020' and status in ('RESERVED', 'ACTIVE')
) then 1 else 0 end;
select 1 / case when (
  select count(distinct account_id) = 1
    from public.workflow_operations
   where user_id = '20202020-2020-2020-2020-202020202020' and operation_type = 'BROADCAST'
) then 1 else 0 end;

update public.workflow_operations set created_at = now() - interval '1 second'
 where idempotency_key = 'f4-worker-operation-0001';

update public.broadcast_targets set preparation_status = 'READY'
 where operation_id in (select id from public.workflow_operations where user_id = '20202020-2020-2020-2020-202020202020');
select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease(
  '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 120
)) then 1 else 0 end;

select 1 / case when (
  select claimed.attempt_count = 1 and target.sequence_number = 1 and operation.idempotency_key = 'f4-worker-operation-0001'
    from public.claim_next_broadcast_command('22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1, 60) claimed
    join public.workflow_commands command on command.id = claimed.command_id
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
) then 1 else 0 end;

do $$
begin
  begin
    perform public.finish_broadcast_command(
      (select command.id from public.workflow_commands command join public.workflow_operations operation on operation.id = command.operation_id join public.broadcast_targets target on target.id = command.broadcast_target_id where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 1),
      '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1,
      'SUCCEEDED', null, null, array['901', '901'], now()
    );
    raise exception 'duplicate receipt IDs were accepted';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_BROADCAST_RECEIPT' then raise; end if;
  end;
end;
$$;

select 1 / case when public.finish_broadcast_command(
  (select command.id from public.workflow_commands command join public.workflow_operations operation on operation.id = command.operation_id join public.broadcast_targets target on target.id = command.broadcast_target_id where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 1),
  '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1,
  'SUCCEEDED', null, null, array['901', '902'], now()
) then 1 else 0 end;

select 1 / case when (
  select command.status = 'SUCCEEDED' and command.provider_message_ids = array['901', '902']
     and target.delivery_status = 'SUCCEEDED' and target.last_provider_message_ids = array['901', '902']
    from public.workflow_commands command
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
   where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 1
) then 1 else 0 end;
select 1 / case when (select status = 'ACTIVE' from public.worker_assignments where user_id = '20202020-2020-2020-2020-202020202020') then 1 else 0 end;
select 1 / case when (select broadcast_next_eligible_at > now() + interval '25 seconds' from public.telegram_accounts where id = '22222222-2222-2222-2222-222222222221') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.claim_next_broadcast_command('22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1, 60)) then 1 else 0 end;

update public.telegram_accounts set broadcast_next_eligible_at = now() - interval '1 second' where id = '22222222-2222-2222-2222-222222222221';
update public.workflow_commands command set available_at = now() - interval '1 second'
  from public.broadcast_targets target, public.workflow_operations operation
 where command.broadcast_target_id = target.id and target.operation_id = operation.id
   and operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2;
select 1 / case when (
  select target.sequence_number = 2 and operation.idempotency_key = 'f4-worker-operation-0001' and claimed.attempt_count = 1
    from public.claim_next_broadcast_command('22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1, 60) claimed
    join public.workflow_commands command on command.id = claimed.command_id
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
) then 1 else 0 end;

select 1 / case when public.finish_broadcast_command(
  (select command.id from public.workflow_commands command join public.workflow_operations operation on operation.id = command.operation_id join public.broadcast_targets target on target.id = command.broadcast_target_id where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2),
  '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1,
  'FAILED_RETRYABLE', 'FLOOD_WAIT', 100000
) then 1 else 0 end;
select 1 / case when (
  select command.status = 'FAILED_RETRYABLE' and command.available_at > now() + interval '1 day'
     and target.delivery_status = 'FAILED_RETRYABLE' and account.broadcast_next_eligible_at > now() + interval '1 day'
    from public.workflow_commands command
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.telegram_accounts account on account.id = command.account_id
    join public.workflow_operations operation on operation.id = command.operation_id
   where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2
) then 1 else 0 end;

update public.telegram_accounts set broadcast_next_eligible_at = now() - interval '1 second' where id = '22222222-2222-2222-2222-222222222221';
update public.workflow_commands command set available_at = now() - interval '1 second'
  from public.broadcast_targets target, public.workflow_operations operation
 where command.broadcast_target_id = target.id and target.operation_id = operation.id
   and operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2;
select 1 / case when (select attempt_count = 2 from public.claim_next_broadcast_command(
  '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1, 60
)) then 1 else 0 end;
select 1 / case when public.finish_broadcast_command(
  (select command.id from public.workflow_commands command join public.workflow_operations operation on operation.id = command.operation_id join public.broadcast_targets target on target.id = command.broadcast_target_id where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2),
  '22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1,
  'SIDE_EFFECT_UNCERTAIN', 'TELEGRAM_TRANSIENT'
) then 1 else 0 end;
select 1 / case when (
  select command.status = 'SIDE_EFFECT_UNCERTAIN' and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN' and operation.status = 'SIDE_EFFECT_UNCERTAIN'
    from public.workflow_commands command
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
   where operation.idempotency_key = 'f4-worker-operation-0001' and target.sequence_number = 2
) then 1 else 0 end;
select 1 / case when not exists (select 1 from public.claim_next_broadcast_command('22222222-2222-2222-2222-222222222221', '25252525-2525-2525-2525-252525252525', 1, 60)) then 1 else 0 end;

update public.entitlements set expires_at = now() - interval '1 second' where id = '21212121-2121-2121-2121-212121212121';
select 1 / case when public.expire_due_entitlements(now()) = 1 then 1 else 0 end;
select 1 / case when (select status = 'RELEASED' and released_at is not null from public.worker_assignments where user_id = '20202020-2020-2020-2020-202020202020') then 1 else 0 end;
select 1 / case when (
  select command.status = 'CANCELLED' and target.delivery_status = 'CANCELLED'
    from public.workflow_operations operation
    join public.workflow_commands command on command.operation_id = operation.id
    join public.broadcast_targets target on target.id = command.broadcast_target_id
   where operation.idempotency_key = 'f4-worker-operation-0002'
) then 1 else 0 end;
select 1 / case when exists (select 1 from public.broadcast_materials where id = '23232323-2323-2323-2323-232323232323') then 1 else 0 end;
select 1 / case when (select status = 'READY' from public.telegram_accounts where id = '22222222-2222-2222-2222-222222222221') then 1 else 0 end;

rollback;
