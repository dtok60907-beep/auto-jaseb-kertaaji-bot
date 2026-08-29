-- Fenced, resumable preparation for public Grup LPM targets. Preparation is
-- separate from delivery so a send command is never claimed before its target
-- has resolved and the account is already a member.

alter table public.broadcast_targets
  add column preparation_available_at timestamptz not null default now(),
  add column preparation_attempt_count integer not null default 0 check (preparation_attempt_count >= 0),
  add column preparation_lease_owner uuid,
  add column preparation_fencing_token bigint check (preparation_fencing_token is null or preparation_fencing_token > 0);

create index broadcast_targets_preparation_claim_idx
  on public.broadcast_targets (preparation_available_at, created_at)
  where preparation_status = 'QUEUED';

create or replace function public.claim_next_broadcast_preparation(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns table (target_id uuid, operation_id uuid, telegram_target_ref text)
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
     set preparation_status = 'QUEUED',
         preparation_available_at = now(),
         preparation_lease_owner = null,
         preparation_fencing_token = null,
         last_error_code = 'PREPARATION_LEASE_FENCED'
    from public.workflow_operations operation
   where operation.id = target.operation_id
     and operation.account_id = p_account_id
     and target.preparation_status in ('CHECKING', 'JOINING')
     and (target.preparation_lease_owner is distinct from p_lease_owner
          or target.preparation_fencing_token is distinct from p_account_fencing_token);

  return query
  with candidate as (
    select target.id
      from public.broadcast_targets target
      join public.workflow_operations operation on operation.id = target.operation_id
     where operation.account_id = p_account_id
       and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       and target.preparation_status = 'QUEUED'
       and target.preparation_available_at <= now()
     order by operation.created_at, target.sequence_number, target.created_at, target.id
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
  returning target.id, target.operation_id, target.telegram_target_ref;
end;
$$;

create or replace function public.transition_broadcast_preparation(
  p_target_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_expected_status text,
  p_status text,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  transitioned boolean;
  operation_id_value uuid;
begin
  if p_expected_status not in ('CHECKING', 'JOINING')
     or p_status not in ('QUEUED', 'JOINING', 'READY', 'FAILED_FINAL')
     or (p_expected_status = 'JOINING' and p_status = 'JOINING') then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_TRANSITION';
  end if;
  if p_status = 'QUEUED' and (p_retry_after_seconds is null or p_retry_after_seconds not between 1 and 86400) then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_RETRY';
  end if;
  if p_status <> 'QUEUED' and p_retry_after_seconds is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_RETRY';
  end if;
  if not exists (
    select 1 from public.account_leases account_lease
     where account_lease.account_id = p_account_id
       and account_lease.lease_owner = p_lease_owner
       and account_lease.fencing_token = p_account_fencing_token
       and account_lease.lease_until > now()
  ) then return false; end if;

  update public.broadcast_targets target
     set preparation_status = p_status,
         preparation_available_at = case when p_status = 'QUEUED' then now() + make_interval(secs => p_retry_after_seconds) else target.preparation_available_at end,
         preparation_lease_owner = case when p_status = 'JOINING' then p_lease_owner else null end,
         preparation_fencing_token = case when p_status = 'JOINING' then p_account_fencing_token else null end,
         last_error_code = p_error_code,
         delivery_status = case when p_status = 'FAILED_FINAL' then 'FAILED_FINAL' else target.delivery_status end
    from public.workflow_operations operation
   where target.id = p_target_id
     and operation.id = target.operation_id
     and operation.account_id = p_account_id
     and target.preparation_status = p_expected_status
     and target.preparation_lease_owner = p_lease_owner
     and target.preparation_fencing_token = p_account_fencing_token
  returning target.operation_id, true into operation_id_value, transitioned;
  if not coalesce(transitioned, false) then return false; end if;

  if p_status = 'FAILED_FINAL' then
    update public.workflow_commands
       set status = 'FAILED_FINAL', last_error_code = p_error_code
     where broadcast_target_id = p_target_id
       and status in ('PENDING', 'FAILED_RETRYABLE');
  end if;

  if p_status = 'JOINING' then
    update public.workflow_operations set status = 'JOINING' where id = operation_id_value;
  elsif p_status = 'QUEUED' then
    update public.workflow_operations set status = 'QUEUED' where id = operation_id_value;
  elsif not exists (
    select 1 from public.broadcast_targets
     where operation_id = operation_id_value
       and preparation_status in ('QUEUED', 'CHECKING', 'JOINING')
  ) then
    update public.workflow_operations operation
       set status = case when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = operation_id_value and target.preparation_status = 'READY'
       ) then 'READY' else 'FAILED_FINAL' end
     where operation.id = operation_id_value;
  else
    update public.workflow_operations set status = 'CHECKING' where id = operation_id_value;
  end if;
  return true;
end;
$$;

-- Preserve E3 fencing behavior while making READY preparation mandatory for
-- broadcast commands. Auto-comment commands have no broadcast target context.
create or replace function public.claim_next_workflow_command(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_command_lease_seconds integer
)
returns table (command_id uuid, operation_id uuid, account_id uuid, kind text, target_id text, payload jsonb, fencing_token bigint, lease_until timestamptz)
language plpgsql
set search_path = public
as $$
begin
  if p_command_lease_seconds not between 1 and 3600 then raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_LEASE_DURATION'; end if;
  if not exists (select 1 from public.account_leases account_lease where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now()) then raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD'; end if;

  update public.workflow_commands command
     set status = 'SIDE_EFFECT_UNCERTAIN', lease_until = null,
         last_error_code = case when command.lease_until <= now() then 'COMMAND_LEASE_EXPIRED' else 'ACCOUNT_LEASE_FENCED' end,
         outcome_checked_at = now()
   where command.account_id = p_account_id and command.status in ('CLAIMED', 'SENDING')
     and (command.lease_until <= now() or command.lease_owner is distinct from p_lease_owner or command.fencing_token is distinct from p_account_fencing_token);

  return query
  with candidate as (
    select command.id
      from public.workflow_commands command
      join public.workflow_operations operation on operation.id = command.operation_id
      left join public.broadcast_targets target on target.id = command.broadcast_target_id
     where command.account_id = p_account_id
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and command.available_at <= now()
       and (command.broadcast_target_id is null or target.preparation_status = 'READY')
       and not exists (
         select 1 from public.workflow_commands earlier_command
         join public.broadcast_targets earlier_target on earlier_target.id = earlier_command.broadcast_target_id
          where target.operation_id is not null and earlier_target.operation_id = target.operation_id
            and earlier_target.sequence_number < target.sequence_number
            and earlier_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
     order by operation.created_at, coalesce(target.sequence_number, 0), command.created_at, command.id
     for update of command skip locked limit 1
  )
  update public.workflow_commands command
     set status = 'CLAIMED', lease_owner = p_lease_owner, fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds)
    from candidate where command.id = candidate.id
  returning command.id, command.operation_id, command.account_id, command.kind, command.target_id, command.payload, command.fencing_token, command.lease_until;
end;
$$;

comment on function public.claim_next_broadcast_preparation(uuid, uuid, bigint)
  is 'Claims one queued Grup LPM preparation only for the fenced account-lease owner.';
comment on function public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer)
  is 'Persists CHECKING/JOINING/READY/retry/final preparation state under account fencing.';
revoke all on function public.claim_next_broadcast_preparation(uuid, uuid, bigint) from public;
revoke all on function public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer) from public;
