select * from public.set_canary_admission(900000302, true);

select result_status
  from public.issue_telegram_mini_app_session(
    900000302, 'Pre Gate Session', null, null, 'id', false, false,
    now(), decode(repeat('77', 32), 'hex'), decode(repeat('78', 32), 'hex'),
    now() + interval '12 hours'
  );
