-- Paced polling checkpoint for keyword matching against new channel posts.
-- Mirrors claim_next_auto_comment_preparation/transition_auto_comment_preparation's
-- claim-then-transition shape, scoped to READY targets instead of resolution state.

alter table public.auto_comment_channel_targets
  add column monitoring_last_post_id bigint check (monitoring_last_post_id is null or monitoring_last_post_id > 0),
  add column monitoring_available_at timestamptz not null default now();

create index auto_comment_channel_targets_monitoring_claim_idx
  on public.auto_comment_channel_targets (monitoring_available_at, created_at)
  where active and resolution_status = 'READY';

create function public.claim_next_auto_comment_monitoring(
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_poll_interval_seconds integer
)
returns table (
  channel_target_id uuid,
  source_channel_ref text,
  discussion_target_ref text,
  monitoring_last_post_id bigint
)
language plpgsql
set search_path = public
as $$
begin
  if p_poll_interval_seconds not between 1 and 86400 then
    raise exception using errcode = 'P0001', message = 'INVALID_MONITORING_POLL_INTERVAL';
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

  return query
  with candidate as (
    select target.id
      from public.auto_comment_channel_targets target
     where target.account_id = p_account_id
       and target.active
       and target.resolution_status = 'READY'
       and target.monitoring_available_at <= now()
       and exists (
         select 1 from public.auto_comment_division_channels mapping
          where mapping.channel_target_id = target.id
       )
     order by target.monitoring_available_at, target.id
     for update of target skip locked
     limit 1
  )
  update public.auto_comment_channel_targets target
     set monitoring_available_at = now() + make_interval(secs => p_poll_interval_seconds)
    from candidate
   where target.id = candidate.id
  returning target.id, target.source_channel_ref, target.discussion_target_ref, target.monitoring_last_post_id;
end;
$$;

create function public.advance_auto_comment_monitoring_checkpoint(
  p_channel_target_id uuid,
  p_account_id uuid,
  p_lease_owner uuid,
  p_account_fencing_token bigint,
  p_last_post_id bigint
)
returns boolean
language plpgsql
set search_path = public
as $$
declare advanced boolean;
begin
  if p_last_post_id <= 0 then
    raise exception using errcode = 'P0001', message = 'INVALID_MONITORING_CHECKPOINT';
  end if;
  if not exists (
    select 1 from public.account_leases account_lease
     where account_lease.account_id = p_account_id
       and account_lease.lease_owner = p_lease_owner
       and account_lease.fencing_token = p_account_fencing_token
       and account_lease.lease_until > now()
  ) then return false; end if;

  update public.auto_comment_channel_targets target
     set monitoring_last_post_id = greatest(coalesce(target.monitoring_last_post_id, 0), p_last_post_id)
   where target.id = p_channel_target_id
     and target.account_id = p_account_id
  returning true into advanced;
  return coalesce(advanced, false);
end;
$$;

comment on function public.claim_next_auto_comment_monitoring(uuid, uuid, bigint, integer)
  is 'Claims one READY channel target due for a keyword-matching poll under the fenced Userbot account lease.';
comment on function public.advance_auto_comment_monitoring_checkpoint(uuid, uuid, uuid, bigint, bigint)
  is 'Persists the highest channel post id scanned so far; never moves the checkpoint backwards.';
revoke all on function public.claim_next_auto_comment_monitoring(uuid, uuid, bigint, integer) from public;
revoke all on function public.advance_auto_comment_monitoring_checkpoint(uuid, uuid, uuid, bigint, bigint) from public;
