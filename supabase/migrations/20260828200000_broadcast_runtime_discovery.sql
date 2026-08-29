-- F5.3: due-driven Jasa Sebar account discovery. Discovery only exposes safe
-- metadata; encrypted sessions are returned by a separate lease-fenced function.

alter table public.telegram_accounts
  add column runtime_retry_at timestamptz,
  add column last_runtime_error_code text,
  add column last_runtime_error_at timestamptz,
  add column last_runtime_connected_at timestamptz,
  add column last_runtime_disconnected_at timestamptz,
  add constraint telegram_accounts_runtime_error_pair_check check (
    (last_runtime_error_code is null) = (last_runtime_error_at is null)
  ),
  add constraint telegram_accounts_runtime_error_code_check check (
    last_runtime_error_code is null
    or last_runtime_error_code ~ '^[A-Z][A-Z0-9_]{1,127}$'
  );

create index telegram_accounts_runtime_retry_idx
  on public.telegram_accounts (runtime_retry_at, id)
  where status = 'READY';
create index workflow_operations_broadcast_account_runtime_idx
  on public.workflow_operations (account_id, created_at, id)
  where operation_type = 'BROADCAST'
    and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN');
create index workflow_commands_broadcast_account_runtime_idx
  on public.workflow_commands (account_id, available_at, created_at, id)
  where kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
    and status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED', 'SENDING');

create function public.runtime_shard_index(p_account_id uuid, p_shard_count integer)
returns integer
language plpgsql
immutable
strict
parallel safe
set search_path = public
as $$
declare
  account_bytes bytea := uuid_send(p_account_id);
  byte_index integer;
  shard_remainder integer := 0;
begin
  if p_shard_count not between 1 and 65536 then
    raise exception using errcode = 'P0001', message = 'INVALID_SHARD_COUNT';
  end if;
  for byte_index in 0..15 loop
    shard_remainder := mod(
      shard_remainder * 256 + get_byte(account_bytes, byte_index),
      p_shard_count
    );
  end loop;
  return shard_remainder;
end;
$$;

-- This server-only view centralizes the business eligibility used by discovery
-- and preparation claim. It deliberately contains no Telegram session bytes.
create view public.broadcast_runtime_eligible_operations
with (security_invoker = true)
as
select operation.id as operation_id,
       operation.user_id,
       operation.account_id,
       operation.created_at as operation_created_at,
       account.account_type,
       account.broadcast_next_eligible_at,
       account.runtime_retry_at
  from public.workflow_operations operation
  join public.telegram_accounts account on account.id = operation.account_id
 where operation.operation_type = 'BROADCAST'
   and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
   and account.status = 'READY'
   and operation.payload->>'accountMode' = account.account_type
   and exists (
     select 1
       from public.entitlements entitlement
      where entitlement.user_id = operation.user_id
        and entitlement.status = 'ACTIVE'
        and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = operation.payload->>'accountMode'
        and entitlement.package_snapshot->'features' ? 'JASEB'
   )
   and (
     (account.account_type = 'JASEB_WORKER' and exists (
       select 1
         from public.worker_assignments assignment
        where assignment.user_id = operation.user_id
          and assignment.worker_account_id = operation.account_id
          and assignment.status in ('RESERVED', 'ACTIVE')
     ))
     or
     (account.account_type = 'USERBOT' and exists (
       select 1
         from public.userbot_profiles profile
        where profile.user_id = operation.user_id
          and profile.status = 'CONNECTED'
          and profile.active_account_id = operation.account_id
     ))
   );

create function public.list_broadcast_runtime_accounts(
  p_shard_count integer,
  p_shard_index integer,
  p_due_before timestamptz,
  p_limit integer default 100
)
returns table (
  account_id uuid,
  account_type text,
  next_due_at timestamptz,
  has_preparation_work boolean,
  has_delivery_work boolean,
  requires_recovery boolean
)
language plpgsql
stable
set search_path = public
as $$
begin
  if p_shard_count is null
     or p_shard_index is null
     or p_shard_count not between 1 and 65536
     or p_shard_index < 0
     or p_shard_index >= p_shard_count then
    raise exception using errcode = 'P0001', message = 'INVALID_SHARD_CONFIG';
  end if;
  if p_due_before is null then
    raise exception using errcode = 'P0001', message = 'INVALID_DUE_BOUNDARY';
  end if;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception using errcode = 'P0001', message = 'INVALID_DISCOVERY_LIMIT';
  end if;

  return query
  with preparation_work as (
    select eligible.account_id,
           eligible.account_type,
           greatest(
             target.preparation_available_at,
             coalesce(eligible.runtime_retry_at, '-infinity'::timestamptz)
           ) as due_at,
           true as is_preparation,
           false as is_delivery,
           false as is_recovery
      from public.broadcast_runtime_eligible_operations eligible
      join public.broadcast_targets target
        on target.operation_id = eligible.operation_id
     where target.preparation_status in ('QUEUED', 'WAITING_APPROVAL')
  ),
  delivery_work as (
    select eligible.account_id,
           eligible.account_type,
           greatest(
             command.available_at,
             coalesce(eligible.broadcast_next_eligible_at, '-infinity'::timestamptz),
             coalesce(eligible.runtime_retry_at, '-infinity'::timestamptz)
           ) as due_at,
           false as is_preparation,
           true as is_delivery,
           false as is_recovery
      from public.broadcast_runtime_eligible_operations eligible
      join public.workflow_commands command
        on command.operation_id = eligible.operation_id
       and command.account_id = eligible.account_id
      join public.broadcast_targets target on target.id = command.broadcast_target_id
     where command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and target.preparation_status = 'READY'
       and not exists (
         select 1
           from public.workflow_commands earlier_command
           join public.broadcast_targets earlier_target
             on earlier_target.id = earlier_command.broadcast_target_id
          where earlier_target.operation_id = target.operation_id
            and earlier_target.sequence_number < target.sequence_number
            and earlier_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
       and not exists (
         select 1
           from public.workflow_operations earlier_operation
           join public.workflow_commands earlier_operation_command
             on earlier_operation_command.operation_id = earlier_operation.id
          where earlier_operation.account_id = eligible.account_id
            and earlier_operation.operation_type = 'BROADCAST'
            and (earlier_operation.created_at, earlier_operation.id)
                < (eligible.operation_created_at, eligible.operation_id)
            and earlier_operation_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
  ),
  preparation_recovery as (
    select operation.account_id,
           account.account_type,
           now() as due_at,
           true as is_preparation,
           false as is_delivery,
           true as is_recovery
      from public.broadcast_targets target
      join public.workflow_operations operation on operation.id = target.operation_id
      join public.telegram_accounts account on account.id = operation.account_id
     where operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       and account.status = 'READY'
       and target.preparation_status in ('CHECKING', 'JOINING')
       and not exists (
         select 1 from public.account_leases account_lease
          where account_lease.account_id = operation.account_id
            and account_lease.lease_owner = target.preparation_lease_owner
            and account_lease.fencing_token = target.preparation_fencing_token
            and account_lease.lease_until > now()
       )
  ),
  delivery_recovery as (
    select command.account_id,
           account.account_type,
           now() as due_at,
           false as is_preparation,
           true as is_delivery,
           true as is_recovery
      from public.workflow_commands command
      join public.workflow_operations operation on operation.id = command.operation_id
      join public.telegram_accounts account on account.id = command.account_id
     where operation.operation_type = 'BROADCAST'
       and account.status = 'READY'
       and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
       and command.status in ('CLAIMED', 'SENDING')
       and (
         command.lease_until is null
         or command.lease_until <= now()
         or not exists (
           select 1 from public.account_leases account_lease
            where account_lease.account_id = command.account_id
              and account_lease.lease_owner = command.lease_owner
              and account_lease.fencing_token = command.fencing_token
              and account_lease.lease_until > now()
         )
       )
  ),
  all_work as (
    select * from preparation_work
    union all select * from delivery_work
    union all select * from preparation_recovery
    union all select * from delivery_recovery
  )
  select work.account_id,
         work.account_type,
         min(work.due_at) as next_due_at,
         bool_or(work.is_preparation) as has_preparation_work,
         bool_or(work.is_delivery) as has_delivery_work,
         bool_or(work.is_recovery) as requires_recovery
    from all_work work
   where work.due_at <= p_due_before
     and public.runtime_shard_index(work.account_id, p_shard_count) = p_shard_index
   group by work.account_id, work.account_type
   order by min(work.due_at), work.account_id
   limit p_limit;
end;
$$;

create function public.load_telegram_session_for_runtime(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns table (
  account_id uuid,
  account_type text,
  encrypted_session bytea,
  encryption_key_version integer
)
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.account_leases account_lease
     where account_lease.account_id = p_account_id
       and account_lease.lease_owner = p_lease_owner
       and account_lease.fencing_token = p_account_fencing_token
       and account_lease.lease_until > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD';
  end if;

  return query
  select account.id, account.account_type, account.encrypted_session,
         account.encryption_key_version
   from public.telegram_accounts account
   where account.id = p_account_id
     and account.status = 'READY'
     and (account.runtime_retry_at is null or account.runtime_retry_at <= now());
end;
$$;

create function public.record_telegram_account_runtime_result(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_result text,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  recorded boolean;
begin
  if p_result is null
     or p_result not in ('CONNECTED', 'DISCONNECTED', 'FAILED_RETRYABLE', 'DEGRADED', 'REVOKED') then
    raise exception using errcode = 'P0001', message = 'INVALID_RUNTIME_RESULT';
  end if;
  if p_result in ('CONNECTED', 'DISCONNECTED')
     and (p_error_code is not null or p_retry_after_seconds is not null) then
    raise exception using errcode = 'P0001', message = 'INVALID_RUNTIME_RESULT_CONTEXT';
  end if;
  if p_result = 'FAILED_RETRYABLE'
     and (coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{1,127}$'
          or p_retry_after_seconds is null
          or p_retry_after_seconds not between 1 and 2147483647) then
    raise exception using errcode = 'P0001', message = 'INVALID_RUNTIME_RETRY';
  end if;
  if p_result in ('DEGRADED', 'REVOKED')
     and (coalesce(p_error_code, '') !~ '^[A-Z][A-Z0-9_]{1,127}$'
          or p_retry_after_seconds is not null) then
    raise exception using errcode = 'P0001', message = 'INVALID_RUNTIME_FAILURE';
  end if;

  update public.telegram_accounts account
     set status = case
           when p_result = 'DEGRADED' then 'DEGRADED'
           when p_result = 'REVOKED' then 'REVOKED'
           else account.status
         end,
         runtime_retry_at = case
           when p_result = 'FAILED_RETRYABLE'
             then now() + make_interval(secs => p_retry_after_seconds)
           when p_result in ('CONNECTED', 'DEGRADED', 'REVOKED') then null
           else account.runtime_retry_at
         end,
         last_runtime_error_code = case
           when p_result in ('FAILED_RETRYABLE', 'DEGRADED', 'REVOKED') then p_error_code
           when p_result = 'CONNECTED' then null
           else account.last_runtime_error_code
         end,
         last_runtime_error_at = case
           when p_result in ('FAILED_RETRYABLE', 'DEGRADED', 'REVOKED') then now()
           when p_result = 'CONNECTED' then null
           else account.last_runtime_error_at
         end,
         last_runtime_connected_at = case
           when p_result = 'CONNECTED' then now() else account.last_runtime_connected_at
         end,
         last_runtime_disconnected_at = case
           when p_result = 'DISCONNECTED' then now() else account.last_runtime_disconnected_at
         end,
         updated_at = now()
   where account.id = p_account_id
     and (account.status = 'READY' or p_result = 'DISCONNECTED')
     and exists (
       select 1 from public.account_leases account_lease
        where account_lease.account_id = p_account_id
          and account_lease.lease_owner = p_lease_owner
          and account_lease.fencing_token = p_account_fencing_token
          and account_lease.lease_until > now()
     )
  returning true into recorded;
  return coalesce(recorded, false);
end;
$$;

-- Replace F2 claim so entitlement/profile/assignment changes are checked again
-- at the mutation boundary, not trusted from a possibly stale discovery result.
create or replace function public.claim_next_broadcast_preparation(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns table (target_id uuid, operation_id uuid, telegram_target_ref text, previous_status text)
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.account_leases account_lease
     where account_lease.account_id = p_account_id
       and account_lease.lease_owner = p_lease_owner
       and account_lease.fencing_token = p_account_fencing_token
       and account_lease.lease_until > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD';
  end if;

  update public.broadcast_targets target
     set preparation_status = 'QUEUED', preparation_available_at = now(),
         preparation_lease_owner = null, preparation_fencing_token = null,
         last_error_code = 'PREPARATION_LEASE_FENCED'
    from public.workflow_operations operation
   where operation.id = target.operation_id
     and operation.account_id = p_account_id
     and target.preparation_status in ('CHECKING', 'JOINING')
     and (target.preparation_lease_owner is distinct from p_lease_owner
          or target.preparation_fencing_token is distinct from p_account_fencing_token);

  return query
  with candidate as (
    select target.id, target.preparation_status as previous_status
      from public.broadcast_targets target
      join public.broadcast_runtime_eligible_operations eligible
        on eligible.operation_id = target.operation_id
     where eligible.account_id = p_account_id
       and (eligible.runtime_retry_at is null or eligible.runtime_retry_at <= now())
       and target.preparation_status in ('QUEUED', 'WAITING_APPROVAL')
       and target.preparation_available_at <= now()
     order by eligible.operation_created_at, target.sequence_number,
              target.created_at, target.id
     for update of target skip locked
     limit 1
  )
  update public.broadcast_targets target
     set preparation_status = 'CHECKING',
         preparation_attempt_count = target.preparation_attempt_count + 1,
         preparation_lease_owner = p_lease_owner,
         preparation_fencing_token = p_account_fencing_token,
         last_error_code = null
    from candidate
   where target.id = candidate.id
  returning target.id, target.operation_id, target.telegram_target_ref,
            candidate.previous_status;
end;
$$;

-- F4 delivery claim uses the same current eligibility projection and runtime
-- retry boundary. A stale caller cannot bypass discovery and send during backoff.
create or replace function public.claim_next_broadcast_command(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_command_lease_seconds integer
)
returns table (
  command_id uuid, operation_id uuid, account_id uuid, kind text, target_id text,
  payload jsonb, attempt_count integer, fencing_token bigint, lease_until timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  selected_command_id uuid;
begin
  if p_command_lease_seconds not between 1 and 3600 then
    raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_LEASE_DURATION';
  end if;
  if not exists (
    select 1 from public.account_leases account_lease
     where account_lease.account_id = p_account_id
       and account_lease.lease_owner = p_lease_owner
       and account_lease.fencing_token = p_account_fencing_token
       and account_lease.lease_until > now()
  ) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD';
  end if;

  update public.workflow_operations operation
     set status = 'SIDE_EFFECT_UNCERTAIN', error_code = 'COMMAND_LEASE_LOST'
   where operation.account_id = p_account_id
     and operation.operation_type = 'BROADCAST'
     and exists (
       select 1 from public.workflow_commands command
        where command.operation_id = operation.id
          and command.status in ('CLAIMED', 'SENDING')
          and (
            command.lease_until is null
            or command.lease_until <= now()
            or command.lease_owner is distinct from p_lease_owner
            or command.fencing_token is distinct from p_account_fencing_token
          )
     );
  update public.broadcast_targets target
     set delivery_status = 'SIDE_EFFECT_UNCERTAIN', last_error_code = 'COMMAND_LEASE_LOST'
   where exists (
     select 1 from public.workflow_commands command
      where command.broadcast_target_id = target.id
        and command.account_id = p_account_id
        and command.status in ('CLAIMED', 'SENDING')
        and (
          command.lease_until is null
          or command.lease_until <= now()
          or command.lease_owner is distinct from p_lease_owner
          or command.fencing_token is distinct from p_account_fencing_token
        )
   );
  update public.workflow_commands command
     set status = 'SIDE_EFFECT_UNCERTAIN', lease_until = null,
         last_error_code = case
           when command.lease_until is null or command.lease_until <= now()
             then 'COMMAND_LEASE_EXPIRED'
           else 'ACCOUNT_LEASE_FENCED'
         end,
         outcome_checked_at = now()
   where command.account_id = p_account_id
     and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
     and command.status in ('CLAIMED', 'SENDING')
     and (
       command.lease_until is null
       or command.lease_until <= now()
       or command.lease_owner is distinct from p_lease_owner
       or command.fencing_token is distinct from p_account_fencing_token
     );

  select command.id into selected_command_id
    from public.workflow_commands command
    join public.broadcast_runtime_eligible_operations eligible
      on eligible.operation_id = command.operation_id
     and eligible.account_id = command.account_id
    join public.broadcast_targets target on target.id = command.broadcast_target_id
   where command.account_id = p_account_id
     and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
     and (eligible.runtime_retry_at is null or eligible.runtime_retry_at <= now())
     and (eligible.broadcast_next_eligible_at is null
          or eligible.broadcast_next_eligible_at <= now())
     and command.status in ('PENDING', 'FAILED_RETRYABLE')
     and command.available_at <= now()
     and target.preparation_status = 'READY'
     and not exists (
       select 1 from public.workflow_commands earlier_command
       join public.broadcast_targets earlier_target
         on earlier_target.id = earlier_command.broadcast_target_id
        where earlier_target.operation_id = target.operation_id
          and earlier_target.sequence_number < target.sequence_number
          and earlier_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
     and not exists (
       select 1
         from public.workflow_operations earlier_operation
         join public.workflow_commands earlier_operation_command
           on earlier_operation_command.operation_id = earlier_operation.id
        where earlier_operation.account_id = eligible.account_id
          and earlier_operation.operation_type = 'BROADCAST'
          and (earlier_operation.created_at, earlier_operation.id)
              < (eligible.operation_created_at, eligible.operation_id)
          and earlier_operation_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
   order by eligible.operation_created_at, target.sequence_number,
            command.created_at, command.id
   for update of command skip locked
   limit 1;
  if not found then return; end if;

  update public.workflow_commands command
     set status = 'CLAIMED', lease_owner = p_lease_owner,
         fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds),
         attempt_count = command.attempt_count + 1,
         last_error_code = null
   where command.id = selected_command_id;
  update public.broadcast_targets target
     set delivery_status = 'SENDING', last_error_code = null
   where target.id = (
     select broadcast_target_id from public.workflow_commands
      where id = selected_command_id
   );
  update public.workflow_operations operation
     set status = 'SENDING', error_code = null
   where operation.id = (
     select command.operation_id from public.workflow_commands command
      where command.id = selected_command_id
   );

  return query
  select command.id, command.operation_id, command.account_id, command.kind,
         command.target_id, command.payload, command.attempt_count,
         command.fencing_token, command.lease_until
    from public.workflow_commands command
   where command.id = selected_command_id;
end;
$$;

create function public.notify_broadcast_runtime_account()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  old_account_id uuid;
  new_account_id uuid;
begin
  if tg_table_name = 'workflow_commands' then
    if tg_op <> 'INSERT' and old.kind in ('SEND_TEXT', 'FORWARD_MESSAGE') then old_account_id := old.account_id; end if;
    if tg_op <> 'DELETE' and new.kind in ('SEND_TEXT', 'FORWARD_MESSAGE') then new_account_id := new.account_id; end if;
  elsif tg_table_name = 'broadcast_targets' then
    if tg_op <> 'INSERT' then select account_id into old_account_id from public.workflow_operations where id = old.operation_id; end if;
    if tg_op <> 'DELETE' then select account_id into new_account_id from public.workflow_operations where id = new.operation_id; end if;
  elsif tg_table_name = 'telegram_accounts' then
    if tg_op <> 'INSERT' then old_account_id := old.id; end if;
    if tg_op <> 'DELETE' then new_account_id := new.id; end if;
  end if;

  if old_account_id is not null and old_account_id is distinct from new_account_id then
    perform pg_notify('jaseb_broadcast_runtime', old_account_id::text);
  end if;
  if new_account_id is not null then
    perform pg_notify('jaseb_broadcast_runtime', new_account_id::text);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger workflow_commands_broadcast_runtime_wakeup
after insert or delete or update of status, available_at, account_id
on public.workflow_commands
for each row execute function public.notify_broadcast_runtime_account();
create trigger broadcast_targets_runtime_wakeup
after insert or delete or update of preparation_status, preparation_available_at, delivery_status
on public.broadcast_targets
for each row execute function public.notify_broadcast_runtime_account();
create trigger telegram_accounts_broadcast_runtime_wakeup
after update of status, broadcast_next_eligible_at, runtime_retry_at
on public.telegram_accounts
for each row execute function public.notify_broadcast_runtime_account();

comment on function public.runtime_shard_index(uuid, integer)
  is 'Full unsigned UUID 128-bit modulo mapping shared with the TypeScript engine.';
comment on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer)
  is 'Lists safe due/future Jasa Sebar account metadata for one shard; never returns session ciphertext.';
comment on function public.load_telegram_session_for_runtime(uuid, uuid, bigint)
  is 'Returns one READY account session envelope only to its active account-lease fencing owner.';
comment on function public.record_telegram_account_runtime_result(uuid, uuid, bigint, text, text, integer)
  is 'Persists stable runtime connection state only under the current account lease and fencing token.';
comment on function public.notify_broadcast_runtime_account()
  is 'Transaction-safe Jasa Sebar wake-up hint; PostgreSQL remains the source of truth after reconnect.';

revoke all on public.broadcast_runtime_eligible_operations from public;
revoke all on function public.runtime_shard_index(uuid, integer) from public;
revoke all on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer) from public;
revoke all on function public.load_telegram_session_for_runtime(uuid, uuid, bigint) from public;
revoke all on function public.record_telegram_account_runtime_result(uuid, uuid, bigint, text, text, integer) from public;
revoke all on function public.notify_broadcast_runtime_account() from public;
