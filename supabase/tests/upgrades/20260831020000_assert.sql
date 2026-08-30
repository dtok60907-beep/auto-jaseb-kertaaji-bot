select 1 / case when exists (
  select 1 from public.app_users
   where id = '93939393-9393-4393-8393-939393939393'
     and telegram_user_id = 900000007
) then 1 else 0 end;

select 1 / case when to_regclass('public.api_sessions') is not null then 1 else 0 end;

select 1 / case when (
  select result_status = 'CREATED'
    from public.issue_telegram_mini_app_session(
      900000007, 'Upgrade Session User', null, null, 'id', false, false,
      now(), extensions.digest('upgrade-token', 'sha256'), extensions.digest('upgrade-init-data', 'sha256'),
      now() + interval '12 hours'
    )
) then 1 else 0 end;
