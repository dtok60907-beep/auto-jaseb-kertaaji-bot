-- A Telegram join request is a durable waiting state, not a final failure.
-- Waiting rows are polled through PostgreSQL scheduling and never keep an
-- in-memory timer or an account lease between checks.

alter table public.broadcast_targets
  drop constraint broadcast_targets_preparation_status_check,
  add constraint broadcast_targets_preparation_status_check
    check (preparation_status in ('QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL', 'READY', 'FAILED_FINAL')),
  add column preparation_approval_requested_at timestamptz;

drop index public.broadcast_targets_preparation_claim_idx;
create index broadcast_targets_preparation_claim_idx
  on public.broadcast_targets (preparation_available_at, created_at)
  where preparation_status in ('QUEUED', 'WAITING_APPROVAL');

drop function public.claim_next_broadcast_preparation(uuid, uuid, bigint);
create function public.claim_next_broadcast_preparation(
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
      join public.workflow_operations operation on operation.id = target.operation_id
     where operation.account_id = p_account_id
       and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       and target.preparation_status in ('QUEUED', 'WAITING_APPROVAL')
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
  returning target.id, target.operation_id, target.telegram_target_ref, candidate.previous_status;
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
     or p_status not in ('QUEUED', 'JOINING', 'WAITING_APPROVAL', 'READY', 'FAILED_FINAL')
     or (p_expected_status = 'JOINING' and p_status = 'JOINING') then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_TRANSITION';
  end if;
  if p_status in ('QUEUED', 'WAITING_APPROVAL')
     and (p_retry_after_seconds is null or p_retry_after_seconds not between 1 and 86400) then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_RETRY';
  end if;
  if p_status not in ('QUEUED', 'WAITING_APPROVAL') and p_retry_after_seconds is not null then
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
         preparation_available_at = case
           when p_status in ('QUEUED', 'WAITING_APPROVAL') then now() + make_interval(secs => p_retry_after_seconds)
           else target.preparation_available_at
         end,
         preparation_lease_owner = case when p_status = 'JOINING' then p_lease_owner else null end,
         preparation_fencing_token = case when p_status = 'JOINING' then p_account_fencing_token else null end,
         preparation_approval_requested_at = case
           when p_status = 'WAITING_APPROVAL' then coalesce(target.preparation_approval_requested_at, now())
           else target.preparation_approval_requested_at
         end,
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

  if exists (
    select 1 from public.broadcast_targets
     where operation_id = operation_id_value and preparation_status = 'QUEUED'
  ) then
    update public.workflow_operations set status = 'QUEUED' where id = operation_id_value;
  elsif exists (
    select 1 from public.broadcast_targets
     where operation_id = operation_id_value and preparation_status in ('CHECKING', 'JOINING')
  ) then
    update public.workflow_operations set status = case when p_status = 'JOINING' then 'JOINING' else 'CHECKING' end
     where id = operation_id_value;
  elsif exists (
    select 1 from public.broadcast_targets
     where operation_id = operation_id_value and preparation_status = 'WAITING_APPROVAL'
  ) then
    update public.workflow_operations set status = 'WAITING_APPROVAL' where id = operation_id_value;
  else
    update public.workflow_operations operation
       set status = case when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = operation_id_value and target.preparation_status = 'READY'
       ) then 'READY' else 'FAILED_FINAL' end
     where operation.id = operation_id_value;
  end if;
  return true;
end;
$$;

comment on column public.broadcast_targets.preparation_approval_requested_at
  is 'First observed Telegram join-request time; retained while membership is polled.';
comment on function public.claim_next_broadcast_preparation(uuid, uuid, bigint)
  is 'Claims a new or approval-waiting Grup LPM preparation under the fenced account lease.';
comment on function public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer)
  is 'Persists Grup LPM preparation including non-final WAITING_APPROVAL under account fencing.';
revoke all on function public.claim_next_broadcast_preparation(uuid, uuid, bigint) from public;
