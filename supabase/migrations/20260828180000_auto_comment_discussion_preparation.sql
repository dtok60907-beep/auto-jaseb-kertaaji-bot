-- Resolve and join the linked discussion before monitoring or comment delivery.
-- Approval waiting is durable and periodically rechecked without holding an
-- account lease between checks.

alter table public.auto_comment_channel_targets
  drop constraint auto_comment_channel_targets_resolution_status_check,
  add constraint auto_comment_channel_targets_resolution_status_check
    check (resolution_status in ('QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL', 'READY', 'NEEDS_REVALIDATION', 'FAILED_FINAL')),
  drop constraint auto_comment_channel_targets_check,
  add constraint auto_comment_channel_targets_discussion_state_check
    check (resolution_status not in ('JOINING', 'WAITING_APPROVAL', 'READY') or discussion_target_ref is not null),
  add column resolution_available_at timestamptz not null default now(),
  add column resolution_attempt_count integer not null default 0 check (resolution_attempt_count >= 0),
  add column resolution_lease_owner uuid,
  add column resolution_fencing_token bigint check (resolution_fencing_token is null or resolution_fencing_token > 0),
  add column resolution_approval_requested_at timestamptz;

create index auto_comment_channel_targets_resolution_claim_idx
  on public.auto_comment_channel_targets (resolution_available_at, created_at)
  where active and resolution_status in ('QUEUED', 'NEEDS_REVALIDATION', 'WAITING_APPROVAL');

create or replace function public.reset_auto_comment_resolution_schedule()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.account_id is distinct from old.account_id
     or new.source_channel_ref is distinct from old.source_channel_ref then
    new.resolution_available_at := now();
    new.resolution_lease_owner := null;
    new.resolution_fencing_token := null;
    new.resolution_approval_requested_at := null;
  end if;
  return new;
end;
$$;

create trigger auto_comment_channel_targets_reset_resolution_schedule
before update of account_id, source_channel_ref on public.auto_comment_channel_targets
for each row execute function public.reset_auto_comment_resolution_schedule();

create function public.claim_next_auto_comment_preparation(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns table (
  channel_target_id uuid,
  source_channel_ref text,
  discussion_target_ref text,
  previous_status text
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

  update public.auto_comment_channel_targets target
     set resolution_status = 'NEEDS_REVALIDATION', resolution_available_at = now(),
         resolution_lease_owner = null, resolution_fencing_token = null,
         last_error_code = 'PREPARATION_LEASE_FENCED'
   where target.account_id = p_account_id
     and target.resolution_status in ('CHECKING', 'JOINING')
     and (target.resolution_lease_owner is distinct from p_lease_owner
          or target.resolution_fencing_token is distinct from p_account_fencing_token);

  return query
  with candidate as (
    select target.id, target.resolution_status as previous_status
      from public.auto_comment_channel_targets target
     where target.account_id = p_account_id
       and target.active
       and target.resolution_status in ('QUEUED', 'NEEDS_REVALIDATION', 'WAITING_APPROVAL')
       and target.resolution_available_at <= now()
     order by target.created_at, target.id
     for update of target skip locked
     limit 1
  )
  update public.auto_comment_channel_targets target
     set resolution_status = 'CHECKING',
         resolution_attempt_count = target.resolution_attempt_count + 1,
         resolution_lease_owner = p_lease_owner,
         resolution_fencing_token = p_account_fencing_token,
         last_error_code = null
    from candidate
   where target.id = candidate.id
  returning target.id, target.source_channel_ref, target.discussion_target_ref, candidate.previous_status;
end;
$$;

create function public.transition_auto_comment_preparation(
  p_channel_target_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_expected_status text,
  p_status text,
  p_discussion_target_ref text default null,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare transitioned boolean;
begin
  if p_expected_status not in ('CHECKING', 'JOINING')
     or p_status not in ('QUEUED', 'JOINING', 'WAITING_APPROVAL', 'READY', 'FAILED_FINAL')
     or (p_expected_status = 'JOINING' and p_status = 'JOINING') then
    raise exception using errcode = 'P0001', message = 'INVALID_PREPARATION_TRANSITION';
  end if;
  if p_status in ('JOINING', 'WAITING_APPROVAL', 'READY')
     and nullif(btrim(coalesce(p_discussion_target_ref, '')), '') is null then
    raise exception using errcode = 'P0001', message = 'DISCUSSION_TARGET_REQUIRED';
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

  update public.auto_comment_channel_targets target
     set resolution_status = p_status,
         discussion_target_ref = coalesce(p_discussion_target_ref, target.discussion_target_ref),
         resolution_available_at = case
           when p_status in ('QUEUED', 'WAITING_APPROVAL') then now() + make_interval(secs => p_retry_after_seconds)
           else target.resolution_available_at
         end,
         resolution_lease_owner = case when p_status = 'JOINING' then p_lease_owner else null end,
         resolution_fencing_token = case when p_status = 'JOINING' then p_account_fencing_token else null end,
         resolution_approval_requested_at = case
           when p_status = 'WAITING_APPROVAL' then coalesce(target.resolution_approval_requested_at, now())
           else target.resolution_approval_requested_at
         end,
         last_error_code = p_error_code
   where target.id = p_channel_target_id
     and target.account_id = p_account_id
     and target.resolution_status = p_expected_status
     and target.resolution_lease_owner = p_lease_owner
     and target.resolution_fencing_token = p_account_fencing_token
  returning true into transitioned;
  if not coalesce(transitioned, false) then return false; end if;

  if p_status = 'FAILED_FINAL' then
    update public.workflow_commands command
       set status = 'FAILED_FINAL', last_error_code = p_error_code
      from public.auto_comment_candidates candidate
     where candidate.channel_target_id = p_channel_target_id
       and command.auto_comment_candidate_id = candidate.id
       and command.status in ('PENDING', 'FAILED_RETRYABLE');
    update public.workflow_operations operation
       set status = 'FAILED_FINAL', error_code = p_error_code
     where exists (
       select 1
         from public.workflow_commands command
         join public.auto_comment_candidates candidate on candidate.id = command.auto_comment_candidate_id
        where candidate.channel_target_id = p_channel_target_id
          and command.operation_id = operation.id
          and command.status = 'FAILED_FINAL'
     );
    update public.auto_comment_candidates
       set status = 'COMMENT_FAILED', error_code = p_error_code
     where channel_target_id = p_channel_target_id and status = 'COMMENT_QUEUED';
  end if;
  return true;
end;
$$;

create or replace function public.require_ready_auto_comment_target()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'REJECTED' and not exists (
    select 1 from public.auto_comment_channel_targets target
     where target.id = new.channel_target_id
       and target.active
       and target.resolution_status = 'READY'
  ) then
    raise exception using errcode = '23514', message = 'auto comment target is not ready';
  end if;
  return new;
end;
$$;

create trigger auto_comment_candidates_require_ready_target
before insert on public.auto_comment_candidates
for each row execute function public.require_ready_auto_comment_target();

-- Broadcast commands still require prepared LPM targets. Candidate-based comment
-- commands additionally stop when their channel/discussion needs revalidation.
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
  with candidate_command as (
    select command.id
      from public.workflow_commands command
      join public.workflow_operations operation on operation.id = command.operation_id
      left join public.broadcast_targets target on target.id = command.broadcast_target_id
      left join public.auto_comment_candidates comment_candidate on comment_candidate.id = command.auto_comment_candidate_id
      left join public.auto_comment_channel_targets channel_target on channel_target.id = comment_candidate.channel_target_id
     where command.account_id = p_account_id
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and command.available_at <= now()
       and (command.broadcast_target_id is null or target.preparation_status = 'READY')
       and (command.auto_comment_candidate_id is null or (
         channel_target.resolution_status = 'READY'
         and channel_target.active
         and channel_target.account_id = command.account_id
       ))
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
    from candidate_command where command.id = candidate_command.id
  returning command.id, command.operation_id, command.account_id, command.kind, command.target_id, command.payload, command.fencing_token, command.lease_until;
end;
$$;

comment on function public.claim_next_auto_comment_preparation(uuid, uuid, bigint)
  is 'Claims one linked-discussion preparation under the fenced Userbot account lease.';
comment on function public.transition_auto_comment_preparation(uuid, uuid, uuid, bigint, text, text, text, text, integer)
  is 'Persists linked-discussion resolve/join/approval states under account fencing.';
revoke all on function public.claim_next_auto_comment_preparation(uuid, uuid, bigint) from public;
revoke all on function public.transition_auto_comment_preparation(uuid, uuid, uuid, bigint, text, text, text, text, integer) from public;
