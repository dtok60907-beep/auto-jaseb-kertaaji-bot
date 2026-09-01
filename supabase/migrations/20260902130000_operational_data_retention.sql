-- Free-tier Supabase has a hard database size ceiling and nothing in this
-- codebase ever pruned old rows, so usage would grow forever. Prunes
-- completed/expired operational data on a rolling window: Jasa Sebar's
-- user-visible "Riwayat sebar" gets a longer window than purely internal
-- state, and a reviewed Auto Komen candidate is never touched -- its
-- auto_comment_reviews row is immutable by design (an audit trail), which
-- also blocks (on delete restrict) deleting the candidate itself.

create or replace function public.prune_expired_operational_data(
  p_broadcast_history_retention interval default interval '3 days',
  p_internal_retention interval default interval '2 days'
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
  v_auto_comment_operations bigint := 0;
  v_auto_comment_candidates bigint := 0;
  v_incoming_channel_posts bigint := 0;
  v_api_sessions bigint := 0;
  v_auth_flows bigint := 0;
begin
  if p_broadcast_history_retention <= interval '0' or p_internal_retention <= interval '0' then
    raise exception using errcode = 'P0001', message = 'INVALID_RETENTION_WINDOW';
  end if;

  -- workflow_commands cascades automatically via broadcast_target_id.
  with deleted as (
    delete from public.broadcast_targets target
     where (target.delivery_status = 'SUCCEEDED' and target.last_success_at < now_value - p_broadcast_history_retention)
        or (target.delivery_status in ('FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN') and target.updated_at < now_value - p_internal_retention)
    returning 1
  )
  select count(*) into v_broadcast_targets from deleted;

  with deleted as (
    delete from public.workflow_operations operation
     where operation.operation_type = 'BROADCAST'
       and operation.status in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       and operation.updated_at < now_value - p_internal_retention
       and not exists (select 1 from public.broadcast_targets target where target.operation_id = operation.id)
    returning 1
  )
  select count(*) into v_workflow_operations from deleted;

  with prunable as (
    select candidate.id
      from public.auto_comment_candidates candidate
     where candidate.status in ('COMMENT_SENT', 'COMMENT_FAILED', 'OOT', 'SIDE_EFFECT_UNCERTAIN', 'REJECTED')
       and candidate.updated_at < now_value - p_internal_retention
       and not exists (select 1 from public.auto_comment_reviews review where review.candidate_id = candidate.id)
  ),
  deleted_commands as (
    delete from public.workflow_commands command
     where command.auto_comment_candidate_id in (select id from prunable)
    returning command.operation_id
  ),
  deleted_operations as (
    delete from public.workflow_operations operation
     where operation.operation_type = 'AUTO_COMMENT'
       and operation.id in (select operation_id from deleted_commands)
    returning 1
  ),
  deleted_candidates as (
    delete from public.auto_comment_candidates candidate
     where candidate.id in (select id from prunable)
    returning 1
  )
  select
    (select count(*) from deleted_operations),
    (select count(*) from deleted_candidates)
    into v_auto_comment_operations, v_auto_comment_candidates;

  with deleted as (
    delete from public.incoming_channel_posts post
     where post.received_at < now_value - p_internal_retention
       and not exists (select 1 from public.auto_comment_candidates candidate where candidate.incoming_post_id = post.id)
    returning 1
  )
  select count(*) into v_incoming_channel_posts from deleted;

  with deleted as (
    delete from public.api_sessions session
     where session.expires_at < now_value - p_internal_retention
    returning 1
  )
  select count(*) into v_api_sessions from deleted;

  with deleted as (
    delete from public.telegram_account_auth_flows flow
     where flow.status in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')
       and flow.updated_at < now_value - p_internal_retention
    returning 1
  )
  select count(*) into v_auth_flows from deleted;

  return query select
    v_broadcast_targets,
    v_workflow_operations + v_auto_comment_operations,
    v_auto_comment_candidates,
    v_incoming_channel_posts,
    v_api_sessions,
    v_auth_flows;
end;
$$;

comment on function public.prune_expired_operational_data(interval, interval)
  is 'Deletes completed/expired operational rows past their retention window. Never touches a reviewed Auto Komen candidate: auto_comment_reviews is immutable by design and its on delete restrict FK blocks it regardless.';

revoke all on function public.prune_expired_operational_data(interval, interval) from public;
