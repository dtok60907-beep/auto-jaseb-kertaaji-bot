-- R1-002A fresh-schema proof: canonical identity, FK switch, ordering, and
-- browser-role isolation. Run after every migration through app_users.

begin;

do $$
declare
  first_id uuid;
  repeated_id uuid;
begin
  select public.upsert_telegram_mini_app_user(
    900000001, 'Nama terbaru', 'User', 'nama_baru', 'id', true, true,
    '2026-08-31 02:00:00+00'
  ) into first_id;

  select public.upsert_telegram_mini_app_user(
    900000001, 'Nama lama', null, 'nama_lama', 'en', false, false,
    '2026-08-31 01:00:00+00'
  ) into repeated_id;

  if first_id is distinct from repeated_id then
    raise exception 'same Telegram identity changed application UUID';
  end if;
  if not exists (
    select 1 from public.app_users
     where id = first_id
       and telegram_user_id = 900000001
       and first_name = 'Nama terbaru'
       and username = 'nama_baru'
       and is_premium
       and allows_write_to_pm
       and last_authenticated_at = '2026-08-31 02:00:00+00'
  ) then
    raise exception 'older authentication overwrote the latest profile snapshot';
  end if;

  select public.upsert_telegram_mini_app_user(
    900000001, 'Nama paling baru', null, null, 'id', false, false,
    '2026-08-31 03:00:00+00'
  ) into repeated_id;
  if first_id is distinct from repeated_id or not exists (
    select 1 from public.app_users
     where id = first_id
       and first_name = 'Nama paling baru'
       and username is null
       and last_authenticated_at = '2026-08-31 03:00:00+00'
  ) then
    raise exception 'newer authentication did not update the stable user';
  end if;

  begin
    perform public.upsert_telegram_mini_app_user(0, 'Invalid');
    raise exception 'zero Telegram user id was accepted';
  exception when check_violation then
    null;
  end;
  begin
    perform public.upsert_telegram_mini_app_user(4503599627370496, 'Invalid');
    raise exception 'Telegram user id above 52-bit limit was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

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

select 1 / case when (
  select count(*) = 13
    from pg_constraint constraint_row
    join pg_class target on target.oid = constraint_row.confrelid
    join pg_namespace target_schema on target_schema.oid = target.relnamespace
    join pg_class source on source.oid = constraint_row.conrelid
    join pg_namespace source_schema on source_schema.oid = source.relnamespace
   where constraint_row.contype = 'f'
     and source_schema.nspname = 'public'
     and target_schema.nspname = 'public'
     and target.relname = 'app_users'
     and source.relname in (
       'package_catalog',
       'entitlements',
       'telegram_accounts',
       'workflow_operations',
       'worker_assignments',
       'comment_rules',
       'package_versions',
       'broadcast_materials',
       'broadcast_lpm_targets',
       'auto_comment_divisions',
       'auto_comment_channel_targets',
       'auto_comment_reviews',
       'userbot_profiles'
     )
) then 1 else 0 end;

select 1 / case when
  not has_table_privilege('anon', 'public.app_users', 'SELECT')
  and not has_table_privilege('anon', 'public.app_users', 'INSERT')
  and not has_table_privilege('authenticated', 'public.app_users', 'SELECT')
  and not has_table_privilege('authenticated', 'public.app_users', 'UPDATE')
  and not has_function_privilege(
    'anon',
    'public.upsert_telegram_mini_app_user(bigint,text,text,text,text,boolean,boolean,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.upsert_telegram_mini_app_user(bigint,text,text,text,text,boolean,boolean,timestamp with time zone)',
    'EXECUTE'
  )
then 1 else 0 end;

rollback;
