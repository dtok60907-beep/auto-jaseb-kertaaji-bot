select 1 / case when exists (
  select 1 from public.app_users
   where id = '99999999-9999-4999-8999-999999999999'
     and telegram_user_id = 900000117
) then 1 else 0 end;

select 1 / case when to_regclass('public.canary_admissions') is not null then 1 else 0 end;

select 1 / case when (
  select admission_status = 'ADMITTED' and assigned_slot = 1
    from public.set_canary_admission(900000117, true)
) then 1 else 0 end;
