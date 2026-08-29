-- F4: production Jasa Sebar execution state. This is forward-only: existing
-- commands and assignments are preserved, then normalized before new guards.

alter table public.worker_assignments
  add column user_id uuid references auth.users(id) on delete cascade;

update public.worker_assignments assignment
   set user_id = operation.user_id
  from public.workflow_operations operation
 where operation.id = assignment.operation_id;

-- A legacy user may have consumed more than one worker through separate
-- operations. Retain the oldest assignment and release the extras safely.
with ranked as (
  select id, row_number() over (partition by user_id order by assigned_at, id) as position
    from public.worker_assignments
   where status in ('RESERVED', 'ACTIVE')
)
update public.worker_assignments assignment
   set status = 'RELEASED', released_at = coalesce(assignment.released_at, now())
  from ranked
 where assignment.id = ranked.id and ranked.position > 1;

alter table public.worker_assignments alter column user_id set not null;
create unique index worker_assignments_one_active_user_idx
  on public.worker_assignments (user_id) where status in ('RESERVED', 'ACTIVE');
create index worker_assignments_user_status_idx
  on public.worker_assignments (user_id, status, assigned_at desc);

alter table public.workflow_commands
  add column provider_message_ids text[] not null default '{}'::text[]
    check (cardinality(provider_message_ids) between 0 and 100);
update public.workflow_commands
   set provider_message_ids = array[provider_message_id]
 where provider_message_id is not null and cardinality(provider_message_ids) = 0;

alter table public.broadcast_targets
  add column last_provider_message_ids text[] not null default '{}'::text[]
    check (cardinality(last_provider_message_ids) between 0 and 100);
update public.broadcast_targets
   set last_provider_message_ids = array[last_provider_message_id]
 where last_provider_message_id is not null and cardinality(last_provider_message_ids) = 0;

alter table public.telegram_accounts
  add column broadcast_next_eligible_at timestamptz;
create index telegram_accounts_broadcast_due_idx
  on public.telegram_accounts (broadcast_next_eligible_at, id)
  where status = 'READY';

alter table public.broadcast_targets
  add column source_lpm_target_id uuid references public.broadcast_lpm_targets(id) on delete set null;
update public.broadcast_targets target
   set source_lpm_target_id = source.id
  from public.workflow_operations operation, public.broadcast_lpm_targets source
 where operation.id = target.operation_id
   and source.user_id = operation.user_id
   and lower(btrim(source.telegram_target_ref)) = lower(btrim(target.telegram_target_ref));

create or replace function public.validate_worker_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_type_value text;
  operation_type_value text;
  operation_user_id uuid;
begin
  select account_type into account_type_value from public.telegram_accounts where id = new.worker_account_id;
  select operation_type, user_id into operation_type_value, operation_user_id
    from public.workflow_operations where id = new.operation_id;
  if account_type_value is distinct from 'JASEB_WORKER' then
    raise exception using errcode = '23514', message = 'assignment requires a JASEB_WORKER account';
  end if;
  if operation_type_value is distinct from 'BROADCAST' then
    raise exception using errcode = '23514', message = 'worker assignment requires a broadcast operation';
  end if;
  if operation_user_id is distinct from new.user_id then
    raise exception using errcode = '23514', message = 'worker assignment user mismatch';
  end if;
  return new;
end;
$$;

-- Replace admission so a JASEB user reuses the same worker until entitlement
-- expiry instead of consuming a new worker for every broadcast operation.
create or replace function public.create_broadcast_operation(
  p_user_id uuid,
  p_account_mode text,
  p_material_id uuid,
  p_target_ids uuid[],
  p_idempotency_key text
)
returns table (result_status text, operation_id uuid)
language plpgsql
set search_path = public
as $$
declare
  existing_operation_id uuid;
  existing_operation_type text;
  selected_account_id uuid;
  selected_interval_seconds integer;
  existing_worker_assignment boolean := false;
  material_row public.broadcast_materials%rowtype;
  material_snapshot jsonb;
  created_operation_id uuid;
  selected_target_count integer;
begin
  if p_account_mode not in ('JASEB_WORKER', 'USERBOT') then raise exception using errcode = 'P0001', message = 'INVALID_ACCOUNT_MODE'; end if;
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY'; end if;
  if p_target_ids is null or cardinality(p_target_ids) = 0 then raise exception using errcode = 'P0001', message = 'BROADCAST_TARGETS_REQUIRED'; end if;
  if cardinality(p_target_ids) <> (select count(distinct target_id) from unnest(p_target_ids) as target_id) then raise exception using errcode = 'P0001', message = 'DUPLICATE_LPM_TARGET'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key, 1301));
  select id, operation_type into existing_operation_id, existing_operation_type
    from public.workflow_operations where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_operation_type <> 'BROADCAST' then raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_CONFLICT'; end if;
    return query select 'IDEMPOTENT'::text, existing_operation_id;
    return;
  end if;

  if not exists (
    select 1 from public.entitlements entitlement
     where entitlement.user_id = p_user_id and entitlement.status = 'ACTIVE'
       and entitlement.expires_at > now()
       and entitlement.package_snapshot->>'packageType' = p_account_mode
       and entitlement.package_snapshot->'features' ? 'JASEB'
  ) then
    if exists (select 1 from public.entitlements entitlement where entitlement.user_id = p_user_id and entitlement.package_snapshot->>'packageType' = p_account_mode and (entitlement.status = 'EXPIRED' or (entitlement.status = 'ACTIVE' and entitlement.expires_at <= now()))) then
      raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_EXPIRED';
    end if;
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;

  select * into material_row from public.broadcast_materials
   where id = p_material_id and user_id = p_user_id and active for share;
  if not found then raise exception using errcode = 'P0001', message = 'BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE'; end if;

  select count(*) into selected_target_count from public.broadcast_lpm_targets
   where user_id = p_user_id and active and id = any(p_target_ids);
  if selected_target_count <> cardinality(p_target_ids) then raise exception using errcode = 'P0001', message = 'LPM_TARGET_NOT_FOUND_OR_INACTIVE'; end if;

  if p_account_mode = 'USERBOT' then
    select account.id, profile.broadcast_interval_seconds into selected_account_id, selected_interval_seconds
      from public.userbot_profiles profile
      join public.telegram_accounts account on account.id = profile.active_account_id
     where profile.user_id = p_user_id and profile.status = 'CONNECTED'
       and account.owner_user_id = p_user_id and account.account_type = 'USERBOT' and account.status = 'READY'
     for update of profile, account;
    if not found then raise exception using errcode = 'P0001', message = 'USERBOT_NOT_CONNECTED'; end if;
  else
    perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1302));
    select assignment.worker_account_id, setting.interval_seconds
      into selected_account_id, selected_interval_seconds
      from public.worker_assignments assignment
      join public.telegram_accounts account on account.id = assignment.worker_account_id
      join public.worker_account_settings setting on setting.worker_account_id = account.id
     where assignment.user_id = p_user_id and assignment.status in ('RESERVED', 'ACTIVE')
       and account.account_type = 'JASEB_WORKER' and account.status = 'READY' and setting.active
     order by assignment.assigned_at, assignment.id
     for update of assignment, account, setting
     limit 1;
    if found then
      existing_worker_assignment := true;
    else
      select account.id, setting.interval_seconds into selected_account_id, selected_interval_seconds
        from public.worker_account_settings setting
        join public.telegram_accounts account on account.id = setting.worker_account_id
       where setting.active and account.account_type = 'JASEB_WORKER' and account.status = 'READY'
         and not exists (select 1 from public.worker_assignments assignment where assignment.worker_account_id = account.id and assignment.status in ('RESERVED', 'ACTIVE'))
       order by account.created_at, account.id
       for update of account, setting skip locked
       limit 1;
      if not found then raise exception using errcode = 'P0001', message = 'WORKER_UNAVAILABLE'; end if;
    end if;
  end if;

  material_snapshot := case material_row.kind
    when 'TEXT' then jsonb_build_object('id', material_row.id::text, 'kind', 'TEXT', 'text', material_row.text_content)
    else jsonb_build_object(
      'id', material_row.id::text, 'kind', 'FORWARD',
      'source', jsonb_build_object('channelUsername', material_row.forward_channel_username, 'messageId', material_row.forward_message_id, 'canonicalLink', 'https://t.me/' || material_row.forward_channel_username || '/' || material_row.forward_message_id),
      'sourceAttribution', material_row.source_attribution
    )
  end;

  insert into public.workflow_operations (user_id, account_id, operation_type, status, idempotency_key, payload)
  values (p_user_id, selected_account_id, 'BROADCAST', 'QUEUED', p_idempotency_key,
    jsonb_build_object('accountMode', p_account_mode, 'intervalSeconds', selected_interval_seconds, 'material', material_snapshot))
  returning id into created_operation_id;

  if p_account_mode = 'JASEB_WORKER' and not existing_worker_assignment then
    insert into public.worker_assignments (operation_id, worker_account_id, user_id)
    values (created_operation_id, selected_account_id, p_user_id);
  end if;

  insert into public.broadcast_targets (operation_id, telegram_target_ref, interval_seconds, sequence_number, source_lpm_target_id)
  select created_operation_id, target.telegram_target_ref, selected_interval_seconds, requested.ordinality::integer, target.id
    from unnest(p_target_ids) with ordinality as requested(id, ordinality)
    join public.broadcast_lpm_targets target on target.id = requested.id;

  insert into public.workflow_commands (operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id)
  select created_operation_id, selected_account_id,
         case when material_row.kind = 'TEXT' then 'SEND_TEXT' else 'FORWARD_MESSAGE' end,
         target.telegram_target_ref, 'broadcast-command:' || target.id::text,
         jsonb_build_object('material', material_snapshot), target.id
    from public.broadcast_targets target where target.operation_id = created_operation_id;

  return query select 'CREATED'::text, created_operation_id;
end;
$$;

-- Broadcast and Auto Komen use separate claim entry points. The legacy generic
-- entry point remains for COMMENT_TEXT only, preventing either executor from
-- stealing the other workflow type on a shared Userbot account.
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
  returning command.id, command.operation_id, command.account_id, command.kind, command.target_id, command.payload, command.fencing_token, command.lease_until;
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
declare finished boolean;
begin
  if p_status not in ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED') then raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_FINAL_STATUS'; end if;
  update public.workflow_commands command
     set status = p_status, lease_owner = null, lease_until = null,
         last_error_code = p_error_code, outcome_checked_at = now(),
         provider_sent_at = case when p_status = 'SUCCEEDED' then now() else command.provider_sent_at end
   where command.id = p_command_id and command.account_id = p_account_id
     and command.kind = 'COMMENT_TEXT' and command.status = 'CLAIMED'
     and command.lease_owner = p_lease_owner and command.fencing_token = p_account_fencing_token
     and exists (select 1 from public.account_leases account_lease where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now())
  returning true into finished;
  return coalesce(finished, false);
end;
$$;

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
  selected_command_id uuid;
begin
  if p_command_lease_seconds not between 1 and 3600 then raise exception using errcode = 'P0001', message = 'INVALID_COMMAND_LEASE_DURATION'; end if;
  if not exists (select 1 from public.account_leases account_lease where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now()) then raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD'; end if;

  update public.workflow_operations operation
     set status = 'SIDE_EFFECT_UNCERTAIN', error_code = 'COMMAND_LEASE_LOST'
   where operation.account_id = p_account_id and operation.operation_type = 'BROADCAST'
     and exists (
       select 1 from public.workflow_commands command
        where command.operation_id = operation.id and command.status in ('CLAIMED', 'SENDING')
          and (command.lease_until <= now() or command.lease_owner is distinct from p_lease_owner or command.fencing_token is distinct from p_account_fencing_token)
     );
  update public.broadcast_targets target
     set delivery_status = 'SIDE_EFFECT_UNCERTAIN', last_error_code = 'COMMAND_LEASE_LOST'
   where exists (
     select 1 from public.workflow_commands command
      where command.broadcast_target_id = target.id and command.account_id = p_account_id
        and command.status in ('CLAIMED', 'SENDING')
        and (command.lease_until <= now() or command.lease_owner is distinct from p_lease_owner or command.fencing_token is distinct from p_account_fencing_token)
   );
  update public.workflow_commands command
     set status = 'SIDE_EFFECT_UNCERTAIN', lease_until = null,
         last_error_code = case when command.lease_until <= now() then 'COMMAND_LEASE_EXPIRED' else 'ACCOUNT_LEASE_FENCED' end,
         outcome_checked_at = now()
   where command.account_id = p_account_id and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
     and command.status in ('CLAIMED', 'SENDING')
     and (command.lease_until <= now() or command.lease_owner is distinct from p_lease_owner or command.fencing_token is distinct from p_account_fencing_token);

  select command.id into selected_command_id
    from public.workflow_commands command
    join public.workflow_operations operation on operation.id = command.operation_id
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.telegram_accounts account on account.id = command.account_id
   where command.account_id = p_account_id and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE')
     and operation.operation_type = 'BROADCAST'
     and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     and account.status = 'READY'
     and (account.broadcast_next_eligible_at is null or account.broadcast_next_eligible_at <= now())
     and command.status in ('PENDING', 'FAILED_RETRYABLE') and command.available_at <= now()
     and target.preparation_status = 'READY'
     and exists (
       select 1 from public.entitlements entitlement
        where entitlement.user_id = operation.user_id and entitlement.status = 'ACTIVE'
          and entitlement.expires_at > now()
          and entitlement.package_snapshot->>'packageType' = operation.payload->>'accountMode'
          and entitlement.package_snapshot->'features' ? 'JASEB'
     )
     and (
       (operation.payload->>'accountMode' = 'JASEB_WORKER' and exists (
         select 1 from public.worker_assignments assignment
          where assignment.user_id = operation.user_id
            and assignment.worker_account_id = command.account_id
            and assignment.status in ('RESERVED', 'ACTIVE')
       ))
       or
       (operation.payload->>'accountMode' = 'USERBOT' and exists (
         select 1 from public.userbot_profiles profile
          where profile.user_id = operation.user_id and profile.status = 'CONNECTED'
            and profile.active_account_id = command.account_id
       ))
     )
     and not exists (
       select 1 from public.workflow_commands earlier_command
       join public.broadcast_targets earlier_target on earlier_target.id = earlier_command.broadcast_target_id
        where earlier_target.operation_id = target.operation_id and earlier_target.sequence_number < target.sequence_number
          and earlier_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
     and not exists (
       select 1
         from public.workflow_operations earlier_operation
         join public.workflow_commands earlier_operation_command on earlier_operation_command.operation_id = earlier_operation.id
        where earlier_operation.account_id = operation.account_id
          and earlier_operation.operation_type = 'BROADCAST'
          and (earlier_operation.created_at, earlier_operation.id) < (operation.created_at, operation.id)
          and earlier_operation_command.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')
     )
   order by operation.created_at, target.sequence_number, command.created_at, command.id
   for update of command skip locked limit 1;
  if not found then return; end if;

  update public.workflow_commands command
     set status = 'CLAIMED', lease_owner = p_lease_owner, fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds),
         attempt_count = command.attempt_count + 1, last_error_code = null
   where command.id = selected_command_id;
  update public.broadcast_targets target set delivery_status = 'SENDING', last_error_code = null
   where target.id = (select broadcast_target_id from public.workflow_commands where id = selected_command_id);
  update public.workflow_operations operation set status = 'SENDING', error_code = null
   where operation.id = (select command.operation_id from public.workflow_commands command where command.id = selected_command_id);

  return query select command.id, command.operation_id, command.account_id, command.kind,
    command.target_id, command.payload, command.attempt_count, command.fencing_token, command.lease_until
    from public.workflow_commands command where command.id = selected_command_id;
end;
$$;

create function public.finish_broadcast_command(
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
  if p_status not in ('SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN') then raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_FINISH_STATUS'; end if;
  if p_status = 'SUCCEEDED' then
    if p_error_code is not null or p_retry_after_seconds is not null or p_provider_sent_at is null
       or p_provider_message_ids is null or cardinality(p_provider_message_ids) not between 1 and 100
       or exists (select 1 from unnest(p_provider_message_ids) as ids(message_id) where btrim(coalesce(message_id, '')) = '')
       or cardinality(p_provider_message_ids) <> (select count(distinct message_id) from unnest(p_provider_message_ids) as ids(message_id)) then
      raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_RECEIPT';
    end if;
  elsif p_status = 'FAILED_RETRYABLE' then
    if btrim(coalesce(p_error_code, '')) = '' or p_retry_after_seconds not between 1 and 2147483647 or p_provider_message_ids is not null or p_provider_sent_at is not null then raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_RETRY'; end if;
  elsif btrim(coalesce(p_error_code, '')) = '' or p_retry_after_seconds is not null or p_provider_message_ids is not null or p_provider_sent_at is not null then
    raise exception using errcode = 'P0001', message = 'INVALID_BROADCAST_FAILURE';
  end if;

  select command.operation_id, command.broadcast_target_id, target.sequence_number,
         target.interval_seconds, operation.user_id, operation.payload->>'accountMode' as account_mode
    into context_row
    from public.workflow_commands command
    join public.broadcast_targets target on target.id = command.broadcast_target_id
    join public.workflow_operations operation on operation.id = command.operation_id
    join public.telegram_accounts account on account.id = command.account_id
   where command.id = p_command_id and command.account_id = p_account_id
     and command.kind in ('SEND_TEXT', 'FORWARD_MESSAGE') and command.status = 'CLAIMED'
     and command.lease_owner = p_lease_owner and command.fencing_token = p_account_fencing_token
     and exists (select 1 from public.account_leases account_lease where account_lease.account_id = p_account_id and account_lease.lease_owner = p_lease_owner and account_lease.fencing_token = p_account_fencing_token and account_lease.lease_until > now())
   for update of command, target, operation, account;
  if not found then return false; end if;

  next_available_at := case
    when p_status = 'SUCCEEDED' then now() + make_interval(secs => context_row.interval_seconds)
    when p_status = 'FAILED_RETRYABLE' then now() + make_interval(secs => p_retry_after_seconds)
    else null
  end;

  update public.workflow_commands command
     set status = p_status, lease_owner = null, lease_until = null,
         last_error_code = p_error_code, outcome_checked_at = now(),
         available_at = case when p_status = 'FAILED_RETRYABLE' then next_available_at else command.available_at end,
         retry_after = case when p_status = 'FAILED_RETRYABLE' then next_available_at else null end,
         provider_message_id = case when p_status = 'SUCCEEDED' then p_provider_message_ids[1] else command.provider_message_id end,
         provider_message_ids = case when p_status = 'SUCCEEDED' then p_provider_message_ids else command.provider_message_ids end,
         provider_sent_at = case when p_status = 'SUCCEEDED' then p_provider_sent_at else command.provider_sent_at end
   where command.id = p_command_id;

  update public.broadcast_targets target
     set delivery_status = p_status, last_error_code = p_error_code,
         next_eligible_at = next_available_at,
         last_success_at = case when p_status = 'SUCCEEDED' then p_provider_sent_at else target.last_success_at end,
         last_provider_message_id = case when p_status = 'SUCCEEDED' then p_provider_message_ids[1] else target.last_provider_message_id end,
         last_provider_message_ids = case when p_status = 'SUCCEEDED' then p_provider_message_ids else target.last_provider_message_ids end
   where target.id = context_row.broadcast_target_id;

  if p_status = 'SUCCEEDED' then
    update public.workflow_commands command
       set available_at = greatest(command.available_at, next_available_at)
      from public.broadcast_targets target
     where command.broadcast_target_id = target.id and target.operation_id = context_row.operation_id
       and target.sequence_number = (select min(next_target.sequence_number) from public.broadcast_targets next_target where next_target.operation_id = context_row.operation_id and next_target.sequence_number > context_row.sequence_number)
       and command.status in ('PENDING', 'FAILED_RETRYABLE');
    if context_row.account_mode = 'JASEB_WORKER' then
      update public.worker_assignments set status = 'ACTIVE'
       where user_id = context_row.user_id and worker_account_id = p_account_id and status = 'RESERVED';
    end if;
  end if;

  if p_status = 'SUCCEEDED' or (p_status = 'FAILED_RETRYABLE' and p_error_code = 'FLOOD_WAIT') then
    update public.telegram_accounts account
       set broadcast_next_eligible_at = next_available_at
     where account.id = p_account_id;
  end if;

  update public.workflow_operations operation
     set status = case
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status = 'SIDE_EFFECT_UNCERTAIN') then 'SIDE_EFFECT_UNCERTAIN'
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status in ('CLAIMED', 'SENDING')) then 'SENDING'
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status = 'FAILED_RETRYABLE') then 'FAILED_RETRYABLE'
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status = 'PENDING') then 'READY'
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status = 'FAILED_FINAL') then 'FAILED_FINAL'
       when exists (select 1 from public.workflow_commands command where command.operation_id = context_row.operation_id and command.status = 'SUCCEEDED') then 'SUCCEEDED'
       else 'CANCELLED'
     end,
     error_code = (
       select command.last_error_code
         from public.workflow_commands command
        where command.operation_id = context_row.operation_id
          and command.status in ('SIDE_EFFECT_UNCERTAIN', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED')
        order by case command.status
          when 'SIDE_EFFECT_UNCERTAIN' then 1
          when 'FAILED_RETRYABLE' then 2
          when 'FAILED_FINAL' then 3
          else 4
        end, command.outcome_checked_at desc nulls last, command.id
        limit 1
     )
   where operation.id = context_row.operation_id;
  return true;
end;
$$;

-- Expiry is package-specific. A USERBOT subscription must not keep a worker
-- assignment alive, and a worker subscription must not keep Userbot connected.
create or replace function public.expire_due_entitlements(p_at timestamptz default now())
returns integer
language plpgsql
set search_path = public
as $$
declare expired_count integer;
begin
  with expired as (
    update public.entitlements set status = 'EXPIRED', updated_at = p_at
     where status = 'ACTIVE' and expires_at <= p_at returning user_id
  ) select count(*) into expired_count from expired;

  update public.userbot_profiles profile set status = 'DISCONNECTED', updated_at = p_at
   where profile.status = 'CONNECTED'
     and not exists (select 1 from public.entitlements active where active.user_id = profile.user_id and active.status = 'ACTIVE' and active.expires_at > p_at and active.package_snapshot->>'packageType' = 'USERBOT');

  update public.worker_assignments assignment set status = 'RELEASED', released_at = p_at, updated_at = p_at
   where assignment.status in ('RESERVED', 'ACTIVE')
     and not exists (select 1 from public.entitlements active where active.user_id = assignment.user_id and active.status = 'ACTIVE' and active.expires_at > p_at and active.package_snapshot->>'packageType' = 'JASEB_WORKER');

  update public.broadcast_targets target set delivery_status = 'CANCELLED', last_error_code = 'SUBSCRIPTION_EXPIRED'
    from public.workflow_operations operation
   where operation.id = target.operation_id and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (select 1 from public.entitlements active where active.user_id = operation.user_id and active.status = 'ACTIVE' and active.expires_at > p_at and active.package_snapshot->>'packageType' = operation.payload->>'accountMode');
  update public.workflow_commands command set status = 'CANCELLED', last_error_code = 'SUBSCRIPTION_EXPIRED', outcome_checked_at = p_at
    from public.workflow_operations operation
   where operation.id = command.operation_id and command.status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (select 1 from public.entitlements active where active.user_id = operation.user_id and active.status = 'ACTIVE' and active.expires_at > p_at and active.package_snapshot->>'packageType' = case when operation.operation_type = 'AUTO_COMMENT' then 'USERBOT' else operation.payload->>'accountMode' end);
  update public.workflow_operations operation set status = 'CANCELLED', error_code = 'SUBSCRIPTION_EXPIRED'
   where operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     and not exists (select 1 from public.workflow_commands command where command.operation_id = operation.id and command.status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED', 'SENDING'))
     and not exists (select 1 from public.entitlements active where active.user_id = operation.user_id and active.status = 'ACTIVE' and active.expires_at > p_at and active.package_snapshot->>'packageType' = case when operation.operation_type = 'AUTO_COMMENT' then 'USERBOT' else operation.payload->>'accountMode' end);
  return expired_count;
end;
$$;

comment on function public.claim_next_broadcast_command(uuid, uuid, bigint, integer)
  is 'Claims one prepared Jasa Sebar command under active entitlement plus account lease/fencing, and increments its attempt exactly once.';
comment on function public.finish_broadcast_command(uuid, uuid, uuid, bigint, text, text, integer, text[], timestamptz)
  is 'Atomically persists Jasa Sebar receipt/retry/uncertainty and updates target, operation, interval, and worker-assignment state.';
comment on column public.workflow_commands.provider_message_ids
  is 'All Telegram message IDs returned by one send, including native-forward album receipts.';

revoke all on function public.claim_next_broadcast_command(uuid, uuid, bigint, integer) from public;
revoke all on function public.finish_broadcast_command(uuid, uuid, uuid, bigint, text, text, integer, text[], timestamptz) from public;
revoke all on function public.expire_due_entitlements(timestamptz) from public;
