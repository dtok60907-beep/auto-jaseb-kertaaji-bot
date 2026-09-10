-- An empty UPDATE must not emit the scheduler wakeup. PostgreSQL row-level
-- triggers do not execute when no row changes; statement-level triggers do.

begin;

select 1 / case when exists (
  select 1
    from information_schema.triggers
   where event_object_schema = 'public'
     and event_object_table = 'broadcast_campaigns'
     and trigger_name = 'broadcast_campaigns_scheduler_wakeup'
     and action_orientation = 'ROW'
) then 1 else 0 end;

select 1 / case when not exists (
  select 1
    from information_schema.triggers
   where event_object_schema = 'public'
     and event_object_table = 'broadcast_campaigns'
     and trigger_name = 'broadcast_campaigns_scheduler_wakeup'
     and action_orientation = 'STATEMENT'
) then 1 else 0 end;

rollback;
