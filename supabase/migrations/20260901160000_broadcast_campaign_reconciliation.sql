-- create_broadcast_campaign / due_broadcast_campaigns only know whether a cycle
-- was *created* (create_broadcast_operation did not throw). They never learn
-- whether the resulting send actually succeeded, so a campaign whose material
-- permanently fails delivery (e.g. FORWARD_FORBIDDEN on a protected-content
-- source) would retry forever every interval until a human notices and stops
-- it manually. This adds outcome tracking so the scheduler can auto-stop after
-- repeated real delivery failures.

alter table public.broadcast_campaigns
  add column consecutive_failures integer not null default 0,
  add column last_reconciled_operation_id uuid;

comment on column public.broadcast_campaigns.consecutive_failures
  is 'Consecutive cycles whose operation reached a non-SUCCEEDED terminal status; resets to 0 on a SUCCEEDED cycle.';
comment on column public.broadcast_campaigns.last_reconciled_operation_id
  is 'Most recent campaign-originated workflow_operations row already folded into consecutive_failures, so reconcile does not double-count.';

create function public.reconcile_broadcast_campaigns(p_limit integer, p_failure_threshold integer)
returns table (out_campaign_id uuid, out_stopped boolean, out_consecutive_failures integer)
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
    select o.id, o.status
      into latest_operation
      from public.workflow_operations o
     where o.idempotency_key like ('campaign:' || campaign_row.id::text || ':%')
       and o.status in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
       and (
         campaign_row.last_reconciled_operation_id is null
         or o.created_at > (
           select created_at from public.workflow_operations
            where id = campaign_row.last_reconciled_operation_id
         )
       )
     order by o.created_at desc
     limit 1;

    continue when latest_operation.id is null;

    if latest_operation.status = 'SUCCEEDED' then
      update public.broadcast_campaigns
         set consecutive_failures = 0, last_reconciled_operation_id = latest_operation.id
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

comment on function public.reconcile_broadcast_campaigns(integer, integer)
  is 'Engine-only: folds each ACTIVE campaign''s most recent unreconciled cycle outcome into consecutive_failures, auto-stopping after p_failure_threshold real delivery failures in a row.';
revoke all on function public.reconcile_broadcast_campaigns(integer, integer) from public;
