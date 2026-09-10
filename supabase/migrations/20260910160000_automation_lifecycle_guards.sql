-- Automation lifecycle correctness.
--
-- PostgreSQL remains the source of truth. Runtime claims are now only an
-- intent to execute: immediately before a Telegram side effect the engine
-- must revalidate the current subscription, service, account, target and
-- campaign state through the fenced functions below.

alter table public.userbot_profiles
  add column auto_comment_enabled boolean;
update public.userbot_profiles set auto_comment_enabled = true;
alter table public.userbot_profiles
  alter column auto_comment_enabled set default false,
  alter column auto_comment_enabled set not null;

alter table public.auto_comment_channel_targets
  add column central_monitor_activated_at timestamptz not null default now();

alter table public.broadcast_materials add column deleted_at timestamptz;
alter table public.broadcast_lpm_targets add column deleted_at timestamptz;
alter table public.auto_comment_divisions add column deleted_at timestamptz;
alter table public.auto_comment_channel_targets add column deleted_at timestamptz;
alter table public.auto_comment_division_templates add column deleted_at timestamptz;

drop index public.broadcast_lpm_targets_user_ref_unique_idx;
create unique index broadcast_lpm_targets_user_ref_unique_idx
  on public.broadcast_lpm_targets (user_id, lower(btrim(telegram_target_ref)))
  where deleted_at is null;

drop index public.auto_comment_divisions_profile_name_unique_idx;
create unique index auto_comment_divisions_profile_name_unique_idx
  on public.auto_comment_divisions (profile_id, lower(btrim(name)))
  where deleted_at is null;

drop index public.auto_comment_channel_targets_profile_channel_unique_idx;
create unique index auto_comment_channel_targets_profile_channel_unique_idx
  on public.auto_comment_channel_targets (profile_id, lower(btrim(source_channel_ref)))
  where deleted_at is null;

drop index public.auto_comment_division_templates_unique_idx;
create unique index auto_comment_division_templates_unique_idx
  on public.auto_comment_division_templates (division_id, lower(btrim(text_content)))
  where deleted_at is null;

comment on column public.userbot_profiles.auto_comment_enabled
  is 'Master user-controlled Auto Komen switch. False prevents monitoring/matching and cancels work that has not started a Telegram side effect.';

comment on column public.auto_comment_channel_targets.central_monitor_activated_at
  is 'Activation boundary used to recover posts that arrive while the central monitor is preparing this source, without replaying older channel history.';

create or replace function public.set_auto_comment_monitor_activation_boundary()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.central_monitor_activated_at := now();
    return new;
  end if;
  if new.source_channel_ref is distinct from old.source_channel_ref
     or (new.active and not old.active) then
    new.central_monitor_activated_at := now();
  end if;
  return new;
end;
$$;

create trigger auto_comment_channel_targets_activation_boundary
before insert or update of active, source_channel_ref on public.auto_comment_channel_targets
for each row execute function public.set_auto_comment_monitor_activation_boundary();

alter table public.broadcast_targets
  add column cancel_requested_at timestamptz,
  add column cancel_reason text;

alter table public.workflow_commands
  add column cancel_requested_at timestamptz,
  add column cancel_reason text;

alter table public.broadcast_targets
  drop constraint broadcast_targets_preparation_status_check,
  add constraint broadcast_targets_preparation_status_check
    check (preparation_status in (
      'QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL', 'READY',
      'FAILED_FINAL', 'CANCELLED'
    ));

-- Repair the exact production corruption produced by String(Promise). Keep
-- the durable checkpoint so reconnect does not replay old channel history.
update public.auto_comment_monitor_sources
   set provider_peer_id = null,
       status = 'PENDING',
       last_error_code = null,
       retry_at = now(),
       updated_at = now()
 where provider_peer_id = '[object Promise]'
    or last_error_code = 'CENTRAL_MONITOR_FAILED';

create or replace function public.recompute_broadcast_operation(p_operation_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.workflow_operations operation
     set status = case
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'SIDE_EFFECT_UNCERTAIN') then 'SIDE_EFFECT_UNCERTAIN'
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'SENDING') then 'SENDING'
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'FAILED_RETRYABLE') then 'FAILED_RETRYABLE'
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'PENDING') then
         case
           when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.preparation_status in ('QUEUED', 'CHECKING', 'JOINING')) then 'QUEUED'
           when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.preparation_status = 'WAITING_APPROVAL') then 'WAITING_APPROVAL'
           else 'READY'
         end
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'FAILED_FINAL') then 'FAILED_FINAL'
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'CANCELLED') then 'CANCELLED'
       when exists (select 1 from public.broadcast_targets t where t.operation_id = p_operation_id and t.delivery_status = 'SUCCEEDED') then 'SUCCEEDED'
       else 'CANCELLED'
     end,
     error_code = (
       select t.last_error_code
         from public.broadcast_targets t
        where t.operation_id = p_operation_id and t.last_error_code is not null
        order by t.updated_at desc, t.id
        limit 1
     ),
     updated_at = now()
   where operation.id = p_operation_id
     and operation.operation_type = 'BROADCAST';
end;
$$;

revoke all on function public.recompute_broadcast_operation(uuid) from public;

create or replace function public.request_broadcast_target_cancellation(
  p_target_id uuid,
  p_reason text
)
returns void
language plpgsql
set search_path = public
as $$
declare v_operation_id uuid;
begin
  update public.broadcast_targets target
     set cancel_requested_at = coalesce(target.cancel_requested_at, now()),
         cancel_reason = p_reason,
         preparation_status = case
           when target.preparation_status in ('QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL') then 'CANCELLED'
           else target.preparation_status
         end,
         delivery_status = case
           when target.delivery_status in ('PENDING', 'FAILED_RETRYABLE') then 'CANCELLED'
           else target.delivery_status
         end,
         preparation_lease_owner = case when target.preparation_status in ('CHECKING', 'JOINING') then null else target.preparation_lease_owner end,
         preparation_fencing_token = case when target.preparation_status in ('CHECKING', 'JOINING') then null else target.preparation_fencing_token end,
         last_error_code = p_reason,
         updated_at = now()
   where target.id = p_target_id
     and target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
  returning target.operation_id into v_operation_id;
  if v_operation_id is not null then perform public.recompute_broadcast_operation(v_operation_id); end if;
end;
$$;

revoke all on function public.request_broadcast_target_cancellation(uuid, text) from public;

create or replace function public.cancel_broadcast_operation(
  p_operation_id uuid,
  p_user_id uuid,
  p_reason text default 'USER_CANCELLED'
)
returns boolean
language plpgsql
set search_path = public
as $$
declare v_found boolean := false; v_target record;
begin
  perform 1 from public.workflow_operations
   where id = p_operation_id and user_id = p_user_id and operation_type = 'BROADCAST'
   for update;
  if not found then return false; end if;
  v_found := true;
  for v_target in select id from public.broadcast_targets where operation_id = p_operation_id for update
  loop
    perform public.request_broadcast_target_cancellation(v_target.id, p_reason);
  end loop;
  perform public.recompute_broadcast_operation(p_operation_id);
  perform pg_notify('jaseb_runtime_work', p_operation_id::text);
  return v_found;
end;
$$;

revoke all on function public.cancel_broadcast_operation(uuid, uuid, text) from public;

create or replace function public.stop_broadcast_campaign(p_campaign_id uuid, p_user_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare v_updated boolean := false; v_operation record;
begin
  update public.broadcast_campaigns
     set status = 'STOPPED', error_code = null, updated_at = now()
   where id = p_campaign_id and user_id = p_user_id and status = 'ACTIVE'
  returning true into v_updated;
  if not coalesce(v_updated, false) then
    return exists (select 1 from public.broadcast_campaigns where id = p_campaign_id and user_id = p_user_id);
  end if;
  for v_operation in
    select id from public.workflow_operations
     where campaign_id = p_campaign_id
       and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, p_user_id, 'CAMPAIGN_STOPPED');
  end loop;
  perform pg_notify('jaseb_broadcast_campaigns', p_campaign_id::text);
  return true;
end;
$$;

comment on function public.stop_broadcast_campaign(uuid, uuid)
  is 'Stops a campaign and atomically cancels every cycle target whose Telegram side effect has not started.';
revoke all on function public.stop_broadcast_campaign(uuid, uuid) from public;

create or replace function public.set_broadcast_service_enabled(
  p_user_id uuid,
  p_enabled boolean,
  p_account_mode text default null,
  p_material_id uuid default null,
  p_target_ids uuid[] default null,
  p_interval_seconds integer default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare v_campaign record; v_operation record; v_campaign_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1601));
  if not p_enabled then
    for v_campaign in
      select id from public.broadcast_campaigns
       where user_id = p_user_id and status = 'ACTIVE'
       for update
    loop
      perform public.stop_broadcast_campaign(v_campaign.id, p_user_id);
    end loop;
    for v_operation in
      select id from public.workflow_operations
       where user_id = p_user_id and operation_type = 'BROADCAST'
         and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       for update
    loop
      perform public.cancel_broadcast_operation(v_operation.id, p_user_id, 'SERVICE_DISABLED');
    end loop;
    perform pg_notify('jaseb_broadcast_campaigns', p_user_id::text);
    return null;
  end if;

  select id into v_campaign_id
    from public.broadcast_campaigns
   where user_id = p_user_id and status = 'ACTIVE'
   order by created_at desc limit 1;
  if found then return v_campaign_id; end if;
  for v_operation in
    select id from public.workflow_operations
     where user_id = p_user_id and operation_type = 'BROADCAST'
       and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, p_user_id, 'SUPERSEDED_BY_SERVICE_TOGGLE');
  end loop;
  if p_account_mode is null or p_material_id is null or p_target_ids is null
     or p_interval_seconds is null then
    raise exception using errcode = 'P0001', message = 'BROADCAST_CONFIGURATION_REQUIRED';
  end if;
  v_campaign_id := public.create_broadcast_campaign(
    p_user_id, p_account_mode, p_material_id, p_target_ids, p_interval_seconds
  );
  perform pg_notify('jaseb_broadcast_campaigns', v_campaign_id::text);
  return v_campaign_id;
end;
$$;

revoke all on function public.set_broadcast_service_enabled(uuid, boolean, text, uuid, uuid[], integer) from public;

create or replace function public.invalidate_broadcast_target_configuration()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_target_id uuid := old.id; v_target record; v_remove boolean; v_reason text;
begin
  if tg_op = 'UPDATE' and old.active = new.active
     and old.telegram_target_ref is not distinct from new.telegram_target_ref then
    return new;
  end if;
  if tg_op = 'DELETE' then v_remove := true; else v_remove := not new.active; end if;
  v_reason := case when v_remove then 'TARGET_REMOVED' else 'TARGET_CHANGED' end;
  if v_remove then
    update public.broadcast_campaigns campaign
       set target_ids = array_remove(campaign.target_ids, v_target_id),
           status = case when cardinality(array_remove(campaign.target_ids, v_target_id)) = 0 then 'STOPPED' else campaign.status end,
           error_code = case when cardinality(array_remove(campaign.target_ids, v_target_id)) = 0 then 'NO_ACTIVE_TARGETS' else campaign.error_code end,
           updated_at = now()
     where campaign.status = 'ACTIVE' and v_target_id = any(campaign.target_ids);
  else
    update public.broadcast_campaigns
       set next_cycle_at = now(), updated_at = now()
     where status = 'ACTIVE' and v_target_id = any(target_ids);
  end if;

  for v_target in
    select target.id
      from public.broadcast_targets target
     where target.source_lpm_target_id = v_target_id
       and target.delivery_status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.request_broadcast_target_cancellation(v_target.id, v_reason);
  end loop;
  perform pg_notify('jaseb_runtime_work', v_target_id::text);
  perform pg_notify('jaseb_broadcast_campaigns', v_target_id::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists broadcast_lpm_targets_cancel_stale_work on public.broadcast_lpm_targets;
create trigger broadcast_lpm_targets_cancel_stale_work
before delete or update of active, telegram_target_ref on public.broadcast_lpm_targets
for each row execute function public.invalidate_broadcast_target_configuration();

create or replace function public.sync_broadcast_target_to_active_campaign()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not new.active then return new; end if;
  update public.broadcast_campaigns campaign
     set target_ids = case
           when new.id = any(campaign.target_ids) then campaign.target_ids
           else array_append(campaign.target_ids, new.id)
         end,
         next_cycle_at = now(), updated_at = now()
   where campaign.user_id = new.user_id and campaign.status = 'ACTIVE';
  if found then perform pg_notify('jaseb_broadcast_campaigns', new.id::text); end if;
  return new;
end;
$$;

create trigger broadcast_lpm_targets_sync_active_campaign
after insert or update of active, telegram_target_ref on public.broadcast_lpm_targets
for each row execute function public.sync_broadcast_target_to_active_campaign();

create or replace function public.invalidate_broadcast_material_configuration()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_material_id uuid := old.id; v_operation record; v_disable boolean; v_reason text;
begin
  if tg_op = 'UPDATE'
     and old.active = new.active
     and old.kind is not distinct from new.kind
     and old.text_content is not distinct from new.text_content
     and old.forward_channel_username is not distinct from new.forward_channel_username
     and old.forward_message_id is not distinct from new.forward_message_id
     and old.source_attribution is not distinct from new.source_attribution then return new; end if;
  if tg_op = 'DELETE' then v_disable := true; else v_disable := not new.active; end if;
  v_reason := case when v_disable then 'MATERIAL_INACTIVE' else 'MATERIAL_CHANGED' end;
  update public.broadcast_campaigns
     set status = case when v_disable then 'STOPPED' else status end,
         error_code = case when v_disable then 'MATERIAL_INACTIVE' else null end,
         next_cycle_at = case when v_disable then next_cycle_at else now() end,
         updated_at = now()
   where material_id = v_material_id and status = 'ACTIVE';
  for v_operation in
    select id, user_id from public.workflow_operations
     where operation_type = 'BROADCAST'
       and payload->'material'->>'id' = v_material_id::text
       and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, v_operation.user_id, v_reason);
  end loop;
  perform pg_notify('jaseb_broadcast_campaigns', v_material_id::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists broadcast_materials_cancel_stale_work on public.broadcast_materials;
create trigger broadcast_materials_cancel_stale_work
before delete or update of active, kind, text_content, forward_channel_username, forward_message_id, source_attribution on public.broadcast_materials
for each row execute function public.invalidate_broadcast_material_configuration();

-- Prevent a single buyer/account pair from creating a hidden backlog. Shared
-- admin workers remain usable by many different buyers.
with ranked as (
  select id, row_number() over (partition by user_id, account_id order by created_at, id) as position
    from public.workflow_operations
   where operation_type = 'BROADCAST'
     and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
)
update public.workflow_operations operation
   set status = 'CANCELLED', error_code = 'SUPERSEDED_OPERATION', updated_at = now()
  from ranked
 where ranked.id = operation.id and ranked.position > 1;

create unique index workflow_operations_one_active_broadcast_per_user_account_idx
  on public.workflow_operations (user_id, account_id)
  where operation_type = 'BROADCAST'
    and status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN');

create or replace function public.guard_overlapping_broadcast_operation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.operation_type = 'BROADCAST' and exists (
    select 1 from public.workflow_operations operation
     where operation.user_id = new.user_id and operation.account_id = new.account_id
       and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
  ) then
    raise exception using errcode = 'P0001', message = 'BROADCAST_BUSY';
  end if;
  return new;
end;
$$;

drop trigger if exists workflow_operations_guard_overlapping_broadcast on public.workflow_operations;
create trigger workflow_operations_guard_overlapping_broadcast
before insert on public.workflow_operations
for each row execute function public.guard_overlapping_broadcast_operation();

create or replace function public.guard_broadcast_campaign_start()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from public.workflow_operations operation
     where operation.user_id = new.user_id
       and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
  ) then
    raise exception using errcode = 'P0001', message = 'BROADCAST_BUSY';
  end if;
  return new;
end;
$$;

drop trigger if exists broadcast_campaigns_guard_start on public.broadcast_campaigns;
create trigger broadcast_campaigns_guard_start
before insert on public.broadcast_campaigns
for each row execute function public.guard_broadcast_campaign_start();

create or replace view public.broadcast_runtime_eligible_operations
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
     select 1 from public.broadcast_materials material
      where material.id = (operation.payload->'material'->>'id')::uuid
        and material.user_id = operation.user_id and material.active
   )
   and (operation.campaign_id is null or exists (
     select 1 from public.broadcast_campaigns campaign
      where campaign.id = operation.campaign_id and campaign.status = 'ACTIVE'
   ))
   and exists (
     select 1 from public.entitlements entitlement
      where entitlement.user_id = operation.user_id
        and entitlement.status = 'ACTIVE' and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = operation.payload->>'accountMode'
        and entitlement.package_snapshot->'features' ? 'JASEB'
   )
   and (
     (account.account_type = 'JASEB_WORKER' and exists (
       select 1 from public.worker_assignments assignment
       join public.worker_account_settings setting on setting.worker_account_id = assignment.worker_account_id
        where assignment.user_id = operation.user_id
          and assignment.worker_account_id = operation.account_id
          and assignment.status in ('RESERVED', 'ACTIVE') and setting.active
     ))
     or
     (account.account_type = 'USERBOT' and exists (
       select 1 from public.userbot_profiles profile
        where profile.user_id = operation.user_id and profile.status = 'CONNECTED'
          and profile.active_account_id = operation.account_id
     ))
   );

revoke all on public.broadcast_runtime_eligible_operations from public;

create or replace function public.disable_worker_runtime_work()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_operation record;
begin
  if old.active = new.active or new.active then return new; end if;
  for v_operation in
    select operation.id, operation.user_id
      from public.workflow_operations operation
     where operation.account_id = old.worker_account_id
       and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, v_operation.user_id, 'WORKER_DISABLED');
  end loop;
  update public.worker_assignments
     set status = 'RELEASED', released_at = now(), updated_at = now()
   where worker_account_id = old.worker_account_id and status in ('RESERVED', 'ACTIVE');
  return new;
end;
$$;

drop trigger if exists worker_account_settings_stop_runtime on public.worker_account_settings;
create trigger worker_account_settings_stop_runtime
before update of active on public.worker_account_settings
for each row execute function public.disable_worker_runtime_work();

create or replace function public.validate_broadcast_execution(
  p_target_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns text
language plpgsql
set search_path = public
as $$
declare v_context record; v_authorized boolean;
begin
  select target.operation_id, target.source_lpm_target_id, target.telegram_target_ref,
         target.cancel_requested_at, operation.user_id, operation.campaign_id,
         operation.payload->>'accountMode' as account_mode,
         operation.payload->'material'->>'id' as material_id
    into v_context
    from public.broadcast_targets target
    join public.workflow_operations operation on operation.id = target.operation_id
   where target.id = p_target_id and operation.account_id = p_account_id
     and target.delivery_status = 'SENDING'
     and target.delivery_lease_owner = p_lease_owner
     and target.delivery_fencing_token = p_account_fencing_token
   for update of target, operation;
  if not found then return 'FENCED_OUT'; end if;
  if not exists (
    select 1 from public.account_leases lease
     where lease.account_id = p_account_id and lease.lease_owner = p_lease_owner
       and lease.fencing_token = p_account_fencing_token and lease.lease_until > now()
  ) then return 'FENCED_OUT'; end if;

  select v_context.cancel_requested_at is null
     and exists (
       select 1 from public.broadcast_lpm_targets configured
        where configured.id = v_context.source_lpm_target_id
          and configured.user_id = v_context.user_id and configured.active
          and lower(btrim(configured.telegram_target_ref)) = lower(btrim(v_context.telegram_target_ref))
     )
     and exists (
       select 1 from public.broadcast_materials material
        where material.id = v_context.material_id::uuid
          and material.user_id = v_context.user_id and material.active
     )
     and (v_context.campaign_id is null or exists (
       select 1 from public.broadcast_campaigns campaign
        where campaign.id = v_context.campaign_id and campaign.status = 'ACTIVE'
          and v_context.source_lpm_target_id = any(campaign.target_ids)
     ))
     and exists (
       select 1 from public.entitlements entitlement
        where entitlement.user_id = v_context.user_id and entitlement.status = 'ACTIVE'
          and entitlement.expires_at > now()
          and entitlement.package_snapshot->>'packageType' = v_context.account_mode
          and entitlement.package_snapshot->'features' ? 'JASEB'
     )
     and exists (select 1 from public.telegram_accounts account where account.id = p_account_id and account.status = 'READY')
     and (
       (v_context.account_mode = 'USERBOT' and exists (
         select 1 from public.userbot_profiles profile
          where profile.user_id = v_context.user_id and profile.status = 'CONNECTED'
            and profile.active_account_id = p_account_id
       ))
       or
       (v_context.account_mode = 'JASEB_WORKER' and exists (
         select 1 from public.worker_assignments assignment
         join public.worker_account_settings setting on setting.worker_account_id = assignment.worker_account_id
          where assignment.user_id = v_context.user_id and assignment.worker_account_id = p_account_id
            and assignment.status in ('RESERVED', 'ACTIVE') and setting.active
       ))
     )
    into v_authorized;

  if coalesce(v_authorized, false) then return 'AUTHORIZED'; end if;
  update public.broadcast_targets
     set delivery_status = 'CANCELLED', delivery_lease_owner = null,
         delivery_fencing_token = null, delivery_lease_until = null,
         cancel_requested_at = coalesce(cancel_requested_at, now()),
         cancel_reason = coalesce(cancel_reason, 'EXECUTION_NO_LONGER_AUTHORIZED'),
         last_error_code = coalesce(cancel_reason, 'EXECUTION_NO_LONGER_AUTHORIZED'),
         updated_at = now()
   where id = p_target_id;
  perform public.recompute_broadcast_operation(v_context.operation_id);
  return 'CANCELLED';
end;
$$;

revoke all on function public.validate_broadcast_execution(uuid, uuid, uuid, bigint) from public;

create or replace function public.validate_broadcast_preparation(
  p_target_id uuid, p_account_id uuid, p_lease_owner uuid, p_account_fencing_token bigint
)
returns text
language plpgsql
set search_path = public
as $$
declare v_operation_id uuid; v_source_target_id uuid; v_target_ref text;
begin
  select target.operation_id, target.source_lpm_target_id, target.telegram_target_ref
    into v_operation_id, v_source_target_id, v_target_ref
    from public.broadcast_targets target
    join public.workflow_operations operation on operation.id = target.operation_id
   where target.id = p_target_id and operation.account_id = p_account_id
     and target.preparation_status in ('CHECKING', 'JOINING')
     and target.preparation_lease_owner = p_lease_owner
     and target.preparation_fencing_token = p_account_fencing_token
   for update of target;
  if not found then return 'FENCED_OUT'; end if;
  if exists (
    select 1 from public.account_leases lease
     where lease.account_id = p_account_id and lease.lease_owner = p_lease_owner
       and lease.fencing_token = p_account_fencing_token and lease.lease_until > now()
  ) and exists (
    select 1 from public.broadcast_runtime_eligible_operations eligible
     where eligible.operation_id = v_operation_id and eligible.account_id = p_account_id
  ) and exists (
    select 1 from public.broadcast_lpm_targets configured
     join public.workflow_operations operation on operation.id = v_operation_id
     where configured.id = v_source_target_id and configured.user_id = operation.user_id
       and configured.active
       and lower(btrim(configured.telegram_target_ref)) = lower(btrim(v_target_ref))
  ) and not exists (
    select 1 from public.broadcast_targets target
     where target.id = p_target_id and target.cancel_requested_at is not null
  ) then return 'AUTHORIZED'; end if;

  update public.broadcast_targets
     set preparation_status = 'CANCELLED', delivery_status = 'CANCELLED',
         preparation_lease_owner = null, preparation_fencing_token = null,
         cancel_requested_at = coalesce(cancel_requested_at, now()),
         cancel_reason = coalesce(cancel_reason, 'PREPARATION_NO_LONGER_AUTHORIZED'),
         last_error_code = coalesce(cancel_reason, 'PREPARATION_NO_LONGER_AUTHORIZED'),
         updated_at = now()
   where id = p_target_id;
  perform public.recompute_broadcast_operation(v_operation_id);
  return 'CANCELLED';
end;
$$;

revoke all on function public.validate_broadcast_preparation(uuid, uuid, uuid, bigint) from public;

-- Delivery order is best-effort, not a dependency chain. A target waiting for
-- join approval must not block another READY target in the same operation, and
-- one buyer's unavailable target must not block other buyers sharing an admin
-- worker. The account-wide next-eligible timestamp still serializes Telegram
-- sends and preserves the configured interval.
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
declare selected_target_id uuid;
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
     and target.cancel_requested_at is null
     and (target.next_eligible_at is null or target.next_eligible_at <= now())
     and (eligible.broadcast_next_eligible_at is null or eligible.broadcast_next_eligible_at <= now())
     and (eligible.runtime_retry_at is null or eligible.runtime_retry_at <= now())
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
  select target.id, operation.id, operation.account_id,
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

revoke all on function public.claim_next_broadcast_command(uuid, uuid, bigint, integer) from public;

-- Master Auto Komen lifecycle and cancellation.
create or replace function public.set_auto_comment_enabled(p_user_id uuid, p_enabled boolean)
returns boolean
language plpgsql
set search_path = public
as $$
declare v_updated boolean := false;
begin
  if p_enabled and not exists (
    select 1 from public.entitlements entitlement
     where entitlement.user_id = p_user_id and entitlement.status = 'ACTIVE'
       and entitlement.expires_at > now()
       and entitlement.package_snapshot->>'packageType' = 'USERBOT'
       and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
  ) then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;
  update public.userbot_profiles
     set auto_comment_enabled = p_enabled, updated_at = now()
   where user_id = p_user_id
  returning true into v_updated;
  if not coalesce(v_updated, false) then return false; end if;

  if not p_enabled then
    update public.workflow_commands command
       set status = case when command.status in ('PENDING', 'FAILED_RETRYABLE') then 'CANCELLED' else command.status end,
           cancel_requested_at = coalesce(command.cancel_requested_at, now()),
           cancel_reason = 'SERVICE_DISABLED',
           last_error_code = 'SERVICE_DISABLED', updated_at = now()
      from public.workflow_operations operation
     where operation.id = command.operation_id and operation.user_id = p_user_id
       and operation.operation_type = 'AUTO_COMMENT'
       and command.status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED');
    update public.workflow_operations
       set status = 'CANCELLED', error_code = 'SERVICE_DISABLED', updated_at = now()
     where user_id = p_user_id and operation_type = 'AUTO_COMMENT'
       and status in ('QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL', 'READY', 'FAILED_RETRYABLE');
    update public.auto_comment_candidates
       set status = 'REJECTED', error_code = 'SERVICE_DISABLED', updated_at = now()
     where division_id in (select id from public.auto_comment_divisions where user_id = p_user_id)
       and status in ('PENDING_REVIEW', 'COMMENT_QUEUED');
  end if;
  perform pg_notify('jaseb_auto_comment_monitor', p_user_id::text);
  perform pg_notify('jaseb_runtime_work', p_user_id::text);
  return true;
end;
$$;

revoke all on function public.set_auto_comment_enabled(uuid, boolean) from public;

create or replace function public.auto_comment_candidate_is_current(p_candidate_id uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1
      from public.auto_comment_candidates candidate
      join public.auto_comment_divisions division on division.id = candidate.division_id
      join public.auto_comment_channel_targets target on target.id = candidate.channel_target_id
      join public.auto_comment_division_channels mapping
        on mapping.division_id = division.id and mapping.channel_target_id = target.id
      join public.userbot_profiles profile on profile.user_id = division.user_id
      join public.telegram_accounts account on account.id = division.account_id
     where candidate.id = p_candidate_id
       and division.active and target.active and target.resolution_status = 'READY'
       and division.account_id = target.account_id
       and profile.auto_comment_enabled and profile.status = 'CONNECTED'
       and profile.active_account_id = division.account_id
       and account.status = 'READY'
       and candidate.selected_template_id is not null
       and exists (
         select 1 from public.auto_comment_division_templates template
          where template.id = candidate.selected_template_id
            and template.division_id = division.id and template.active
       )
       and exists (
         select 1 from public.entitlements entitlement
          where entitlement.user_id = division.user_id
            and entitlement.status = 'ACTIVE' and entitlement.expires_at > now()
            and entitlement.package_snapshot->>'packageType' = 'USERBOT'
            and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
       )
  );
$$;

revoke all on function public.auto_comment_candidate_is_current(uuid) from public;

create or replace function public.decide_auto_comment_candidate(
  p_candidate_id uuid,
  p_user_id uuid,
  p_decision text
)
returns table (result_status text, candidate_id uuid, operation_id uuid, command_id uuid)
language plpgsql
set search_path = public
as $$
declare candidate_row record; created_operation_id uuid; created_command_id uuid;
begin
  if p_decision not in ('TEPAT', 'OOT') then
    raise exception using errcode = '22023', message = 'decision must be TEPAT or OOT';
  end if;
  select candidate.id, division.user_id, division.account_id,
         candidate.mode_snapshot, candidate.status,
         candidate.discussion_target_ref_snapshot, candidate.template_text_snapshot,
         post.source_channel_ref, post.provider_post_id
    into candidate_row
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
    join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
   where candidate.id = p_candidate_id
   for update of candidate;
  if not found or candidate_row.user_id is distinct from p_user_id then
    return query select 'NOT_FOUND'::text, p_candidate_id, null::uuid, null::uuid; return;
  end if;
  if exists (select 1 from public.auto_comment_reviews review where review.candidate_id = p_candidate_id) then
    return query select 'ALREADY_DECIDED'::text, p_candidate_id, null::uuid, null::uuid; return;
  end if;
  if candidate_row.mode_snapshot <> 'APPROVAL_REQUIRED' or candidate_row.status <> 'PENDING_REVIEW' then
    return query select 'NOT_AWAITING_REVIEW'::text, p_candidate_id, null::uuid, null::uuid; return;
  end if;
  if p_decision = 'OOT' then
    update public.auto_comment_candidates set status = 'OOT', updated_at = now() where id = p_candidate_id;
    insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
    values (p_candidate_id, p_user_id, 'OOT');
    return query select 'OOT'::text, p_candidate_id, null::uuid, null::uuid; return;
  end if;
  if not public.auto_comment_candidate_is_current(p_candidate_id) then
    update public.auto_comment_candidates
       set status = 'REJECTED', error_code = 'CONFIGURATION_CHANGED', updated_at = now()
     where id = p_candidate_id;
    return query select 'NOT_AWAITING_REVIEW'::text, p_candidate_id, null::uuid, null::uuid; return;
  end if;
  update public.auto_comment_candidates set status = 'COMMENT_QUEUED', updated_at = now() where id = p_candidate_id;
  insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
  values (p_candidate_id, p_user_id, 'TEPAT');
  insert into public.workflow_operations (user_id, account_id, operation_type, status, idempotency_key, payload)
  values (p_user_id, candidate_row.account_id, 'AUTO_COMMENT', 'QUEUED',
          'auto-comment:' || p_candidate_id::text, jsonb_build_object('candidateId', p_candidate_id::text))
  returning id into created_operation_id;
  insert into public.workflow_commands (
    operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id
  ) values (
    created_operation_id, candidate_row.account_id, 'COMMENT_TEXT',
    candidate_row.discussion_target_ref_snapshot, 'auto-comment-command:' || p_candidate_id::text,
    jsonb_build_object('text', candidate_row.template_text_snapshot,
      'sourceChannelRef', candidate_row.source_channel_ref,
      'channelPostId', candidate_row.provider_post_id),
    p_candidate_id
  ) returning id into created_command_id;
  return query select 'COMMENT_QUEUED'::text, p_candidate_id, created_operation_id, created_command_id;
end;
$$;

revoke all on function public.decide_auto_comment_candidate(uuid, uuid, text) from public;

create or replace function public.guard_auto_comment_candidate_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.auto_comment_divisions division
      join public.auto_comment_channel_targets target
        on target.id = new.channel_target_id and target.user_id = division.user_id
       and target.account_id = division.account_id
      join public.auto_comment_division_channels mapping
        on mapping.division_id = division.id and mapping.channel_target_id = target.id
      join public.auto_comment_division_templates template
        on template.id = new.selected_template_id and template.division_id = division.id
      join public.userbot_profiles profile on profile.user_id = division.user_id
      join public.telegram_accounts account on account.id = division.account_id
     where division.id = new.division_id and division.active
       and target.active and target.resolution_status = 'READY'
       and template.active and profile.auto_comment_enabled
       and profile.status = 'CONNECTED' and profile.active_account_id = division.account_id
       and account.status = 'READY'
       and exists (
         select 1 from public.entitlements entitlement
          where entitlement.user_id = division.user_id
            and entitlement.status = 'ACTIVE' and entitlement.expires_at > now()
            and entitlement.package_snapshot->>'packageType' = 'USERBOT'
            and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
       )
  ) then
    raise exception using errcode = 'P0001', message = 'AUTOMATION_CONFIGURATION_STALE';
  end if;
  return new;
end;
$$;

drop trigger if exists auto_comment_candidates_guard_current_config on public.auto_comment_candidates;
create trigger auto_comment_candidates_guard_current_config
before insert on public.auto_comment_candidates
for each row execute function public.guard_auto_comment_candidate_insert();

create or replace function public.cancel_auto_comment_candidates(
  p_candidate_ids uuid[],
  p_reason text
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_candidate_ids is null or cardinality(p_candidate_ids) = 0 then return; end if;
  update public.workflow_commands command
     set status = case when command.status in ('PENDING', 'FAILED_RETRYABLE') then 'CANCELLED' else command.status end,
         cancel_requested_at = coalesce(command.cancel_requested_at, now()),
         cancel_reason = p_reason, last_error_code = p_reason, updated_at = now()
   where command.auto_comment_candidate_id = any(p_candidate_ids)
     and command.status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED');
  update public.workflow_operations operation
     set status = 'CANCELLED', error_code = p_reason, updated_at = now()
   where operation.id in (
     select command.operation_id from public.workflow_commands command
      where command.auto_comment_candidate_id = any(p_candidate_ids)
   )
     and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN');
  update public.auto_comment_candidates candidate
     set status = 'REJECTED', error_code = p_reason, updated_at = now()
   where candidate.id = any(p_candidate_ids)
     and candidate.status in ('PENDING_REVIEW', 'COMMENT_QUEUED');
  perform pg_notify('jaseb_runtime_work', p_candidate_ids[1]::text);
end;
$$;

revoke all on function public.cancel_auto_comment_candidates(uuid[], text) from public;

create or replace function public.invalidate_auto_comment_configuration()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_candidate_ids uuid[];
begin
  if tg_table_name = 'auto_comment_divisions' then
    if tg_op = 'UPDATE' and new.active and new.mode is not distinct from old.mode then return new; end if;
    select array_agg(id) into v_candidate_ids from public.auto_comment_candidates where division_id = old.id;
  elsif tg_table_name = 'auto_comment_channel_targets' then
    if tg_op = 'UPDATE' and new.active and new.source_channel_ref is not distinct from old.source_channel_ref then return new; end if;
    select array_agg(id) into v_candidate_ids from public.auto_comment_candidates where channel_target_id = old.id;
  elsif tg_table_name = 'auto_comment_division_templates' then
    if tg_op = 'UPDATE' and new.active and new.text_content is not distinct from old.text_content then return new; end if;
    select array_agg(id) into v_candidate_ids from public.auto_comment_candidates where selected_template_id = old.id;
  elsif tg_table_name = 'auto_comment_division_keywords' then
    select array_agg(id) into v_candidate_ids from public.auto_comment_candidates where division_id = old.division_id;
  elsif tg_table_name = 'auto_comment_division_channels' then
    select array_agg(id) into v_candidate_ids
      from public.auto_comment_candidates
     where division_id = old.division_id and channel_target_id = old.channel_target_id;
  end if;
  perform public.cancel_auto_comment_candidates(v_candidate_ids, 'CONFIGURATION_CHANGED');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

-- Account/profile/assignment lifecycle changes are configuration changes too.
-- Cancel durable work instead of letting it unexpectedly resume after a later
-- reconnect with a new session or account selection.
create or replace function public.invalidate_telegram_account_runtime_work()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_operation record; v_candidate_ids uuid[];
begin
  if old.status is not distinct from new.status or new.status = 'READY' then return new; end if;
  for v_operation in
    select operation.id, operation.user_id
      from public.workflow_operations operation
     where operation.account_id = old.id and operation.operation_type = 'BROADCAST'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, v_operation.user_id, 'ACCOUNT_UNAVAILABLE');
  end loop;
  select array_agg(candidate.id) into v_candidate_ids
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
   where division.account_id = old.id
     and candidate.status in ('PENDING_REVIEW', 'COMMENT_QUEUED');
  perform public.cancel_auto_comment_candidates(v_candidate_ids, 'ACCOUNT_UNAVAILABLE');
  return new;
end;
$$;

create or replace function public.invalidate_userbot_profile_runtime_work()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_operation record; v_candidate_ids uuid[];
begin
  if old.status is not distinct from new.status
     and old.active_account_id is not distinct from new.active_account_id then return new; end if;
  if old.active_account_id is null then return new; end if;
  if new.status = 'CONNECTED' and new.active_account_id is not distinct from old.active_account_id then return new; end if;
  for v_operation in
    select operation.id, operation.user_id
      from public.workflow_operations operation
     where operation.user_id = old.user_id and operation.account_id = old.active_account_id
       and operation.operation_type = 'BROADCAST'
       and operation.payload->>'accountMode' = 'USERBOT'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, v_operation.user_id, 'USERBOT_DISCONNECTED');
  end loop;
  select array_agg(candidate.id) into v_candidate_ids
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
   where division.user_id = old.user_id and division.account_id = old.active_account_id
     and candidate.status in ('PENDING_REVIEW', 'COMMENT_QUEUED');
  perform public.cancel_auto_comment_candidates(v_candidate_ids, 'USERBOT_DISCONNECTED');
  return new;
end;
$$;

create or replace function public.invalidate_worker_assignment_runtime_work()
returns trigger
language plpgsql
set search_path = public
as $$
declare v_operation record;
begin
  if old.status not in ('RESERVED', 'ACTIVE') or new.status in ('RESERVED', 'ACTIVE') then return new; end if;
  for v_operation in
    select operation.id, operation.user_id
      from public.workflow_operations operation
     where operation.user_id = old.user_id and operation.account_id = old.worker_account_id
       and operation.operation_type = 'BROADCAST'
       and operation.payload->>'accountMode' = 'JASEB_WORKER'
       and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     for update
  loop
    perform public.cancel_broadcast_operation(v_operation.id, v_operation.user_id, 'WORKER_RELEASED');
  end loop;
  return new;
end;
$$;

drop trigger if exists telegram_accounts_cancel_runtime_work on public.telegram_accounts;
create trigger telegram_accounts_cancel_runtime_work
after update of status on public.telegram_accounts
for each row execute function public.invalidate_telegram_account_runtime_work();

drop trigger if exists userbot_profiles_cancel_runtime_work on public.userbot_profiles;
create trigger userbot_profiles_cancel_runtime_work
after update of status, active_account_id on public.userbot_profiles
for each row execute function public.invalidate_userbot_profile_runtime_work();

drop trigger if exists worker_assignments_cancel_runtime_work on public.worker_assignments;
create trigger worker_assignments_cancel_runtime_work
after update of status on public.worker_assignments
for each row execute function public.invalidate_worker_assignment_runtime_work();

drop trigger if exists auto_comment_divisions_cancel_stale_work on public.auto_comment_divisions;
create trigger auto_comment_divisions_cancel_stale_work
before delete or update of active, mode on public.auto_comment_divisions
for each row execute function public.invalidate_auto_comment_configuration();

drop trigger if exists auto_comment_channel_targets_cancel_stale_work on public.auto_comment_channel_targets;
create trigger auto_comment_channel_targets_cancel_stale_work
before delete or update of active, source_channel_ref on public.auto_comment_channel_targets
for each row execute function public.invalidate_auto_comment_configuration();

drop trigger if exists auto_comment_templates_cancel_stale_work on public.auto_comment_division_templates;
create trigger auto_comment_templates_cancel_stale_work
before delete or update of active, text_content on public.auto_comment_division_templates
for each row execute function public.invalidate_auto_comment_configuration();

drop trigger if exists auto_comment_keywords_cancel_stale_work on public.auto_comment_division_keywords;
create trigger auto_comment_keywords_cancel_stale_work
before delete or update of keyword on public.auto_comment_division_keywords
for each row execute function public.invalidate_auto_comment_configuration();

drop trigger if exists auto_comment_mappings_cancel_stale_work on public.auto_comment_division_channels;
create trigger auto_comment_mappings_cancel_stale_work
before delete on public.auto_comment_division_channels
for each row execute function public.invalidate_auto_comment_configuration();

drop trigger if exists userbot_profiles_monitor_reload on public.userbot_profiles;
create trigger userbot_profiles_monitor_reload
after update of active_account_id, status, auto_comment_enabled on public.userbot_profiles
for each row execute function public.notify_auto_comment_monitor_config();

create or replace view public.auto_comment_runtime_eligible_operations
with (security_invoker = true)
as
select operation.id as operation_id,
       operation.user_id,
       operation.account_id,
       operation.created_at as operation_created_at,
       account.account_type,
       account.runtime_retry_at
  from public.workflow_operations operation
  join public.telegram_accounts account on account.id = operation.account_id
  join public.userbot_profiles profile
    on profile.user_id = operation.user_id and profile.active_account_id = operation.account_id
 where operation.operation_type = 'AUTO_COMMENT'
   and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
   and account.account_type = 'USERBOT' and account.status = 'READY'
   and profile.status = 'CONNECTED' and profile.auto_comment_enabled
   and exists (
     select 1 from public.entitlements entitlement
      where entitlement.user_id = operation.user_id
        and entitlement.status = 'ACTIVE' and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = 'USERBOT'
        and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
   );

revoke all on public.auto_comment_runtime_eligible_operations from public;

create or replace view public.auto_comment_runtime_eligible_targets
with (security_invoker = true)
as
select target.id as channel_target_id,
       target.user_id,
       target.account_id,
       target.resolution_status,
       target.resolution_available_at,
       null::timestamptz as monitoring_available_at,
       exists (
         select 1 from public.auto_comment_division_channels mapping
          where mapping.channel_target_id = target.id
       ) as has_division
  from public.auto_comment_channel_targets target
  join public.telegram_accounts account on account.id = target.account_id
  join public.userbot_profiles profile
    on profile.user_id = target.user_id and profile.active_account_id = target.account_id
 where target.active and account.status = 'READY'
   and profile.status = 'CONNECTED' and profile.auto_comment_enabled
   and exists (
     select 1 from public.entitlements entitlement
      where entitlement.user_id = target.user_id
        and entitlement.status = 'ACTIVE' and entitlement.expires_at > now()
        and entitlement.package_snapshot->>'packageType' = 'USERBOT'
        and entitlement.package_snapshot->'features' ? 'AUTO_COMMENT_MF'
   );

revoke all on public.auto_comment_runtime_eligible_targets from public;

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
       and target.cancel_requested_at is null
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
       and target.cancel_requested_at is null
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
       and command.cancel_requested_at is null
       and eligible.resolution_status = 'READY'
       and public.auto_comment_candidate_is_current(candidate.id)
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

revoke all on function public.list_broadcast_runtime_accounts(integer, integer, timestamptz, integer) from public;

create or replace function public.validate_auto_comment_execution(
  p_command_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns text
language plpgsql
set search_path = public
as $$
declare v_candidate_id uuid; v_operation_id uuid;
begin
  select command.auto_comment_candidate_id, command.operation_id
    into v_candidate_id, v_operation_id
    from public.workflow_commands command
   where command.id = p_command_id and command.account_id = p_account_id
     and command.kind = 'COMMENT_TEXT' and command.status = 'CLAIMED'
     and command.lease_owner = p_lease_owner and command.fencing_token = p_account_fencing_token
   for update of command;
  if not found then return 'FENCED_OUT'; end if;
  if not exists (
    select 1 from public.account_leases lease
     where lease.account_id = p_account_id and lease.lease_owner = p_lease_owner
       and lease.fencing_token = p_account_fencing_token and lease.lease_until > now()
  ) then return 'FENCED_OUT'; end if;

  if exists (
    select 1 from public.workflow_commands command
     where command.id = p_command_id and command.cancel_requested_at is null
  ) and public.auto_comment_candidate_is_current(v_candidate_id) then
    return 'AUTHORIZED';
  end if;

  update public.workflow_commands
     set status = 'CANCELLED', lease_owner = null, lease_until = null,
         cancel_requested_at = coalesce(cancel_requested_at, now()),
         cancel_reason = coalesce(cancel_reason, 'EXECUTION_NO_LONGER_AUTHORIZED'),
         last_error_code = coalesce(cancel_reason, 'EXECUTION_NO_LONGER_AUTHORIZED'),
         updated_at = now()
   where id = p_command_id;
  update public.workflow_operations
     set status = 'CANCELLED', error_code = 'EXECUTION_NO_LONGER_AUTHORIZED', updated_at = now()
   where id = v_operation_id;
  update public.auto_comment_candidates
     set status = 'REJECTED', error_code = 'EXECUTION_NO_LONGER_AUTHORIZED', updated_at = now()
   where id = v_candidate_id and status in ('PENDING_REVIEW', 'COMMENT_QUEUED');
  return 'CANCELLED';
end;
$$;

revoke all on function public.validate_auto_comment_execution(uuid, uuid, uuid, bigint) from public;

drop function public.claim_next_workflow_command(uuid, uuid, bigint, integer);
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
  if not exists (
    select 1 from public.account_leases lease
     where lease.account_id = p_account_id and lease.lease_owner = p_lease_owner
       and lease.fencing_token = p_account_fencing_token and lease.lease_until > now()
  ) then raise exception using errcode = 'P0001', message = 'ACCOUNT_LEASE_NOT_HELD'; end if;

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
      join public.auto_comment_candidates candidate on candidate.id = command.auto_comment_candidate_id
      join public.auto_comment_runtime_eligible_operations eligible on eligible.operation_id = operation.id
     where command.account_id = p_account_id and command.kind = 'COMMENT_TEXT'
       and command.status in ('PENDING', 'FAILED_RETRYABLE')
       and command.available_at <= now() and command.cancel_requested_at is null
       and candidate.status = 'COMMENT_QUEUED'
       and public.auto_comment_candidate_is_current(candidate.id)
     order by operation.created_at, command.created_at, command.id
     for update of command skip locked limit 1
  )
  update public.workflow_commands command
     set status = 'CLAIMED', lease_owner = p_lease_owner,
         fencing_token = p_account_fencing_token,
         lease_until = now() + make_interval(secs => p_command_lease_seconds),
         attempt_count = command.attempt_count + 1
    from candidate_command where command.id = candidate_command.id
  returning command.id, command.operation_id, command.account_id, command.kind,
            command.target_id, command.payload, command.attempt_count,
            command.fencing_token, command.lease_until;
end;
$$;

revoke all on function public.claim_next_workflow_command(uuid, uuid, bigint, integer) from public;

-- User-visible source readiness: discussion resolution and central monitor
-- membership/listener readiness are distinct facts.
create or replace view public.auto_comment_target_runtime_status
with (security_invoker = true)
as
select target.id as channel_target_id,
       source.status as monitor_status,
       source.last_error_code as monitor_error_code,
       source.last_event_at as monitor_last_event_at
  from public.auto_comment_channel_targets target
  join public.auto_comment_monitor_sources source on source.id = target.monitor_source_id;

revoke all on public.auto_comment_target_runtime_status from public;

notify jaseb_auto_comment_monitor;
notify jaseb_runtime_work;
