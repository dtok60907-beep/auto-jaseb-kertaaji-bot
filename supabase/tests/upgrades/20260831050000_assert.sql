select 1 / case when exists (
  select 1 from public.app_users where telegram_user_id = 900000302
) then 1 else 0 end;

select 1 / case when (
  select result_status = 'ACCESS_DENIED'
    from public.issue_telegram_mini_app_session(
      900000303, 'Upgrade Denied', null, null, 'id', false, false,
      now(), decode(repeat('79', 32), 'hex'), decode(repeat('80', 32), 'hex'),
      now() + interval '12 hours'
    )
) then 1 else 0 end;

select 1 / case when not exists (
  select 1 from public.app_users where telegram_user_id = 900000303
) then 1 else 0 end;
