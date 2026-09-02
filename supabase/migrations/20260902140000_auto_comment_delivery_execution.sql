-- D6 slice 2: actually send an approved (Tepat) or auto-queued comment.
--
-- The claim side (claim_next_workflow_command) already existed, dedicated to
-- COMMENT_TEXT specifically so it can never steal a Jasa Sebar command from
-- claim_next_broadcast_command on a shared Userbot account -- it just never
-- had an engine executor calling it, and never returned attempt_count for
-- retry backoff. The finish side (finish_claimed_workflow_command) existed
-- too, but only ever touched workflow_commands: a candidate's own status
-- never advanced past COMMENT_QUEUED once its command actually finished, and
-- there was no retry/receipt handling at all. Both are extended in place --
-- neither had any real caller yet, so this is not a breaking change.
--
-- The engine also never discovered an account whose only work was a queued
-- COMMENT_TEXT command: list_broadcast_runtime_accounts and the runtime
-- wake-up trigger were scoped to Jasa Sebar and (as of the previous
-- migration) Auto Komen preparation/monitoring, but not delivery.

-- The return row shape gains attempt_count (needed for retry backoff), which
-- create or replace cannot do in place.
drop function if exists public.claim_next_workflow_command(uuid, uuid, bigint, integer);

create function public.claim_next_workflow_command(
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
begin
  if p_command_lease_seconds not between 1 and 3600 then raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_LEASE_DURATION'; end if;
  if not exists (select 1 from public.account_leases account_lease where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now()) then raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD'; end if;

  update public.workflow_commands command
     set status = 'SIDE_EFFECT_UNCERTAIN', lease_until = null,
         last_error_code = case when command.lease_until <= now() then 'COMMAND_LEASE_EXPIRED' else 'ACCOUNT_LEASE_FENCED' end,
         outcome_checked_at = now()
   where command.account_id = p_account_id and command.kind = 'COMMENT_TEXT'
     and command.status in ('CLAIMED', 'SENDING')
     and (command.lease_until <= now() or command.lease_owner is distinct from p_lease_owner or command.fencing_token is distinct from p_account_fencing_token);

  return query
  with candidate_command as (
    select command.id
      from public.workflow_commands command
      join public.workflow_operations operation on operation.id = command.operation_id
      left join public.auto_comment_candidates comment_candidate on comment_candidate.id = command.auto_comment_candidate_id
      left join public.auto_comment_channel_targets channel_target on channel_target.id = comment_candidate.channel_target_id
     where command.account_id = p_account_id and command.kind = 'COMMENT_TEXT'
       and operation.operation_type = 'AUTO_COMMENT'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       and command.status in ('PENDING', 'FAILED_RETRYABLE') and command.available_at <= now()
       and channel_target.resolution_status = 'READY' and channel_target.active
       and channel_target.account_id = command.account_id
       and exists (
         select 1 from public.entitlements entitlement
          where entitlement.user_id = operation.user_id and entitlement.status = 'ACTIVE'
            and entitlement.expires_at > now()
            and entitlement.package_snapshot->>'packageType' = 'USERBOT'
            and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
       )
       and exists (
         select 1 from public.userbot_profiles profile
          where profile.user_id = operation.user_id and profile.status = 'CONNECTED'
            and profile.active_account_id = command.account_id
       )
     order by operation.created_at, command.created_at, command.id
     for update of command skip locked limit 1
  )
  update public.workflow_commands command
     set status = 'CLAIMED', lease_owner = p_lease_owner, fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds), attempt_count = command.attempt_count + 1
    from candidate_command where command.id = candidate_command.id
  returning command.id, command.operation_id, command.account_id, command.kind, command.target_id, command.payload, command.attempt_count, command.fencing_token, command.lease_until;
end;
$$;

-- The parameter list grows (retry/receipt handling), which is a different
-- signature to Postgres even with new params defaulted, so replace in place.
drop function if exists public.finish_claimed_workflow_command(uuid, uuid, uuid, bigint, text, text);

create function public.finish_claimed_workflow_command(
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
  v_candidate_id uuid;
  v_operation_id uuid;
  finished boolean;
begin
  if p_status not in ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN') then
    raise exception using errcode = 'P0001', message = 'INVALID_COMMENT_FINISH_STATUS';
  end if;
  if p_status = 'SUCCEEDED' then
    if p_error_code is not null or p_retry_after_seconds is not null or p_provider_sent_at is null
       or p_provider_message_ids is null or cardinality(p_provider_message_ids) not between 1 and 100
       or exists (select 1 from unnest(p_provider_message_ids) as ids(message_id) where btrim(coalesce(message_id, '')) = '')
       or cardinality(p_provider_message_ids) <> (select count(distinct message_id) from unnest(p_provider_message_ids) as ids(message_id)) then
      raise exception using errcode = 'P0001', message = 'INVALID_COMMENT_RECEIPT';
    end if;
  elsif p_status = 'FAILED_RETRYABLE' then
    if btrim(coalesce(p_error_code, '')) = '' or p_retry_after_seconds not between 1 and 2147483647
       or p_provider_message_ids is not null or p_provider_sent_at is not null then
      raise exception using errcode = 'P0001', message = 'INVALID_COMMENT_RETRY';
    end if;
  elsif btrim(coalesce(p_error_code, '')) = '' or p_retry_after_seconds is not null
        or p_provider_message_ids is not null or p_provider_sent_at is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_COMMENT_FAILURE';
  end if;

  select command.auto_comment_candidate_id, command.operation_id
    into v_candidate_id, v_operation_id
    from public.workflow_commands command
   where command.id = p_command_id and command.account_id = p_account_id
     and command.kind = 'COMMENT_TEXT' and command.status = 'CLAIMED'
     and command.lease_owner = p_lease_owner and command.fencing_token = p_account_fencing_token
     and exists (
       select 1 from public.account_leases account_lease
        where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner
          and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now()
     )
   for update of command;
  if not found then return false; end if;

  update public.workflow_commands command
     set status = p_status, lease_owner = null, lease_until = null,
         last_error_code = p_error_code, outcome_checked_at = now(),
         available_at = case when p_status = 'FAILED_RETRYABLE' then now() + make_interval(secs => p_retry_after_seconds) else command.available_at end,
         retry_after = case when p_status = 'FAILED_RETRYABLE' then now() + make_interval(secs => p_retry_after_seconds) else null end,
         provider_message_id = case when p_status = 'SUCCEEDED' then p_provider_message_ids[1] else command.provider_message_id end,
         provider_message_ids = case when p_status = 'SUCCEEDED' then p_provider_message_ids else command.provider_message_ids end,
         provider_sent_at = case when p_status = 'SUCCEEDED' then p_provider_sent_at else command.provider_sent_at end
   where command.id = p_command_id
  returning true into finished;

  update public.auto_comment_candidates candidate
     set status = case p_status
           when 'SUCCEEDED' then 'COMMENT_SENT'
           when 'FAILED_FINAL' then 'COMMENT_FAILED'
           when 'SIDE_EFFECT_UNCERTAIN' then 'SIDE_EFFECT_UNCERTAIN'
           else candidate.status
         end,
         error_code = case when p_status in ('FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN') then p_error_code else candidate.error_code end
   where candidate.id = v_candidate_id
     and p_status in ('SUCCEEDED', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN');

  update public.workflow_operations operation
     set status = p_status,
         error_code = case when p_status <> 'SUCCEEDED' then p_error_code else null end
   where operation.id = v_operation_id;

  return coalesce(finished, false);
end;
$$;

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
  auto_comment_preparation_work as (
    select eligible.account_id,
           'USERBOT'::text as account_type,
           eligible.resolution_available_at as due_at,
           true as is_preparation,
           false as is_delivery,
           false as is_recovery
      from public.auto_comment_runtime_eligible_targets eligible
     where eligible.resolution_status in ('QUEUED', 'NEEDS_REVALIDATION', 'WAITING_APPROVAL')
  ),
  auto_comment_monitoring_work as (
    select eligible.account_id,
           'USERBOT'::text as account_type,
           eligible.monitoring_available_at as due_at,
           true as is_preparation,
           false as is_delivery,
           false as is_recovery
      from public.auto_comment_runtime_eligible_targets eligible
     where eligible.resolution_status = 'READY'
       and eligible.has_division
  ),
  auto_comment_delivery_work as (
    select command.account_id,
           'USERBOT'::text as account_type,
           command.available_at as due_at,
           false as is_preparation,
           true as is_delivery,
           false as is_recovery
      from public.workflow_commands command
      join public.auto_comment_candidates candidate on candidate.id = command.auto_comment_candidate_id
      join public.auto_comment_runtime_eligible_targets eligible on eligible.channel_target_id = candidate.channel_target_id
     where command.kind = 'COMMENT_TEXT'
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and eligible.resolution_status = 'READY'
  ),
  auto_comment_delivery_recovery as (
    select command.account_id,
           'USERBOT'::text as account_type,
           now() as due_at,
           false as is_preparation,
           true as is_delivery,
           true as is_recovery
      from public.workflow_commands command
      join public.telegram_accounts account on account.id = command.account_id
     where command.kind = 'COMMENT_TEXT'
       and account.status = 'READY'
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
    union all select * from auto_comment_preparation_work
    union all select * from auto_comment_monitoring_work
    union all select * from auto_comment_delivery_work
    union all select * from auto_comment_delivery_recovery
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

create or replace function public.notify_broadcast_runtime_account()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  old_account_id uuid;
  new_account_id uuid;
begin
  if tg_table_name = 'workflow_commands' then
    if tg_op <> 'INSERT' and old.kind in ('SEND_TEXT', 'FORWARD_MESSAGE', 'COMMENT_TEXT') then old_account_id := old.account_id; end if;
    if tg_op <> 'DELETE' and new.kind in ('SEND_TEXT', 'FORWARD_MESSAGE', 'COMMENT_TEXT') then new_account_id := new.account_id; end if;
  elsif tg_table_name = 'broadcast_targets' then
    if tg_op <> 'INSERT' then select account_id into old_account_id from public.workflow_operations where id = old.operation_id; end if;
    if tg_op <> 'DELETE' then select account_id into new_account_id from public.workflow_operations where id = new.operation_id; end if;
  elsif tg_table_name = 'telegram_accounts' then
    if tg_op <> 'INSERT' then old_account_id := old.id; end if;
    if tg_op <> 'DELETE' then new_account_id := new.id; end if;
  elsif tg_table_name = 'auto_comment_channel_targets' then
    if tg_op <> 'INSERT' then old_account_id := old.account_id; end if;
    if tg_op <> 'DELETE' then new_account_id := new.account_id; end if;
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

comment on function public.claim_next_workflow_command(uuid, uuid, bigint, integer)
  is 'Claims one due Auto Komen COMMENT_TEXT command under active entitlement plus account lease/fencing; never claims a Jasa Sebar command.';
comment on function public.finish_claimed_workflow_command(uuid, uuid, uuid, bigint, text, text, integer, text[], timestamptz)
  is 'Atomically persists a COMMENT_TEXT delivery outcome and advances the owning candidate (COMMENT_SENT/COMMENT_FAILED/SIDE_EFFECT_UNCERTAIN) and operation to match.';
comment on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer)
  is 'Lists safe due/future Jasa Sebar and Auto Komen (preparation, monitoring, delivery) account metadata for one shard; never returns session ciphertext.';

revoke all on function public.claim_next_workflow_command(uuid, uuid, bigint, integer) from public;
revoke all on function public.finish_claimed_workflow_command(uuid, uuid, uuid, bigint, text, text, integer, text[], timestamptz) from public;
revoke all on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer) from public;
