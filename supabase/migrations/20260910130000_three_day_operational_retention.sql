-- Bound high-volume operational data to a three-day working set. Cleanup is
-- intentionally batched: the hourly engine tick makes steady progress without
-- holding long delete locks or producing one large burst of dead tuples.

create index auto_comment_monitor_events_retention_idx
  on public.auto_comment_monitor_events (received_at, id);
create index auto_comment_candidates_retention_idx
  on public.auto_comment_candidates (created_at, id);
create index incoming_channel_posts_retention_idx
  on public.incoming_channel_posts (received_at, id);
create index comment_matches_retention_idx
  on public.comment_matches (created_at, id);
create index workflow_operations_auto_comment_retention_idx
  on public.workflow_operations (created_at, id)
  where operation_type = 'AUTO_COMMENT';
create index telegram_account_auth_flows_terminal_retention_idx
  on public.telegram_account_auth_flows (updated_at, id)
  where status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED');

create or replace function public.prevent_auto_comment_review_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('app.auto_comment_retention_cleanup', true) = 'on' then
    return old;
  end if;
  raise exception using errcode = '55000', message = 'auto comment review is immutable';
end;
$$;

create function public.prune_expired_auto_comment_data(
  p_retention interval default interval '3 days',
  p_batch_size integer default 5000
)
returns table (
  monitor_events_deleted bigint,
  auto_comment_reviews_deleted bigint,
  auto_comment_candidates_deleted bigint,
  legacy_comment_matches_deleted bigint,
  incoming_channel_posts_deleted bigint,
  workflow_operations_deleted bigint
)
language plpgsql
set search_path = public
as $$
declare
  now_value timestamptz := now();
  cutoff_value timestamptz;
  candidate_ids uuid[] := '{}'::uuid[];
  candidate_operation_ids uuid[] := '{}'::uuid[];
  legacy_match_ids uuid[] := '{}'::uuid[];
  legacy_operation_ids uuid[] := '{}'::uuid[];
  v_monitor_events bigint := 0;
  v_reviews bigint := 0;
  v_candidates bigint := 0;
  v_legacy_matches bigint := 0;
  v_incoming_posts bigint := 0;
  v_operations bigint := 0;
  affected bigint := 0;
begin
  if p_retention <= interval '0' then
    raise exception using errcode = 'P0001', message = 'INVALID_RETENTION_WINDOW';
  end if;
  if p_batch_size is null or p_batch_size not between 1 and 50000 then
    raise exception using errcode = 'P0001', message = 'INVALID_RETENTION_BATCH_SIZE';
  end if;
  cutoff_value := now_value - p_retention;

  with prunable as (
    select event.id
      from public.auto_comment_monitor_events event
     where event.received_at < cutoff_value
     order by event.received_at, event.id
     limit p_batch_size
     for update skip locked
  )
  delete from public.auto_comment_monitor_events event
   using prunable
   where event.id = prunable.id;
  get diagnostics v_monitor_events = row_count;

  select coalesce(array_agg(selected.id), '{}'::uuid[])
    into candidate_ids
    from (
      select candidate.id
        from public.auto_comment_candidates candidate
       where candidate.created_at < cutoff_value
         and not exists (
           select 1
             from public.workflow_commands command
            where command.auto_comment_candidate_id = candidate.id
              and command.status in ('CLAIMED', 'SENDING')
              and command.lease_until > now_value
         )
       order by candidate.created_at, candidate.id
       limit p_batch_size
       for update skip locked
    ) selected;

  if cardinality(candidate_ids) > 0 then
    select coalesce(array_agg(distinct command.operation_id), '{}'::uuid[])
      into candidate_operation_ids
      from public.workflow_commands command
     where command.auto_comment_candidate_id = any(candidate_ids);

    perform set_config('app.auto_comment_retention_cleanup', 'on', true);
    delete from public.auto_comment_reviews review
     where review.candidate_id = any(candidate_ids);
    get diagnostics v_reviews = row_count;
    perform set_config('app.auto_comment_retention_cleanup', 'off', true);

    delete from public.workflow_commands command
     where command.auto_comment_candidate_id = any(candidate_ids);

    delete from public.workflow_operations operation
     where operation.id = any(candidate_operation_ids)
       and operation.operation_type = 'AUTO_COMMENT'
       and not exists (
         select 1 from public.workflow_commands command
          where command.operation_id = operation.id
       );
    get diagnostics affected = row_count;
    v_operations := v_operations + affected;

    delete from public.auto_comment_candidates candidate
     where candidate.id = any(candidate_ids);
    get diagnostics v_candidates = row_count;
  end if;

  select coalesce(array_agg(selected.id), '{}'::uuid[])
    into legacy_match_ids
    from (
      select match.id
        from public.comment_matches match
       where match.created_at < cutoff_value
         and not exists (
           select 1
             from public.workflow_commands command
            where command.comment_match_id = match.id
              and command.status in ('CLAIMED', 'SENDING')
              and command.lease_until > now_value
         )
       order by match.created_at, match.id
       limit p_batch_size
       for update skip locked
    ) selected;

  if cardinality(legacy_match_ids) > 0 then
    select coalesce(array_agg(distinct command.operation_id), '{}'::uuid[])
      into legacy_operation_ids
      from public.workflow_commands command
     where command.comment_match_id = any(legacy_match_ids);

    delete from public.workflow_commands command
     where command.comment_match_id = any(legacy_match_ids);

    delete from public.workflow_operations operation
     where operation.id = any(legacy_operation_ids)
       and operation.operation_type = 'AUTO_COMMENT'
       and not exists (
         select 1 from public.workflow_commands command
          where command.operation_id = operation.id
       );
    get diagnostics affected = row_count;
    v_operations := v_operations + affected;

    delete from public.comment_matches match
     where match.id = any(legacy_match_ids);
    get diagnostics v_legacy_matches = row_count;
  end if;

  with prunable as (
    select operation.id
      from public.workflow_operations operation
     where operation.operation_type = 'AUTO_COMMENT'
       and operation.created_at < cutoff_value
       and not exists (
         select 1 from public.workflow_commands command
          where command.operation_id = operation.id
       )
     order by operation.created_at, operation.id
     limit p_batch_size
     for update skip locked
  )
  delete from public.workflow_operations operation
   using prunable
   where operation.id = prunable.id;
  get diagnostics affected = row_count;
  v_operations := v_operations + affected;

  with prunable as (
    select post.id
      from public.incoming_channel_posts post
     where post.received_at < cutoff_value
       and not exists (
         select 1 from public.auto_comment_candidates candidate
          where candidate.incoming_post_id = post.id
       )
       and not exists (
         select 1 from public.comment_matches match
          where match.incoming_post_id = post.id
       )
     order by post.received_at, post.id
     limit p_batch_size
     for update skip locked
  )
  delete from public.incoming_channel_posts post
   using prunable
   where post.id = prunable.id;
  get diagnostics v_incoming_posts = row_count;

  return query select
    v_monitor_events,
    v_reviews,
    v_candidates,
    v_legacy_matches,
    v_incoming_posts,
    v_operations;
end;
$$;

-- The original retention entry point remains responsible for Jasa Sebar
-- history and expired authentication state. Auto Komen is handled by the
-- bounded function above so an hourly run cannot issue an unbounded delete.
create or replace function public.prune_expired_operational_data(
  p_broadcast_history_retention interval default interval '3 days',
  p_internal_retention interval default interval '3 days'
)
returns table (
  broadcast_targets_deleted bigint,
  workflow_operations_deleted bigint,
  auto_comment_candidates_deleted bigint,
  incoming_channel_posts_deleted bigint,
  api_sessions_deleted bigint,
  auth_flows_deleted bigint
)
language plpgsql
set search_path = public
as $$
declare
  now_value timestamptz := now();
  v_broadcast_targets bigint := 0;
  v_workflow_operations bigint := 0;
  v_api_sessions bigint := 0;
  v_auth_flows bigint := 0;
begin
  if p_broadcast_history_retention <= interval '0' or p_internal_retention <= interval '0' then
    raise exception using errcode = 'P0001', message = 'INVALID_RETENTION_WINDOW';
  end if;

  with prunable as (
    select target.id
      from public.broadcast_targets target
     where (target.delivery_status = 'SUCCEEDED' and target.last_success_at < now_value - p_broadcast_history_retention)
        or (target.delivery_status in ('FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN') and target.updated_at < now_value - p_internal_retention)
     order by target.updated_at, target.id
     limit 5000
     for update skip locked
  )
  delete from public.broadcast_targets target
   using prunable
   where target.id = prunable.id;
  get diagnostics v_broadcast_targets = row_count;

  with prunable as (
    select operation.id
      from public.workflow_operations operation
     where operation.operation_type = 'BROADCAST'
       and operation.status in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       and operation.updated_at < now_value - p_internal_retention
       and not exists (
         select 1 from public.broadcast_targets target
          where target.operation_id = operation.id
       )
     order by operation.updated_at, operation.id
     limit 5000
     for update skip locked
  )
  delete from public.workflow_operations operation
   using prunable
   where operation.id = prunable.id;
  get diagnostics v_workflow_operations = row_count;

  with prunable as (
    select session.id
      from public.api_sessions session
     where session.expires_at < now_value - p_internal_retention
     order by session.expires_at, session.id
     limit 5000
     for update skip locked
  )
  delete from public.api_sessions session
   using prunable
   where session.id = prunable.id;
  get diagnostics v_api_sessions = row_count;

  with prunable as (
    select flow.id
      from public.telegram_account_auth_flows flow
     where flow.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')
       and flow.updated_at < now_value - p_internal_retention
     order by flow.updated_at, flow.id
     limit 5000
     for update skip locked
  )
  delete from public.telegram_account_auth_flows flow
   using prunable
   where flow.id = prunable.id;
  get diagnostics v_auth_flows = row_count;

  return query select
    v_broadcast_targets,
    v_workflow_operations,
    0::bigint,
    0::bigint,
    v_api_sessions,
    v_auth_flows;
end;
$$;

revoke all on function public.prune_expired_auto_comment_data(interval, integer)
  from public, anon, authenticated;
grant execute on function public.prune_expired_auto_comment_data(interval, integer)
  to service_role;

comment on function public.prune_expired_auto_comment_data(interval, integer) is
  'Deletes at most one bounded batch per Auto Komen operational table after the retention window, including stale pending work and reviews, while preserving configuration, accounts, entitlements, and Telegram sessions.';
comment on function public.prune_expired_operational_data(interval, interval) is
  'Deletes bounded batches of terminal Jasa Sebar history and expired authentication state; Auto Komen is pruned separately by prune_expired_auto_comment_data.';
comment on table public.auto_comment_reviews is
  'Tepat/OOT decisions are immutable to application callers and removable only by the guarded backend retention path after their candidate exceeds the retention window.';
