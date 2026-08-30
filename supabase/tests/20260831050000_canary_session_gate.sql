-- R2-002 fresh-schema proof: denied exchange leaves no partial identity/session.

begin;

select 1 / case when (
  select result_status = 'ACCESS_DENIED'
    and resolved_user_id is null
    and created_session_id is null
    and session_expires_at is null
    from public.issue_telegram_mini_app_session(
      900000301, 'Denied Canary', null, null, 'id', false, false,
      now(), decode(repeat('71', 32), 'hex'), decode(repeat('72', 32), 'hex'),
      now() + interval '12 hours'
    )
) then 1 else 0 end;

select 1 / case when
  not exists (select 1 from public.app_users where telegram_user_id = 900000301)
  and not exists (
    select 1 from public.api_sessions session
    join public.app_users app_user on app_user.id = session.user_id
    where app_user.telegram_user_id = 900000301
  )
then 1 else 0 end;

select * from public.set_canary_admission(900000301, true);

select 1 / case when (
  select result_status = 'CREATED'
    and resolved_user_id is not null
    and created_session_id is not null
    and session_expires_at is not null
    from public.issue_telegram_mini_app_session(
      900000301, 'Admitted Canary', null, null, 'id', false, false,
      now(), decode(repeat('73', 32), 'hex'), decode(repeat('74', 32), 'hex'),
      now() + interval '12 hours'
    )
) then 1 else 0 end;

select * from public.set_canary_admission(900000301, false);

select 1 / case when
  exists (
    select 1 from public.api_sessions session
    join public.app_users app_user on app_user.id = session.user_id
    where app_user.telegram_user_id = 900000301
      and session.revoked_at is not null
  )
  and (
    select result_status = 'ACCESS_DENIED'
      from public.issue_telegram_mini_app_session(
        900000301, 'Revoked Canary', null, null, 'id', false, false,
        now(), decode(repeat('75', 32), 'hex'), decode(repeat('76', 32), 'hex'),
        now() + interval '12 hours'
      )
  )
then 1 else 0 end;

rollback;
