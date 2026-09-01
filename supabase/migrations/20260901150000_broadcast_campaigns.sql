-- Adds group-title capture for Jasa Sebar targets (riwayat sebar needs a real
-- display name, not just the raw @username ref) and a recurring "campaign"
-- primitive that re-runs the existing one-shot create_broadcast_operation on a
-- timer instead of building a second send pipeline.

alter table public.broadcast_targets
  add column resolved_title text;

comment on column public.broadcast_targets.resolved_title
  is 'Chat title captured from Telegram at preparation time, for riwayat sebar display; null until first successful resolveTarget.';

drop function if exists public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer);

create function public.transition_broadcast_preparation(
  p_target_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_expected_status text,
  p_status text,
  p_error_code text default null,
  p_retry_after_seconds integer default null,
  p_resolved_title text default null
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
         delivery_status = case when p_status = 'FAILED_FINAL' then 'FAILED_FINAL' else target.delivery_status end,
         resolved_title = case when p_status = 'READY' and p_resolved_title is not null then p_resolved_title else target.resolved_title end
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

comment on function public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer, text)
  is 'Persists Grup LPM preparation including non-final WAITING_APPROVAL under account fencing; captures the resolved chat title on READY.';
revoke all on function public.transition_broadcast_preparation(uuid, uuid, uuid, bigint, text, text, text, integer, text) from public;

-- Recurring campaign: periodically re-runs create_broadcast_operation, the
-- same one-shot pipeline a user triggers manually, instead of a second send
-- engine. One row per cycle in workflow_operations/broadcast_targets is what
-- riwayat sebar reads from.

create table public.broadcast_campaigns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  account_mode text not null,
  material_id uuid not null references public.broadcast_materials(id) on delete restrict,
  target_ids uuid[] not null,
  interval_seconds integer not null,
  status text not null default 'ACTIVE',
  error_code text,
  last_cycle_at timestamptz,
  next_cycle_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint broadcast_campaigns_account_mode_check check (account_mode in ('JASEB_WORKER', 'USERBOT')),
  constraint broadcast_campaigns_status_check check (status in ('ACTIVE', 'STOPPED')),
  constraint broadcast_campaigns_interval_seconds_check check (interval_seconds >= 300),
  constraint broadcast_campaigns_target_ids_check check (cardinality(target_ids) between 1 and 50)
);

comment on table public.broadcast_campaigns
  is 'User-started recurring Jasa Sebar: the engine re-runs create_broadcast_operation for this material/targets every interval_seconds until stopped.';

create index broadcast_campaigns_due_idx on public.broadcast_campaigns (next_cycle_at) where status = 'ACTIVE';
create unique index broadcast_campaigns_one_active_per_user_idx on public.broadcast_campaigns (user_id) where status = 'ACTIVE';

alter table public.broadcast_campaigns enable row level security;
create policy broadcast_campaigns_owner_read on public.broadcast_campaigns for select
  to authenticated using (user_id = (select auth.uid()));

create trigger broadcast_campaigns_set_updated_at before update on public.broadcast_campaigns
  for each row execute function set_updated_at();

create function public.create_broadcast_campaign(
  p_user_id uuid,
  p_account_mode text,
  p_material_id uuid,
  p_target_ids uuid[],
  p_interval_seconds integer
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  selected_target_count integer;
  interval_floor integer := 300;
  package_min_interval integer;
  has_active_entitlement boolean;
  created_campaign_id uuid;
begin
  if p_account_mode not in ('JASEB_WORKER', 'USERBOT') then
    raise exception using errcode = 'P0001', message = 'INVALID_ACCOUNT_MODE';
  end if;
  if p_target_ids is null or cardinality(p_target_ids) = 0 or cardinality(p_target_ids) > 50 then
    raise exception using errcode = 'P0001', message = 'BROADCAST_TARGETS_REQUIRED';
  end if;
  if cardinality(p_target_ids) <> (select count(distinct target_id) from unnest(p_target_ids) as target_id) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_LPM_TARGET';
  end if;

  select count(*) > 0, max(nullif(entitlement.package_snapshot->>'intervalMinSeconds', '')::integer)
    into has_active_entitlement, package_min_interval
    from public.entitlements entitlement
   where entitlement.user_id = p_user_id
     and entitlement.status = 'ACTIVE'
     and entitlement.expires_at > now()
     and entitlement.package_snapshot->>'packageType' = p_account_mode
     and entitlement.package_snapshot->'features' ? 'JASEB';
  if not coalesce(has_active_entitlement, false) then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;
  if package_min_interval is not null and package_min_interval > interval_floor then
    interval_floor := package_min_interval;
  end if;
  if p_interval_seconds < interval_floor then
    raise exception using errcode = 'P0001', message = 'INTERVAL_TOO_SHORT';
  end if;

  if not exists (
    select 1 from public.broadcast_materials where id = p_material_id and user_id = p_user_id and active
  ) then
    raise exception using errcode = 'P0001', message = 'BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE';
  end if;

  select count(*) into selected_target_count
    from public.broadcast_lpm_targets
   where user_id = p_user_id and active and id = any(p_target_ids);
  if selected_target_count <> cardinality(p_target_ids) then
    raise exception using errcode = 'P0001', message = 'LPM_TARGET_NOT_FOUND_OR_INACTIVE';
  end if;

  begin
    insert into public.broadcast_campaigns (user_id, account_mode, material_id, target_ids, interval_seconds)
    values (p_user_id, p_account_mode, p_material_id, p_target_ids, p_interval_seconds)
    returning id into created_campaign_id;
  exception when unique_violation then
    raise exception using errcode = 'P0001', message = 'CAMPAIGN_ALREADY_ACTIVE';
  end;

  return created_campaign_id;
end;
$$;

comment on function public.create_broadcast_campaign(uuid, text, uuid, uuid[], integer)
  is 'Starts a recurring Jasa Sebar campaign; the engine scheduler drives actual cycles via due_broadcast_campaigns.';
revoke all on function public.create_broadcast_campaign(uuid, text, uuid, uuid[], integer) from public;

create function public.stop_broadcast_campaign(p_campaign_id uuid, p_user_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  updated boolean := false;
begin
  update public.broadcast_campaigns
     set status = 'STOPPED'
   where id = p_campaign_id and user_id = p_user_id and status = 'ACTIVE'
  returning true into updated;
  return coalesce(updated, false);
end;
$$;

comment on function public.stop_broadcast_campaign(uuid, uuid)
  is 'Idempotent user-triggered stop; the scheduler simply will not pick the campaign up on its next tick.';
revoke all on function public.stop_broadcast_campaign(uuid, uuid) from public;

create function public.due_broadcast_campaigns(p_limit integer)
returns table (
  campaign_id uuid,
  user_id uuid,
  account_mode text,
  material_id uuid,
  target_ids uuid[],
  cycled_at timestamptz
)
language plpgsql
set search_path = public
as $$
begin
  return query
    update public.broadcast_campaigns campaign
       set next_cycle_at = now() + make_interval(secs => campaign.interval_seconds),
           last_cycle_at = now()
     where campaign.id in (
       select due.id from public.broadcast_campaigns due
        where due.status = 'ACTIVE' and due.next_cycle_at <= now()
        order by due.next_cycle_at
        limit greatest(p_limit, 0)
        for update skip locked
     )
    returning campaign.id, campaign.user_id, campaign.account_mode, campaign.material_id, campaign.target_ids, campaign.last_cycle_at;
end;
$$;

comment on function public.due_broadcast_campaigns(integer)
  is 'Engine-only: claims and reschedules due campaigns atomically so a crash mid-cycle cannot tight-loop or strand a campaign.';
revoke all on function public.due_broadcast_campaigns(integer) from public;

create function public.fail_broadcast_campaign(p_campaign_id uuid, p_error_code text)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.broadcast_campaigns
     set status = 'STOPPED', error_code = p_error_code
   where id = p_campaign_id and status = 'ACTIVE';
end;
$$;

comment on function public.fail_broadcast_campaign(uuid, text)
  is 'Engine-only: auto-stops a campaign whose cycle attempt failed (e.g. account detached), recording why.';
revoke all on function public.fail_broadcast_campaign(uuid, text) from public;
