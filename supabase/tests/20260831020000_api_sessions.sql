-- R1-002B1 fresh-schema proof: one-time exchange and backend-only storage.

begin;

do $$
declare
  first_status text;
  replay_status text;
  first_user_id uuid;
begin
  select result_status, resolved_user_id
    into first_status, first_user_id
    from public.issue_telegram_mini_app_session(
      900000005, 'Session Proof', null, null, 'id', false, false,
      now(), extensions.digest('token-one', 'sha256'), extensions.digest('init-data-one', 'sha256'),
      now() + interval '12 hours'
    );
  if first_status <> 'CREATED' or first_user_id is null then
    raise exception 'first exchange did not create a session';
  end if;

  select result_status
    into replay_status
    from public.issue_telegram_mini_app_session(
      900000005, 'Session Proof', null, null, 'id', false, false,
      now(), extensions.digest('token-two', 'sha256'), extensions.digest('init-data-one', 'sha256'),
      now() + interval '12 hours'
    );
  if replay_status <> 'REPLAY' then
    raise exception 'duplicate initData hash was not rejected';
  end if;
  if (select count(*) from public.api_sessions where user_id = first_user_id) <> 1 then
    raise exception 'replay created an additional session';
  end if;

  begin
    perform 1 from public.issue_telegram_mini_app_session(
      900000006, 'Invalid Hash', null, null, 'id', false, false,
      now(), decode('00', 'hex'), extensions.digest('init-data-two', 'sha256'),
      now() + interval '12 hours'
    );
    raise exception 'short token hash was accepted';
  exception when invalid_parameter_value then
    if sqlerrm <> 'INVALID_API_SESSION_HASH' then raise; end if;
  end;
end;
$$;

select 1 / case when
  not has_table_privilege('anon', 'public.api_sessions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.api_sessions', 'SELECT')
  and not has_function_privilege(
    'anon',
    'public.issue_telegram_mini_app_session(bigint,text,text,text,text,boolean,boolean,timestamp with time zone,bytea,bytea,timestamp with time zone)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.issue_telegram_mini_app_session(bigint,text,text,text,text,boolean,boolean,timestamp with time zone,bytea,bytea,timestamp with time zone)',
    'EXECUTE'
  )
then 1 else 0 end;

select 1 / case when not exists (
  select 1
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'api_sessions'
     and column_name in ('token', 'access_token', 'init_data', 'raw_init_data')
) then 1 else 0 end;

rollback;
