-- Commands are only claimable by the runtime that currently owns the account
-- lease. A crashed command is deliberately marked SIDE_EFFECT_UNCERTAIN rather
-- than retried automatically, because Telegram may already have accepted it.

create or replace function public.claim_next_workflow_command(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_command_lease_seconds integer
)
returns table (
  command_id uuid,
  operation_id uuid,
  account_id uuid,
  kind text,
  target_id text,
  payload jsonb,
  fencing_token bigint,
  lease_until timestamptz
)
language plpgsql
set search_path = public
as $$
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

  update public.workflow_commands command
     set status = 'SIDE_EFFECT_UNCERTAIN',
         lease_until = null,
         last_error_code = case when command.lease_until <= now() then 'COMMAND_LEASE_EXPIRED' else 'ACCOUNT_LEASE_FENCED' end,
         outcome_checked_at = now()
   where command.account_id = p_account_id
     and command.status in ('CLAIMED', 'SENDING')
     and (
       command.lease_until <= now()
       or command.lease_owner is distinct from p_lease_owner
       or command.fencing_token is distinct from p_account_fencing_token
     );

  return query
  with candidate as (
    select command.id
      from public.workflow_commands command
      join public.workflow_operations operation on operation.id = command.operation_id
      left join public.broadcast_targets target on target.id = command.broadcast_target_id
     where command.account_id = p_account_id
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and command.available_at <= now()
       and not exists (
         select 1
           from public.workflow_commands earlier_command
           join public.broadcast_targets earlier_target on earlier_target.id = earlier_command.broadcast_target_id
          where target.operation_id is not null
            and earlier_target.operation_id = target.operation_id
            and earlier_target.sequence_number < target.sequence_number
            and earlier_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
     order by operation.created_at, coalesce(target.sequence_number, 0), command.created_at, command.id
     for update of command skip locked
     limit 1
  )
  update public.workflow_commands command
     set status = 'CLAIMED',
         lease_owner = p_lease_owner,
         fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds)
    from candidate
   where command.id = candidate.id
  returning command.id, command.operation_id, command.account_id, command.kind,
            command.target_id, command.payload, command.fencing_token, command.lease_until;
end;
$$;

create or replace function public.finish_claimed_workflow_command(
  p_command_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_status text,
  p_error_code text default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  finished boolean;
begin
  if p_status not in ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED') then
    raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_FINAL_STATUS';
  end if;
  update public.workflow_commands command
     set status = p_status,
         lease_owner = null,
         lease_until = null,
         last_error_code = p_error_code,
         outcome_checked_at = now(),
         provider_sent_at = case when p_status = 'SUCCEEDED' then now() else command.provider_sent_at end
   where command.id = p_command_id
     and command.account_id = p_account_id
     and command.status = 'CLAIMED'
     and command.lease_owner = p_lease_owner
     and command.fencing_token = p_account_fencing_token
     and exists (
       select 1 from public.account_leases account_lease
        where account_lease.account_id = p_account_id
          and account_lease.lease_owner = p_lease_owner
          and account_lease.fencing_token = p_account_fencing_token
          and account_lease.lease_until > now()
     )
  returning true into finished;
  return coalesce(finished, false);
end;
$$;

comment on function public.claim_next_workflow_command(uuid, uuid, bigint, integer)
  is 'Claims one eligible outbox command only when the caller owns the current account lease and fencing token.';
comment on function public.finish_claimed_workflow_command(uuid, uuid, uuid, bigint, text, text)
  is 'Fencing-safe completion: a stale runtime cannot mutate a claimed command after account lease takeover.';

revoke all on function public.claim_next_workflow_command(uuid, uuid, bigint, integer) from public;
revoke all on function public.finish_claimed_workflow_command(uuid, uuid, uuid, bigint, text, text) from public;
