-- Jasa Sebar efficiency foundation.
--
-- 1. A Telegram membership belongs to an account/target pair, not to one
--    broadcast cycle. Cache successful preparation so recurring campaigns do
--    not resolve and call channels.getParticipant for the same pair forever.
-- 2. Link recurring operations to their campaign and never admit a new cycle
--    while an older cycle is still non-terminal. Missed intervals coalesce
--    into the next real cycle instead of producing an unbounded active queue.

create table public.broadcast_account_targets (
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  source_lpm_target_id uuid not null references public.broadcast_lpm_targets(id) on delete cascade,
  telegram_target_ref text not null
    check (char_length(btrim(telegram_target_ref)) between 1 and 256),
  state text not null default 'UNKNOWN'
    check (state in ('UNKNOWN', 'READY', 'APPROVAL_PENDING', 'INVALID')),
  resolved_title text,
  verified_at timestamptz,
  retry_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (account_id, source_lpm_target_id),
  check ((state = 'READY') = (verified_at is not null)),
  check ((state = 'APPROVAL_PENDING') = (retry_at is not null))
);

comment on table public.broadcast_account_targets
  is 'Reusable Telegram preparation state for one account/LPM-target pair; prevents membership checks on every recurring broadcast cycle.';
comment on column public.broadcast_account_targets.telegram_target_ref
  is 'Target ref that was actually prepared. A changed ref invalidates the cached state.';

create index broadcast_account_targets_state_retry_idx
  on public.broadcast_account_targets (state, retry_at, account_id);

alter table public.broadcast_account_targets enable row level security;

insert into public.broadcast_account_targets (
  account_id, source_lpm_target_id, telegram_target_ref, state,
  resolved_title, verified_at, retry_at, last_error_code
)
select prepared.account_id, prepared.source_lpm_target_id,
       prepared.telegram_target_ref, 'READY', prepared.resolved_title,
       prepared.verified_at, null, null
  from (
    select distinct on (operation.account_id, target.source_lpm_target_id)
           operation.account_id, target.source_lpm_target_id,
           target.telegram_target_ref, target.resolved_title,
           coalesce(target.last_success_at, target.updated_at) as verified_at
      from public.broadcast_targets target
      join public.workflow_operations operation on operation.id = target.operation_id
     where target.source_lpm_target_id is not null
       and target.preparation_status = 'READY'
     order by operation.account_id, target.source_lpm_target_id,
              target.updated_at desc, target.id desc
  ) prepared;

create trigger broadcast_account_targets_set_updated_at
before update on public.broadcast_account_targets
for each row execute function public.set_updated_at();

create function public.hydrate_broadcast_target_preparation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cached public.broadcast_account_targets%rowtype;
begin
  if new.source_lpm_target_id is null then return new; end if;

  select cache.* into cached
    from public.broadcast_account_targets cache
    join public.workflow_operations operation on operation.id = new.operation_id
   where cache.account_id = operation.account_id
     and cache.source_lpm_target_id = new.source_lpm_target_id
     and lower(btrim(cache.telegram_target_ref)) = lower(btrim(new.telegram_target_ref));

  if not found then return new; end if;

  if cached.state = 'READY' then
    new.preparation_status := 'READY';
    new.resolved_title := cached.resolved_title;
    new.last_error_code := null;
  elsif cached.state = 'APPROVAL_PENDING' then
    new.preparation_status := 'WAITING_APPROVAL';
    new.preparation_available_at := greatest(coalesce(cached.retry_at, now()), now());
    new.preparation_approval_requested_at := coalesce(new.preparation_approval_requested_at, cached.created_at);
    new.last_error_code := 'JOIN_APPROVAL_PENDING';
  end if;
  return new;
end;
$$;

create trigger broadcast_targets_hydrate_preparation
before insert on public.broadcast_targets
for each row execute function public.hydrate_broadcast_target_preparation();

create function public.cache_broadcast_target_preparation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_account_id uuid;
  cached_state text;
  cached_verified_at timestamptz;
  cached_retry_at timestamptz;
begin
  if new.source_lpm_target_id is null
     or new.preparation_status not in ('READY', 'WAITING_APPROVAL', 'FAILED_FINAL') then
    return new;
  end if;

  select account_id into target_account_id
    from public.workflow_operations
   where id = new.operation_id;
  if target_account_id is null then return new; end if;

  cached_state := case new.preparation_status
    when 'READY' then 'READY'
    when 'WAITING_APPROVAL' then 'APPROVAL_PENDING'
    else 'INVALID'
  end;
  cached_verified_at := case when cached_state = 'READY' then now() else null end;
  cached_retry_at := case
    when cached_state = 'APPROVAL_PENDING' then greatest(new.preparation_available_at, now())
    else null
  end;

  insert into public.broadcast_account_targets (
    account_id, source_lpm_target_id, telegram_target_ref, state,
    resolved_title, verified_at, retry_at, last_error_code
  ) values (
    target_account_id, new.source_lpm_target_id, new.telegram_target_ref,
    cached_state, new.resolved_title, cached_verified_at, cached_retry_at,
    new.last_error_code
  )
  on conflict (account_id, source_lpm_target_id) do update
    set telegram_target_ref = excluded.telegram_target_ref,
        state = excluded.state,
        resolved_title = coalesce(excluded.resolved_title, public.broadcast_account_targets.resolved_title),
        verified_at = excluded.verified_at,
        retry_at = excluded.retry_at,
        last_error_code = excluded.last_error_code;
  return new;
end;
$$;

create trigger broadcast_targets_cache_preparation
after update of preparation_status, preparation_available_at, resolved_title, last_error_code
on public.broadcast_targets
for each row
when (old.preparation_status is distinct from new.preparation_status
      or old.preparation_available_at is distinct from new.preparation_available_at
      or old.resolved_title is distinct from new.resolved_title
      or old.last_error_code is distinct from new.last_error_code)
execute function public.cache_broadcast_target_preparation();

create function public.invalidate_broadcast_target_cache_on_ref_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(btrim(old.telegram_target_ref)) is distinct from lower(btrim(new.telegram_target_ref)) then
    update public.broadcast_account_targets
       set telegram_target_ref = new.telegram_target_ref,
           state = 'UNKNOWN', verified_at = null, retry_at = null,
           last_error_code = 'TARGET_REF_CHANGED'
     where source_lpm_target_id = new.id;
  end if;
  return new;
end;
$$;

create trigger broadcast_lpm_targets_invalidate_membership_cache
after update of telegram_target_ref on public.broadcast_lpm_targets
for each row execute function public.invalidate_broadcast_target_cache_on_ref_change();

create function public.invalidate_broadcast_target_cache_on_delivery_error()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_account_id uuid;
begin
  if new.source_lpm_target_id is null
     or new.delivery_status <> 'FAILED_FINAL'
     or new.last_error_code not in ('CHAT_WRITE_FORBIDDEN', 'TARGET_NOT_FOUND') then
    return new;
  end if;
  select account_id into target_account_id
    from public.workflow_operations
   where id = new.operation_id;
  update public.broadcast_account_targets
     set state = 'UNKNOWN', verified_at = null, retry_at = null,
         last_error_code = new.last_error_code
   where account_id = target_account_id
     and source_lpm_target_id = new.source_lpm_target_id;
  return new;
end;
$$;

create trigger broadcast_targets_invalidate_cache_on_delivery_error
after update of delivery_status, last_error_code on public.broadcast_targets
for each row
when (new.delivery_status = 'FAILED_FINAL')
execute function public.invalidate_broadcast_target_cache_on_delivery_error();

-- Existing recurring operations are linked before the new scheduler guard is
-- enabled. This is metadata-only; no active delivery is cancelled.
alter table public.workflow_operations
  add column campaign_id uuid references public.broadcast_campaigns(id) on delete set null;

update public.workflow_operations operation
   set campaign_id = substring(
     operation.idempotency_key from
     '^campaign:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):'
   )::uuid
 where operation.operation_type = 'BROADCAST'
   and operation.idempotency_key ~
     '^campaign:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:'
   and exists (
     select 1 from public.broadcast_campaigns campaign
      where campaign.id = substring(
        operation.idempotency_key from
        '^campaign:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):'
      )::uuid
   );

create index workflow_operations_campaign_created_idx
  on public.workflow_operations (campaign_id, created_at desc)
  where campaign_id is not null;

create function public.create_broadcast_campaign_cycle(
  p_campaign_id uuid,
  p_cycled_at timestamptz
)
returns table (result_status text, operation_id uuid)
language plpgsql
set search_path = public
as $$
declare
  campaign_row public.broadcast_campaigns%rowtype;
  created record;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_campaign_id::text, 1401));
  select * into campaign_row
    from public.broadcast_campaigns
   where id = p_campaign_id and status = 'ACTIVE'
   for update;
  if not found then
    return query select 'CAMPAIGN_INACTIVE'::text, null::uuid;
    return;
  end if;

  if exists (
    select 1 from public.workflow_operations operation
     where operation.campaign_id = p_campaign_id
       and operation.status not in (
         'SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
       )
  ) then
    return query select 'ACTIVE_CYCLE_EXISTS'::text, null::uuid;
    return;
  end if;

  select * into created
    from public.create_broadcast_operation(
      campaign_row.user_id,
      campaign_row.account_mode,
      campaign_row.material_id,
      campaign_row.target_ids,
      'campaign:' || campaign_row.id::text || ':' || p_cycled_at::text
    );

  update public.workflow_operations
     set campaign_id = p_campaign_id
   where id = created.operation_id;

  return query select created.result_status::text, created.operation_id::uuid;
end;
$$;

comment on function public.create_broadcast_campaign_cycle(uuid, timestamptz)
  is 'Atomically admits at most one active operation for a recurring campaign; overdue intervals coalesce instead of creating an active backlog.';
revoke all on function public.create_broadcast_campaign_cycle(uuid, timestamptz) from public;

create or replace function public.due_broadcast_campaigns(p_limit integer)
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
       select due.id
         from public.broadcast_campaigns due
        where due.status = 'ACTIVE'
          and due.next_cycle_at <= now()
          and not exists (
            select 1 from public.workflow_operations operation
             where operation.campaign_id = due.id
               and operation.status not in (
                 'SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
               )
          )
        order by due.next_cycle_at
        limit greatest(p_limit, 0)
        for update of due skip locked
     )
    returning campaign.id, campaign.user_id, campaign.account_mode,
              campaign.material_id, campaign.target_ids, campaign.last_cycle_at;
end;
$$;

create or replace function public.reconcile_broadcast_campaigns(
  p_limit integer,
  p_failure_threshold integer
)
returns table (
  out_campaign_id uuid,
  out_stopped boolean,
  out_consecutive_failures integer
)
language plpgsql
set search_path = public
as $$
declare
  campaign_row record;
  latest_operation record;
  next_failures integer;
begin
  for campaign_row in
    select id, last_reconciled_operation_id, consecutive_failures
      from public.broadcast_campaigns
     where status = 'ACTIVE'
     order by updated_at
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    select operation.id, operation.status
      into latest_operation
      from public.workflow_operations operation
     where operation.campaign_id = campaign_row.id
       and operation.status in (
         'SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
       )
       and (
         campaign_row.last_reconciled_operation_id is null
         or not exists (
           select 1 from public.workflow_operations retained
            where retained.id = campaign_row.last_reconciled_operation_id
         )
         or operation.created_at > (
           select previous.created_at
             from public.workflow_operations previous
            where previous.id = campaign_row.last_reconciled_operation_id
         )
       )
     order by operation.created_at desc
     limit 1;

    continue when latest_operation.id is null;

    if latest_operation.status = 'SUCCEEDED' then
      update public.broadcast_campaigns
         set consecutive_failures = 0,
             last_reconciled_operation_id = latest_operation.id
       where id = campaign_row.id;
      out_campaign_id := campaign_row.id;
      out_stopped := false;
      out_consecutive_failures := 0;
      return next;
    else
      next_failures := campaign_row.consecutive_failures + 1;
      if next_failures >= p_failure_threshold then
        update public.broadcast_campaigns
           set consecutive_failures = next_failures,
               last_reconciled_operation_id = latest_operation.id,
               status = 'STOPPED',
               error_code = 'TOO_MANY_CONSECUTIVE_FAILURES'
         where id = campaign_row.id;
        out_stopped := true;
      else
        update public.broadcast_campaigns
           set consecutive_failures = next_failures,
               last_reconciled_operation_id = latest_operation.id
         where id = campaign_row.id;
        out_stopped := false;
      end if;
      out_campaign_id := campaign_row.id;
      out_consecutive_failures := next_failures;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.reconcile_broadcast_campaigns(integer, integer) from public;

-- Approval requests are provider state, not hot work. Exponential rechecks
-- start at one minute and cap at one hour instead of waking every 30 seconds.
drop function public.claim_next_broadcast_preparation(uuid, uuid, bigint);

create function public.claim_next_broadcast_preparation(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint
)
returns table (
  target_id uuid,
  operation_id uuid,
  telegram_target_ref text,
  previous_status text,
  attempt_count integer
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

  update public.broadcast_targets target
     set preparation_status = 'QUEUED', preparation_available_at = now(),
         preparation_lease_owner = null, preparation_fencing_token = null,
         last_error_code = 'PREPARATION_LEASE_FENCED'
    from public.workflow_operations operation
   where operation.id = target.operation_id
     and operation.account_id = p_account_id
     and target.preparation_status in ('CHECKING', 'JOINING')
     and (
       target.preparation_lease_owner is distinct from p_lease_owner
       or target.preparation_fencing_token is distinct from p_account_fencing_token
     );

  return query
  with candidate as (
    select target.id, target.preparation_status as previous_status
      from public.broadcast_targets target
      join public.broadcast_runtime_eligible_operations eligible
        on eligible.operation_id = target.operation_id
     where eligible.account_id = p_account_id
       and (eligible.runtime_retry_at is null or eligible.runtime_retry_at <= now())
       and target.preparation_status in ('QUEUED', 'WAITING_APPROVAL')
       and target.preparation_available_at <= now()
     order by eligible.operation_created_at, target.sequence_number,
              target.created_at, target.id
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
  returning target.id, target.operation_id, target.telegram_target_ref,
            candidate.previous_status, target.preparation_attempt_count;
end;
$$;

comment on function public.claim_next_broadcast_preparation(uuid, uuid, bigint)
  is 'Claims one uncached or approval-waiting LPM target and exposes the attempt count for bounded exponential rechecks.';
revoke all on function public.claim_next_broadcast_preparation(uuid, uuid, bigint) from public;

-- Campaign scheduling uses the table as durable state and NOTIFY only as a
-- wake-up hint. Operation completion also wakes the scheduler because a
-- previously coalesced campaign may become eligible at that moment.
create function public.next_broadcast_campaign_due_at()
returns timestamptz
language sql
stable
set search_path = public
as $$
  select min(campaign.next_cycle_at)
    from public.broadcast_campaigns campaign
   where campaign.status = 'ACTIVE'
     and not exists (
       select 1 from public.workflow_operations operation
        where operation.campaign_id = campaign.id
          and operation.status not in (
            'SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
          )
     );
$$;

revoke all on function public.next_broadcast_campaign_due_at() from public;

create function public.notify_broadcast_campaign_scheduler()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform pg_notify('jaseb_broadcast_campaigns', 'changed');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger broadcast_campaigns_scheduler_wakeup
after insert or update or delete on public.broadcast_campaigns
for each statement execute function public.notify_broadcast_campaign_scheduler();

create trigger workflow_operations_campaign_scheduler_wakeup
after update of status on public.workflow_operations
for each row
when (new.campaign_id is not null and old.status is distinct from new.status)
execute function public.notify_broadcast_campaign_scheduler();
