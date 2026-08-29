-- F5.3 database proof: shard parity, safe runnable discovery, due scheduling,
-- current entitlement binding, fenced session access, and runtime state fencing.

begin;

select 1 / case when public.runtime_shard_index('00000000-0000-0000-0000-000000000001', 3) = 1 then 1 else 0 end;
select 1 / case when public.runtime_shard_index('00000000-0000-0000-0000-000000000002', 3) = 2 then 1 else 0 end;
select 1 / case when public.runtime_shard_index('00000000-0000-0000-0000-000000000003', 3) = 0 then 1 else 0 end;
select 1 / case when public.runtime_shard_index('ffffffff-ffff-ffff-ffff-ffffffffffff', 257) = 0 then 1 else 0 end;

do $$
begin
  begin
    perform public.runtime_shard_index('00000000-0000-0000-0000-000000000001', 0);
    raise exception 'zero shard count was accepted';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_SHARD_COUNT' then raise; end if;
  end;
  begin
    perform 1 from public.list_broadcast_runtime_accounts(3, 3, now(), 10);
    raise exception 'out-of-range shard index was accepted';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_SHARD_CONFIG' then raise; end if;
  end;
end;
$$;

insert into auth.users (id) values
  ('40404040-4040-4040-4040-404040404040'),
  ('45454545-4545-4545-4545-454545454545');

insert into public.entitlements (
  id, user_id, package_snapshot, status, starts_at, expires_at,
  max_lpm_groups, max_channel_targets
) values
  (
    '46464646-4646-4646-4646-464646464641',
    '40404040-4040-4040-4040-404040404040',
    '{"packageId":"f53-userbot","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
    'ACTIVE', now() - interval '1 day', now() + interval '1 day', 10, 10
  ),
  (
    '46464646-4646-4646-4646-464646464642',
    '45454545-4545-4545-4545-454545454545',
    '{"packageId":"f53-worker","packageType":"JASEB_WORKER","features":["JASEB"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
    'ACTIVE', now() - interval '1 day', now() + interval '1 day', 10, 0
  );

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session,
  encryption_key_version, status, runtime_retry_at
) values
  (
    '41414141-4141-4141-4141-414141414141',
    '40404040-4040-4040-4040-404040404040',
    'USERBOT', 'F5.3 Userbot', decode('010203', 'hex'), 7, 'READY', null
  ),
  (
    '42424242-4242-4242-4242-424242424242',
    null, 'JASEB_WORKER', 'F5.3 Worker', decode('aabbcc', 'hex'), 8,
    'READY', now() + interval '2 minutes'
  );

insert into public.userbot_profiles (
  user_id, active_account_id, status, broadcast_interval_seconds
) values (
  '40404040-4040-4040-4040-404040404040',
  '41414141-4141-4141-4141-414141414141', 'CONNECTED', 0
);

insert into public.workflow_operations (
  id, user_id, account_id, operation_type, status, idempotency_key, payload, created_at
) values
  (
    '47474747-4747-4747-4747-474747474741',
    '40404040-4040-4040-4040-404040404040',
    '41414141-4141-4141-4141-414141414141',
    'BROADCAST', 'READY', 'f53-userbot-operation',
    '{"accountMode":"USERBOT","material":{"kind":"TEXT","text":"promo"}}',
    now() - interval '2 seconds'
  ),
  (
    '47474747-4747-4747-4747-474747474742',
    '45454545-4545-4545-4545-454545454545',
    '42424242-4242-4242-4242-424242424242',
    'BROADCAST', 'QUEUED', 'f53-worker-operation',
    '{"accountMode":"JASEB_WORKER","material":{"kind":"TEXT","text":"promo"}}',
    now() - interval '1 second'
  );

insert into public.worker_assignments (
  operation_id, worker_account_id, user_id, status
) values (
  '47474747-4747-4747-4747-474747474742',
  '42424242-4242-4242-4242-424242424242',
  '45454545-4545-4545-4545-454545454545', 'RESERVED'
);

insert into public.broadcast_targets (
  id, operation_id, telegram_target_ref, interval_seconds, sequence_number,
  preparation_status, preparation_available_at
) values
  (
    '48484848-4848-4848-4848-484848484841',
    '47474747-4747-4747-4747-474747474741',
    '@f53_userbot', 0, 1, 'READY', now()
  ),
  (
    '48484848-4848-4848-4848-484848484842',
    '47474747-4747-4747-4747-474747474742',
    '@f53_worker', 30, 1, 'QUEUED', now()
  );

insert into public.workflow_commands (
  id, operation_id, account_id, kind, target_id, idempotency_key, payload,
  broadcast_target_id, status, available_at
) values
  (
    '49494949-4949-4949-4949-494949494941',
    '47474747-4747-4747-4747-474747474741',
    '41414141-4141-4141-4141-414141414141',
    'SEND_TEXT', '@f53_userbot', 'f53-userbot-command',
    '{"material":{"kind":"TEXT","text":"promo"}}',
    '48484848-4848-4848-4848-484848484841', 'PENDING', now()
  ),
  (
    '49494949-4949-4949-4949-494949494942',
    '47474747-4747-4747-4747-474747474742',
    '42424242-4242-4242-4242-424242424242',
    'SEND_TEXT', '@f53_worker', 'f53-worker-command',
    '{"material":{"kind":"TEXT","text":"promo"}}',
    '48484848-4848-4848-4848-484848484842', 'PENDING', now()
  );

-- Shard 2 owns the due Userbot; discovery returns safe metadata only.
select 1 / case when (
  select count(*) = 1
     and min(account_id::text) = '41414141-4141-4141-4141-414141414141'
     and bool_and(has_delivery_work)
     and bool_and(not has_preparation_work)
    from public.list_broadcast_runtime_accounts(3, 2, now(), 10)
) then 1 else 0 end;
select 1 / case when position(
  'session' in lower(pg_get_function_result(
    'public.list_broadcast_runtime_accounts(integer,integer,timestamp with time zone,integer)'::regprocedure
  ))
) = 0 then 1 else 0 end;
select 1 / case when
  not has_table_privilege('authenticated', 'public.broadcast_runtime_eligible_operations', 'SELECT')
  and not has_function_privilege(
    'authenticated',
    'public.list_broadcast_runtime_accounts(integer,integer,timestamp with time zone,integer)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.load_telegram_session_for_runtime(uuid,uuid,bigint)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.record_telegram_account_runtime_result(uuid,uuid,bigint,text,text,integer)',
    'EXECUTE'
  )
then 1 else 0 end;

-- Worker shard 0 is not due while runtime backoff is active, but next-work lookup
-- sees the exact future boundary rather than requiring an account scan.
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(3, 0, now(), 10)
) then 1 else 0 end;
select 1 / case when (
  select account_id = '42424242-4242-4242-4242-424242424242'
     and has_preparation_work
     and next_due_at > now() + interval '90 seconds'
    from public.list_broadcast_runtime_accounts(3, 0, 'infinity', 1)
) then 1 else 0 end;

update public.telegram_accounts
   set runtime_retry_at = null
 where id = '42424242-4242-4242-4242-424242424242';
select 1 / case when (
  select account_id = '42424242-4242-4242-4242-424242424242'
     and has_preparation_work and not has_delivery_work
    from public.list_broadcast_runtime_accounts(3, 0, now(), 10)
) then 1 else 0 end;

select 1 / case when (
  select result_status = 'ACQUIRED'
    from public.acquire_account_lease(
      '42424242-4242-4242-4242-424242424242',
      '50505050-5050-5050-5050-505050505050', 120
    )
) then 1 else 0 end;

-- Expired entitlement is rechecked at claim time even after discovery + lease.
update public.entitlements
   set expires_at = now() - interval '1 second'
 where id = '46464646-4646-4646-4646-464646464642';
select 1 / case when not exists (
  select 1 from public.claim_next_broadcast_preparation(
    '42424242-4242-4242-4242-424242424242',
    '50505050-5050-5050-5050-505050505050', 1
  )
) then 1 else 0 end;
update public.entitlements
   set expires_at = now() + interval '1 day'
 where id = '46464646-4646-4646-4646-464646464642';
select 1 / case when exists (
  select 1 from public.claim_next_broadcast_preparation(
    '42424242-4242-4242-4242-424242424242',
    '50505050-5050-5050-5050-505050505050', 1
  )
) then 1 else 0 end;

do $$
begin
  begin
    perform 1 from public.load_telegram_session_for_runtime(
      '41414141-4141-4141-4141-414141414141',
      '51515151-5151-5151-5151-515151515151', 1
    );
    raise exception 'session loaded without lease';
  exception when raise_exception then
    if sqlerrm <> 'ACCOUNT_LEASE_NOT_HELD' then raise; end if;
  end;
end;
$$;

select 1 / case when (
  select result_status = 'ACQUIRED'
    from public.acquire_account_lease(
      '41414141-4141-4141-4141-414141414141',
      '51515151-5151-5151-5151-515151515151', 120
    )
) then 1 else 0 end;
select 1 / case when (
  select encode(encrypted_session, 'hex') = '010203'
     and encryption_key_version = 7 and account_type = 'USERBOT'
    from public.load_telegram_session_for_runtime(
      '41414141-4141-4141-4141-414141414141',
      '51515151-5151-5151-5151-515151515151', 1
    )
) then 1 else 0 end;

select 1 / case when public.record_telegram_account_runtime_result(
  '41414141-4141-4141-4141-414141414141',
  '51515151-5151-5151-5151-515151515151', 1,
  'FAILED_RETRYABLE', 'TELEGRAM_CONNECT_TIMEOUT', 60
) then 1 else 0 end;
select 1 / case when (
  select runtime_retry_at > now() + interval '50 seconds'
     and last_runtime_error_code = 'TELEGRAM_CONNECT_TIMEOUT'
     and last_runtime_error_at is not null
    from public.telegram_accounts
   where id = '41414141-4141-4141-4141-414141414141'
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.load_telegram_session_for_runtime(
    '41414141-4141-4141-4141-414141414141',
    '51515151-5151-5151-5151-515151515151', 1
  )
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.claim_next_broadcast_command(
    '41414141-4141-4141-4141-414141414141',
    '51515151-5151-5151-5151-515151515151', 1, 60
  )
) then 1 else 0 end;

do $$
begin
  begin
    perform public.record_telegram_account_runtime_result(
      '41414141-4141-4141-4141-414141414141',
      '51515151-5151-5151-5151-515151515151', 1,
      'DEGRADED', 'raw telegram error: phone', null
    );
    raise exception 'raw runtime error was accepted';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_RUNTIME_FAILURE' then raise; end if;
  end;
end;
$$;

update public.account_leases
   set lease_until = now() - interval '1 second'
 where account_id = '41414141-4141-4141-4141-414141414141';
select 1 / case when (
  select result_status = 'TAKEN_OVER' and fencing_token = 2
    from public.acquire_account_lease(
      '41414141-4141-4141-4141-414141414141',
      '52525252-5252-5252-5252-525252525252', 120
    )
) then 1 else 0 end;
select 1 / case when not public.record_telegram_account_runtime_result(
  '41414141-4141-4141-4141-414141414141',
  '51515151-5151-5151-5151-515151515151', 1,
  'CONNECTED', null, null
) then 1 else 0 end;
select 1 / case when public.record_telegram_account_runtime_result(
  '41414141-4141-4141-4141-414141414141',
  '52525252-5252-5252-5252-525252525252', 2,
  'CONNECTED', null, null
) then 1 else 0 end;
select 1 / case when (
  select runtime_retry_at is null and last_runtime_error_code is null
     and last_runtime_error_at is null and last_runtime_connected_at is not null
    from public.telegram_accounts
   where id = '41414141-4141-4141-4141-414141414141'
) then 1 else 0 end;

-- A dead command owner is discoverable for reconciliation even before a new
-- delivery can be selected; a current fencing owner then marks it uncertain.
update public.account_leases
   set lease_until = now() - interval '1 second'
 where account_id = '41414141-4141-4141-4141-414141414141';
update public.workflow_commands
   set status = 'CLAIMED', lease_owner = '52525252-5252-5252-5252-525252525252',
       fencing_token = 2, lease_until = now() - interval '1 second'
 where id = '49494949-4949-4949-4949-494949494941';
select 1 / case when (
  select account_id = '41414141-4141-4141-4141-414141414141'
     and has_delivery_work and requires_recovery
    from public.list_broadcast_runtime_accounts(3, 2, now(), 10)
) then 1 else 0 end;
select 1 / case when (
  select result_status = 'TAKEN_OVER' and fencing_token = 3
    from public.acquire_account_lease(
      '41414141-4141-4141-4141-414141414141',
      '53535353-5353-5353-5353-535353535353', 120
    )
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.claim_next_broadcast_command(
    '41414141-4141-4141-4141-414141414141',
    '53535353-5353-5353-5353-535353535353', 3, 60
  )
) then 1 else 0 end;
select 1 / case when (
  select command.status = 'SIDE_EFFECT_UNCERTAIN'
     and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN'
     and operation.status = 'SIDE_EFFECT_UNCERTAIN'
    from public.workflow_commands command
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
   where command.id = '49494949-4949-4949-4949-494949494941'
) then 1 else 0 end;

select 1 / case when public.record_telegram_account_runtime_result(
  '41414141-4141-4141-4141-414141414141',
  '53535353-5353-5353-5353-535353535353', 3,
  'DEGRADED', 'SESSION_CONNECTION_CONFLICT', null
) then 1 else 0 end;
select 1 / case when public.record_telegram_account_runtime_result(
  '41414141-4141-4141-4141-414141414141',
  '53535353-5353-5353-5353-535353535353', 3,
  'DISCONNECTED', null, null
) then 1 else 0 end;
select 1 / case when (
  select status = 'DEGRADED'
     and last_runtime_error_code = 'SESSION_CONNECTION_CONFLICT'
     and last_runtime_disconnected_at is not null
    from public.telegram_accounts
   where id = '41414141-4141-4141-4141-414141414141'
) then 1 else 0 end;

rollback;
