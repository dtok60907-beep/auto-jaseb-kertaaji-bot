-- Apply 20260831010000_app_users.sql after the legacy seed, then this assertion.

select 1 / case when exists (
  select 1 from public.app_users
   where id = '91919191-9191-4191-8191-919191919191'
     and telegram_user_id is null
) then 1 else 0 end;

delete from auth.users
 where id = '91919191-9191-4191-8191-919191919191';

select 1 / case when exists (
  select 1 from public.entitlements
   where id = '92929292-9292-4292-8292-929292929292'
     and user_id = '91919191-9191-4191-8191-919191919191'
) then 1 else 0 end;

select 1 / case when (
  select count(*) = 0
    from pg_constraint constraint_row
    join pg_class target on target.oid = constraint_row.confrelid
    join pg_namespace target_schema on target_schema.oid = target.relnamespace
    join pg_class source on source.oid = constraint_row.conrelid
    join pg_namespace source_schema on source_schema.oid = source.relnamespace
   where constraint_row.contype = 'f'
     and source_schema.nspname = 'public'
     and target_schema.nspname = 'auth'
     and target.relname = 'users'
) then 1 else 0 end;
