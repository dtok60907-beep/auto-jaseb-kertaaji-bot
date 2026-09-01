-- D6: engine account discovery (list_broadcast_runtime_accounts) was scoped
-- entirely to Jasa Sebar (broadcast_targets / workflow_commands), so an
-- account whose only pending work was Auto Komen -- channel-target
-- resolution or a keyword-matching poll -- was never scheduled at all.
-- The engine's per-account drain loop already knows how to do this work
-- (wired in an earlier D6 migration/commit); it just never got called.

create view public.auto_comment_runtime_eligible_targets
with (security_invoker = true)
as
select target.id as channel_target_id,
       target.user_id,
       target.account_id,
       target.resolution_status,
       target.resolution_available_at,
       target.monitoring_available_at,
       exists (
         select 1 from public.auto_comment_division_channels mapping
          where mapping.channel_target_id = target.id
       ) as has_division
  from public.auto_comment_channel_targets target
  join public.telegram_accounts account on account.id = target.account_id
 where target.active
   and account.status = 'READY'
   and exists (
     select 1 from public.entitlements entitlement
      where entitlement.user_id = target.user_id
        and entitlement.status = 'ACTIVE'
        and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = 'USERBOT'
        and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
   )
   and exists (
     select 1 from public.userbot_profiles profile
      where profile.user_id = target.user_id
        and profile.status = 'CONNECTED'
        and profile.active_account_id = target.account_id
   );

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
  all_work as (
    select * from preparation_work
    union all select * from delivery_work
    union all select * from preparation_recovery
    union all select * from delivery_recovery
    union all select * from auto_comment_preparation_work
    union all select * from auto_comment_monitoring_work
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

-- Wake the engine immediately when a channel target's resolution/monitoring
-- schedule changes, the same way broadcast_targets already does.
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
    if tg_op <> 'INSERT' and old.kind in ('SEND_TEXT', 'FORWARD_MESSAGE') then old_account_id := old.account_id; end if;
    if tg_op <> 'DELETE' and new.kind in ('SEND_TEXT', 'FORWARD_MESSAGE') then new_account_id := new.account_id; end if;
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

create trigger auto_comment_channel_targets_runtime_wakeup
after insert or delete or update of active, resolution_status, resolution_available_at, monitoring_available_at
on public.auto_comment_channel_targets
for each row execute function public.notify_broadcast_runtime_account();

comment on view public.auto_comment_runtime_eligible_targets
  is 'Server-only eligibility projection mirroring broadcast_runtime_eligible_operations, scoped to Auto Komen channel targets.';
comment on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer)
  is 'Lists safe due/future Jasa Sebar and Auto Komen account metadata for one shard; never returns session ciphertext.';

revoke all on public.auto_comment_runtime_eligible_targets from public;
