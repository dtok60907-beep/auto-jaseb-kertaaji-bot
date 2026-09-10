-- Compact Jasa Sebar delivery persistence.
--
-- broadcast_targets already is the durable per-destination state and history
-- row. Keeping a second workflow_commands row for every target doubles writes,
-- indexes, retention work, and storage without adding another business fact.
-- After this migration workflow_commands remains the explicit queue for Auto
-- Komen, while Jasa Sebar claims broadcast_targets directly under the same
-- account lease/fencing guarantees.

alter table public.broadcast_targets
  add column delivery_attempt_count integer not null default 0
    check (delivery_attempt_count >= 0),
  add column delivery_lease_owner uuid,
  add column delivery_fencing_token bigint
    check (delivery_fencing_token is null or delivery_fencing_token > 0),
  add column delivery_lease_until timestamptz,
  add column delivery_outcome_checked_at timestamptz;

-- Preserve completed receipts and retry history from the old one-command-per-
-- target representation before those duplicate rows are removed.
update public.broadcast_targets target
   set delivery_attempt_count = greatest(target.delivery_attempt_count, command.attempt_count),
       delivery_lease_owner = command.lease_owner,
       delivery_fencing_token = nullif(command.fencing_token, 0),
       delivery_lease_until = command.lease_until,
       delivery_outcome_checked_at = command.outcome_checked_at,
       next_eligible_at = case
         when command.status = 'FAILED_RETRYABLE' then command.available_at
         else target.next_eligible_at
       end,
       last_success_at = coalesce(target.last_success_at, command.provider_sent_at),
       last_provider_message_id = coalesce(target.last_provider_message_id, command.provider_message_id),
       last_provider_message_ids = case
         when cardinality(target.last_provider_message_ids) > 0 then target.last_provider_message_ids
         else command.provider_message_ids
       end,
       last_error_code = coalesce(target.last_error_code, command.last_error_code)
  from public.workflow_commands command
 where command.broadcast_target_id = target.id;

-- A send that was in flight at the migration boundary cannot be proven sent or
-- unsent. Preserve the conservative uncertainty rule instead of retrying it.
update public.broadcast_targets target
   set delivery_status = 'SIDE_EFFECT_UNCERTAIN',
       last_error_code = 'DELIVERY_MIGRATION_UNCERTAIN',
       delivery_lease_owner = null,
       delivery_fencing_token = null,
       delivery_lease_until = null,
       delivery_outcome_checked_at = now()
  from public.workflow_commands command
 where command.broadcast_target_id = target.id
   and command.status in ('CLAIMED', 'SENDING');

update public.workflow_operations operation
   set status = 'SIDE_EFFECT_UNCERTAIN',
       error_code = 'DELIVERY_MIGRATION_UNCERTAIN'
 where operation.operation_type = 'BROADCAST'
   and exists (
     select 1 from public.broadcast_targets target
      where target.operation_id = operation.id
        and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN'
        and target.last_error_code = 'DELIVERY_MIGRATION_UNCERTAIN'
   );

delete from public.workflow_commands where broadcast_target_id is not null;

alter table public.broadcast_targets
  add constraint broadcast_targets_delivery_lease_shape_check
    check (
      delivery_status <> 'SENDING'
      or num_nonnulls(delivery_lease_owner, delivery_fencing_token, delivery_lease_until) = 3
    ) not valid;
alter table public.broadcast_targets
  validate constraint broadcast_targets_delivery_lease_shape_check;

drop index if exists public.workflow_commands_broadcast_account_runtime_idx;

create index broadcast_targets_delivery_claim_idx
  on public.broadcast_targets (next_eligible_at, operation_id, sequence_number, id)
  where preparation_status = 'READY'
    and delivery_status in ('PENDING', 'FAILED_RETRYABLE');

create index broadcast_targets_delivery_recovery_idx
  on public.broadcast_targets (delivery_lease_until, operation_id, id)
  where delivery_status = 'SENDING';

comment on column public.broadcast_targets.delivery_attempt_count
  is 'Number of fenced Telegram delivery claims for this target; replaces the duplicate broadcast workflow command attempt counter.';
comment on column public.broadcast_targets.delivery_lease_until
  is 'Short delivery lease nested under the account lease; an expired in-flight send becomes SIDE_EFFECT_UNCERTAIN.';

-- Compatibility guard: existing admission functions still contain an INSERT
-- into workflow_commands. Suppress only broadcast rows before storage; Auto
-- Komen COMMENT_TEXT commands are untouched.
create function public.suppress_duplicate_broadcast_command()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.broadcast_target_id is not null then return null; end if;
  return new;
end;
$$;

create trigger workflow_commands_00_suppress_duplicate_broadcast
before insert on public.workflow_commands
for each row execute function public.suppress_duplicate_broadcast_command();

revoke all on function public.suppress_duplicate_broadcast_command() from public;

drop function public.claim_next_broadcast_command(uuid, uuid, bigint, integer);

create function public.claim_next_broadcast_command(
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
  selected_target_id uuid;
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

  update public.broadcast_targets target
     set delivery_status = 'SIDE_EFFECT_UNCERTAIN',
         delivery_lease_owner = null,
         delivery_fencing_token = null,
         delivery_lease_until = null,
         delivery_outcome_checked_at = now(),
         last_error_code = case
           when target.delivery_lease_until is null or target.delivery_lease_until <= now()
             then 'COMMAND_LEASE_EXPIRED'
           else 'ACCOUNT_LEASE_FENCED'
         end
    from public.workflow_operations operation
   where operation.id = target.operation_id
     and operation.account_id = p_account_id
     and operation.operation_type = 'BROADCAST'
     and target.delivery_status = 'SENDING'
     and (
       target.delivery_lease_until is null
       or target.delivery_lease_until <= now()
       or target.delivery_lease_owner is distinct from p_lease_owner
       or target.delivery_fencing_token is distinct from p_account_fencing_token
     );

  update public.workflow_operations operation
     set status = 'SIDE_EFFECT_UNCERTAIN',
         error_code = coalesce((
           select target.last_error_code
             from public.broadcast_targets target
            where target.operation_id = operation.id
              and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN'
            order by target.delivery_outcome_checked_at desc nulls last, target.id
            limit 1
         ), 'COMMAND_LEASE_LOST')
   where operation.account_id = p_account_id
     and operation.operation_type = 'BROADCAST'
     and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     and exists (
       select 1 from public.broadcast_targets target
        where target.operation_id = operation.id
          and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN'
     );

  select target.id into selected_target_id
    from public.broadcast_targets target
    join public.broadcast_runtime_eligible_operations eligible
      on eligible.operation_id = target.operation_id
   where eligible.account_id = p_account_id
     and target.preparation_status = 'READY'
     and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE')
     and (target.next_eligible_at is null or target.next_eligible_at <= now())
     and (eligible.broadcast_next_eligible_at is null or eligible.broadcast_next_eligible_at <= now())
     and (eligible.runtime_retry_at is null or eligible.runtime_retry_at <= now())
     and not exists (
       select 1 from public.broadcast_targets earlier_target
        where earlier_target.operation_id = target.operation_id
          and earlier_target.sequence_number < target.sequence_number
          and earlier_target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
     and not exists (
       select 1
         from public.workflow_operations earlier_operation
         join public.broadcast_targets earlier_target
           on earlier_target.operation_id = earlier_operation.id
        where earlier_operation.account_id = eligible.account_id
          and earlier_operation.operation_type = 'BROADCAST'
          and (earlier_operation.created_at, earlier_operation.id)
              < (eligible.operation_created_at, eligible.operation_id)
          and earlier_target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
   order by eligible.operation_created_at, target.sequence_number, target.created_at, target.id
   for update of target skip locked
   limit 1;
  if not found then return; end if;

  update public.broadcast_targets target
     set delivery_status = 'SENDING',
         delivery_attempt_count = target.delivery_attempt_count + 1,
         delivery_lease_owner = p_lease_owner,
         delivery_fencing_token = p_account_fencing_token,
         delivery_lease_until = now() + make_interval(secs => p_command_lease_seconds),
         last_error_code = null
   where target.id = selected_target_id;

  update public.workflow_operations operation
     set status = 'SENDING', error_code = null
   where operation.id = (
     select target.operation_id from public.broadcast_targets target
      where target.id = selected_target_id
   );

  return query
  select target.id,
         operation.id,
         operation.account_id,
         case operation.payload->'material'->>'kind'
           when 'TEXT' then 'SEND_TEXT'::text
           else 'FORWARD_MESSAGE'::text
         end,
         target.telegram_target_ref,
         jsonb_build_object('material', operation.payload->'material'),
         target.delivery_attempt_count,
         target.delivery_fencing_token,
         target.delivery_lease_until
    from public.broadcast_targets target
    join public.workflow_operations operation on operation.id = target.operation_id
   where target.id = selected_target_id;
end;
$$;

comment on function public.claim_next_broadcast_command(uuid, uuid, bigint, integer)
  is 'Claims one prepared broadcast_targets delivery directly under account lease/fencing; command_id is the target delivery id for executor compatibility.';
revoke all on function public.claim_next_broadcast_command(uuid, uuid, bigint, integer) from public;

create or replace function public.finish_broadcast_command(
  p_command_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_status text,
  p_error_code text default null,
  p_retry_after_seconds integer default null,
  p_provider_message_ids text[] default null,
  p_provider_sent_at timestamptz default null
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  context_row record;
  next_available_at timestamptz;
begin
  if p_status not in ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN') then
    raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_FINISH_STATUS';
  end if;
  if p_status = 'SUCCEEDED' then
    if p_error_code is not null or p_retry_after_seconds is not null or p_provider_sent_at is null
       or p_provider_message_ids is null or cardinality(p_provider_message_ids) not between 1 and 100
       or exists (
         select 1 from unnest(p_provider_message_ids) ids(message_id)
          where btrim(coalesce(message_id, '')) = ''
       )
       or cardinality(p_provider_message_ids) <> (
         select count(distinct message_id) from unnest(p_provider_message_ids) ids(message_id)
       ) then
      raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_RECEIPT';
    end if;
  elsif p_status = 'FAILED_RETRYABLE' then
    if btrim(coalesce(p_error_code, '')) = ''
       or p_retry_after_seconds not between 1 and 2147483647
       or p_provider_message_ids is not null or p_provider_sent_at is not null then
      raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_RETRY';
    end if;
  elsif btrim(coalesce(p_error_code, '')) = ''
     or p_retry_after_seconds is not null
     or p_provider_message_ids is not null
     or p_provider_sent_at is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_FAILURE';
  end if;

  select target.operation_id, target.sequence_number, target.interval_seconds,
         operation.user_id, operation.payload->>'accountMode' as account_mode
    into context_row
    from public.broadcast_targets target
    join public.workflow_operations operation on operation.id = target.operation_id
    join public.telegram_accounts account on account.id = operation.account_id
   where target.id = p_command_id
     and operation.account_id = p_account_id
     and operation.operation_type = 'BROADCAST'
     and target.delivery_status = 'SENDING'
     and target.delivery_lease_owner = p_lease_owner
     and target.delivery_fencing_token = p_account_fencing_token
     and exists (
       select 1 from public.account_leases account_lease
        where account_lease.account_id = p_account_id
          and account_lease.lease_owner = p_lease_owner
          and account_lease.fencing_token = p_account_fencing_token
          and account_lease.lease_until > now()
     )
   for update of target, operation, account;
  if not found then return false; end if;

  next_available_at := case
    when p_status = 'SUCCEEDED' then now() + make_interval(secs => context_row.interval_seconds)
    when p_status = 'FAILED_RETRYABLE' then now() + make_interval(secs => p_retry_after_seconds)
    else null
  end;

  update public.broadcast_targets target
     set delivery_status = p_status,
         delivery_lease_owner = null,
         delivery_fencing_token = null,
         delivery_lease_until = null,
         delivery_outcome_checked_at = now(),
         last_error_code = p_error_code,
         next_eligible_at = next_available_at,
         last_success_at = case
           when p_status = 'SUCCEEDED' then p_provider_sent_at
           else target.last_success_at
         end,
         last_provider_message_id = case
           when p_status = 'SUCCEEDED' then p_provider_message_ids[1]
           else target.last_provider_message_id
         end,
         last_provider_message_ids = case
           when p_status = 'SUCCEEDED' then p_provider_message_ids
           else target.last_provider_message_ids
         end
   where target.id = p_command_id;

  if p_status = 'SUCCEEDED' and context_row.account_mode = 'JASEB_WORKER' then
    update public.worker_assignments
       set status = 'ACTIVE'
     where user_id = context_row.user_id
       and worker_account_id = p_account_id
       and status = 'RESERVED';
  end if;

  if p_status = 'SUCCEEDED'
     or (p_status = 'FAILED_RETRYABLE' and p_error_code = 'FLOOD_WAIT') then
    update public.telegram_accounts
       set broadcast_next_eligible_at = next_available_at
     where id = p_account_id;
  end if;

  update public.workflow_operations operation
     set status = case
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'SIDE_EFFECT_UNCERTAIN'
       ) then 'SIDE_EFFECT_UNCERTAIN'
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'SENDING'
       ) then 'SENDING'
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'FAILED_RETRYABLE'
       ) then 'FAILED_RETRYABLE'
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'PENDING'
       ) then 'READY'
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'FAILED_FINAL'
       ) then 'FAILED_FINAL'
       when exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = context_row.operation_id
            and target.delivery_status = 'SUCCEEDED'
       ) then 'SUCCEEDED'
       else 'CANCELLED'
     end,
     error_code = (
       select target.last_error_code
         from public.broadcast_targets target
        where target.operation_id = context_row.operation_id
          and target.delivery_status in (
            'SIDE_EFFECT_UNCERTAIN', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED'
          )
        order by case target.delivery_status
          when 'SIDE_EFFECT_UNCERTAIN' then 1
          when 'FAILED_RETRYABLE' then 2
          when 'FAILED_FINAL' then 3
          else 4
        end, target.delivery_outcome_checked_at desc nulls last, target.id
        limit 1
     )
   where operation.id = context_row.operation_id;
  return true;
end;
$$;

comment on function public.finish_broadcast_command(uuid, uuid, uuid, bigint, text, text, integer, text[], timestamptz)
  is 'Finishes a directly claimed broadcast target and atomically aggregates operation status, interval gating, retry, receipt, and worker activation.';

create or replace function public.list_broadcast_runtime_accounts(
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
  if p_shard_count is null or p_shard_index is null
     or p_shard_count not between 1 and 65536
     or p_shard_index < 0 or p_shard_index >= p_shard_count then
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
    select eligible.account_id, eligible.account_type,
           greatest(target.preparation_available_at,
                    coalesce(eligible.runtime_retry_at, '-infinity'::timestamptz)) due_at,
           true is_preparation, false is_delivery, false is_recovery
      from public.broadcast_runtime_eligible_operations eligible
      join public.broadcast_targets target on target.operation_id = eligible.operation_id
     where target.preparation_status in ('QUEUED', 'WAITING_APPROVAL')
  ),
  delivery_work as (
    select eligible.account_id, eligible.account_type,
           greatest(coalesce(target.next_eligible_at, target.created_at),
                    coalesce(eligible.broadcast_next_eligible_at, '-infinity'::timestamptz),
                    coalesce(eligible.runtime_retry_at, '-infinity'::timestamptz)) due_at,
           false is_preparation, true is_delivery, false is_recovery
      from public.broadcast_runtime_eligible_operations eligible
      join public.broadcast_targets target on target.operation_id = eligible.operation_id
     where target.preparation_status = 'READY'
       and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE')
       and not exists (
         select 1 from public.broadcast_targets earlier_target
          where earlier_target.operation_id = target.operation_id
            and earlier_target.sequence_number < target.sequence_number
            and earlier_target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
       and not exists (
         select 1
           from public.workflow_operations earlier_operation
           join public.broadcast_targets earlier_target on earlier_target.operation_id = earlier_operation.id
          where earlier_operation.account_id = eligible.account_id
            and earlier_operation.operation_type = 'BROADCAST'
            and (earlier_operation.created_at, earlier_operation.id)
                < (eligible.operation_created_at, eligible.operation_id)
            and earlier_target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
       )
  ),
  preparation_recovery as (
    select operation.account_id, account.account_type, now() due_at,
           true is_preparation, false is_delivery, true is_recovery
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
    select operation.account_id, account.account_type, now() due_at,
           false is_preparation, true is_delivery, true is_recovery
      from public.broadcast_targets target
      join public.workflow_operations operation on operation.id = target.operation_id
      join public.telegram_accounts account on account.id = operation.account_id
     where operation.operation_type = 'BROADCAST'
       and account.status = 'READY'
       and target.delivery_status = 'SENDING'
       and (
         target.delivery_lease_until is null
         or target.delivery_lease_until <= now()
         or not exists (
           select 1 from public.account_leases account_lease
            where account_lease.account_id = operation.account_id
              and account_lease.lease_owner = target.delivery_lease_owner
              and account_lease.fencing_token = target.delivery_fencing_token
              and account_lease.lease_until > now()
         )
       )
  ),
  auto_comment_preparation_work as (
    select eligible.account_id, 'USERBOT'::text account_type,
           eligible.resolution_available_at due_at,
           true is_preparation, false is_delivery, false is_recovery
      from public.auto_comment_runtime_eligible_targets eligible
     where eligible.resolution_status in ('QUEUED', 'NEEDS_REVALIDATION', 'WAITING_APPROVAL')
  ),
  auto_comment_delivery_work as (
    select command.account_id, 'USERBOT'::text account_type, command.available_at due_at,
           false is_preparation, true is_delivery, false is_recovery
      from public.workflow_commands command
      join public.auto_comment_candidates candidate on candidate.id = command.auto_comment_candidate_id
      join public.auto_comment_runtime_eligible_targets eligible
        on eligible.channel_target_id = candidate.channel_target_id
     where command.kind = 'COMMENT_TEXT'
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and eligible.resolution_status = 'READY'
  ),
  auto_comment_delivery_recovery as (
    select command.account_id, 'USERBOT'::text account_type, now() due_at,
           false is_preparation, true is_delivery, true is_recovery
      from public.workflow_commands command
      join public.telegram_accounts account on account.id = command.account_id
     where command.kind = 'COMMENT_TEXT'
       and account.status = 'READY'
       and command.status in ('CLAIMED', 'SENDING')
       and (
         command.lease_until is null or command.lease_until <= now()
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
    union all select * from auto_comment_preparation_work
    union all select * from auto_comment_delivery_work
    union all select * from auto_comment_delivery_recovery
  )
  select work.account_id, work.account_type, min(work.due_at),
         bool_or(work.is_preparation), bool_or(work.is_delivery), bool_or(work.is_recovery)
    from all_work work
   where work.due_at <= p_due_before
     and public.runtime_shard_index(work.account_id, p_shard_count) = p_shard_index
   group by work.account_id, work.account_type
   order by min(work.due_at), work.account_id
   limit p_limit;
end;
$$;

comment on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer)
  is 'Discovers compact Jasa Sebar target deliveries plus Auto Komen commands; returns safe account metadata only.';

create or replace function public.deactivate_lapsed_user_operations(
  p_user_id uuid,
  p_error_code text,
  p_at timestamptz default now()
)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.userbot_profiles profile set status = 'DISCONNECTED', updated_at = p_at
   where profile.user_id = p_user_id and profile.status = 'CONNECTED'
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = 'USERBOT'
     );

  update public.worker_assignments assignment
     set status = 'RELEASED', released_at = p_at, updated_at = p_at
   where assignment.user_id = p_user_id and assignment.status in ('RESERVED', 'ACTIVE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = 'JASEB_WORKER'
     );

  update public.broadcast_targets target
     set delivery_status = 'CANCELLED', last_error_code = p_error_code,
         delivery_outcome_checked_at = p_at
    from public.workflow_operations operation
   where operation.id = target.operation_id and operation.user_id = p_user_id
     and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = operation.payload->>'accountMode'
     );

  update public.workflow_commands command
     set status = 'CANCELLED', last_error_code = p_error_code, outcome_checked_at = p_at
    from public.workflow_operations operation
   where operation.id = command.operation_id and operation.user_id = p_user_id
     and operation.operation_type = 'AUTO_COMMENT'
     and command.status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = 'USERBOT'
     );

  update public.workflow_operations operation
     set status = 'CANCELLED', error_code = p_error_code
   where operation.user_id = p_user_id
     and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     and (
       (operation.operation_type = 'BROADCAST' and not exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = operation.id
            and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE', 'SENDING')
       ))
       or
       (operation.operation_type = 'AUTO_COMMENT' and not exists (
         select 1 from public.workflow_commands command
          where command.operation_id = operation.id
            and command.status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED', 'SENDING')
       ))
     )
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = case
            when operation.operation_type = 'AUTO_COMMENT' then 'USERBOT'
            else operation.payload->>'accountMode'
          end
     );
end;
$$;

comment on function public.deactivate_lapsed_user_operations(uuid, text, timestamptz)
  is 'Cancels compact broadcast target deliveries and Auto Komen commands when entitlement lapses, while preserving in-flight uncertainty protection.';

revoke all on function public.deactivate_lapsed_user_operations(uuid, text, timestamptz) from public;
