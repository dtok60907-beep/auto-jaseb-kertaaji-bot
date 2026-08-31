-- R3-001 fresh-schema proof: bounded auth state, optimistic transitions,
-- explicit session destruction, runtime fencing, and settings retention.

begin;

do $$
declare
  user_id_value uuid;
  first_flow record;
  repeated_flow record;
  transition_result record;
  revoke_result text;
begin
  select public.upsert_telegram_mini_app_user(
    900001101, 'Lifecycle Owner', null, null, 'id', false, false,
    '2026-08-31 10:00:00+00'
  ) into user_id_value;

  select * into first_flow
    from public.begin_userbot_auth_flow(user_id_value, 600);
  if first_flow.result_status <> 'CREATED'
     or first_flow.auth_flow_status <> 'CREATED'
     or first_flow.auth_flow_version <> 1 then
    raise exception 'first lifecycle flow was not created';
  end if;

  select * into repeated_flow
    from public.begin_userbot_auth_flow(user_id_value, 600);
  if repeated_flow.result_status <> 'ACTIVE_FLOW_EXISTS'
     or repeated_flow.auth_flow_id is distinct from first_flow.auth_flow_id then
    raise exception 'second begin created a duplicate active flow';
  end if;

  select * into transition_result
    from public.transition_userbot_auth_flow(
      user_id_value, first_flow.auth_flow_id, 1, 'CODE_REQUIRED',
      decode('01020304', 'hex'), 1, null
    );
  if transition_result.result_status <> 'UPDATED'
     or transition_result.auth_flow_status <> 'CODE_REQUIRED'
     or transition_result.auth_flow_version <> 2 then
    raise exception 'valid auth transition failed';
  end if;

  select * into transition_result
    from public.transition_userbot_auth_flow(
      user_id_value, first_flow.auth_flow_id, 1, 'VERIFYING',
      decode('05060708', 'hex'), 1, null
    );
  if transition_result.result_status <> 'VERSION_CONFLICT'
     or transition_result.auth_flow_status <> 'CODE_REQUIRED'
     or transition_result.auth_flow_version <> 2 then
    raise exception 'stale auth transition was not fenced';
  end if;

  begin
    perform public.transition_userbot_auth_flow(
      user_id_value, first_flow.auth_flow_id, 2, 'SUCCEEDED', null, null, null
    );
    raise exception 'generic transition completed an account without verification';
  exception when raise_exception then
    if sqlerrm <> 'INVALID_AUTH_FLOW_TRANSITION' then raise; end if;
  end;

  select * into transition_result
    from public.transition_userbot_auth_flow(
      user_id_value, first_flow.auth_flow_id, 2, 'CANCELLED', null, null, null
    );
  if transition_result.result_status <> 'UPDATED'
     or transition_result.auth_flow_status <> 'CANCELLED'
     or exists (
       select 1 from public.telegram_account_auth_flows
        where id = first_flow.auth_flow_id
          and (encrypted_state is not null or encryption_key_version is not null)
     ) then
    raise exception 'terminal flow retained transient authorization state';
  end if;

  insert into public.telegram_accounts (
    id, owner_user_id, account_type, label, provider_user_id,
    encrypted_session, encryption_key_version, status
  ) values (
    '11111111-1111-4111-8111-111111111101', user_id_value, 'USERBOT',
    'Primary Userbot', 900001102, decode('4a53453101010c1000000001aabbcc', 'hex'), 1, 'READY'
  );
  insert into public.userbot_profiles (
    user_id, active_account_id, status, broadcast_interval_seconds
  ) values (
    user_id_value, '11111111-1111-4111-8111-111111111101', 'CONNECTED', 37
  );
  insert into public.userbot_profile_accounts (profile_id, account_id, status)
  select id, '11111111-1111-4111-8111-111111111101', 'ATTACHED'
    from public.userbot_profiles where user_id = user_id_value;
  insert into public.account_leases (
    account_id, lease_owner, fencing_token, lease_until
  ) values (
    '11111111-1111-4111-8111-111111111101',
    '22222222-2222-4222-8222-222222222202', 1, now() + interval '1 minute'
  );

  select public.revoke_userbot_account_session(
    user_id_value, '11111111-1111-4111-8111-111111111101'
  ) into revoke_result;
  if revoke_result <> 'REVOKED' then
    raise exception 'session revoke did not report success';
  end if;
  if not exists (
    select 1 from public.telegram_accounts
     where id = '11111111-1111-4111-8111-111111111101'
       and status = 'REVOKED'
       and encrypted_session is null
       and encryption_key_version is null
       and session_revoked_at is not null
  ) then
    raise exception 'revoked account retained usable session material';
  end if;
  if not exists (
    select 1 from public.userbot_profiles
     where user_id = user_id_value
       and status = 'DISCONNECTED'
       and active_account_id is null
       and broadcast_interval_seconds = 37
  ) then
    raise exception 'logout removed profile settings or kept the account active';
  end if;
  if exists (
    select 1 from public.userbot_profile_accounts
     where account_id = '11111111-1111-4111-8111-111111111101'
       and status = 'ATTACHED'
  ) or exists (
    select 1 from public.account_leases
     where account_id = '11111111-1111-4111-8111-111111111101'
  ) then
    raise exception 'logout retained profile attachment or runtime lease';
  end if;

  select public.revoke_userbot_account_session(
    user_id_value, '11111111-1111-4111-8111-111111111101'
  ) into revoke_result;
  if revoke_result <> 'ALREADY_REVOKED' then
    raise exception 'repeated logout was not idempotent';
  end if;
end;
$$;

select 1 / case when
  not has_table_privilege('anon', 'public.telegram_account_auth_flows', 'SELECT')
  and not has_table_privilege('authenticated', 'public.telegram_account_auth_flows', 'SELECT')
  and not has_function_privilege(
    'anon', 'public.begin_userbot_auth_flow(uuid,integer)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.transition_userbot_auth_flow(uuid,uuid,bigint,text,bytea,integer,text)',
    'EXECUTE'
  )
then 1 else 0 end;

rollback;
