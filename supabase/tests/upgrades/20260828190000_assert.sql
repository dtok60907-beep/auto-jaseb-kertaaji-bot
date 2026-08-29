-- Apply after V20. The repair is non-destructive and leaves one reusable worker.

select 1 / case when (
  select count(*) = 2 and count(*) filter (where user_id = '26262626-2626-2626-2626-262626262626') = 2
    from public.worker_assignments
   where id in ('29292929-2929-2929-2929-292929292921', '29292929-2929-2929-2929-292929292922')
) then 1 else 0 end;
select 1 / case when (
  select count(*) filter (where status in ('RESERVED', 'ACTIVE')) = 1
     and count(*) filter (where status = 'RELEASED' and released_at is not null) = 1
    from public.worker_assignments
   where user_id = '26262626-2626-2626-2626-262626262626'
) then 1 else 0 end;
select 1 / case when (
  select count(*) = 2 from public.workflow_operations
   where user_id = '26262626-2626-2626-2626-262626262626'
) then 1 else 0 end;
