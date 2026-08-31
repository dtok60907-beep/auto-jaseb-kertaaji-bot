-- R3-002 fresh-schema proof: a submit attempt is claimed once and verified
-- account completion is atomic with profile switching and transient-state cleanup.

begin;

do $$
declare
  user_id_value uuid;
  flow_row record;
  transition_row record;
  claim_row record;
  completion_row record;
begin
  select public.upsert_telegram_mini_app_user(
    900001301, 'Authorization Owner', null, null, 'id', false, false,
    '2026-08-31 13:00:00+00'
  ) into user_id_value;

  select * into flow_row from public.begin_userbot_auth_flow(user_id_value, 600);
  select * into transition_row from public.transition_userbot_auth_flow(
    user_id_value, flow_row.auth_flow_id, 1, 'CODE_REQUIRED',
    decode('01020304', 'hex'), 1, null
  );

  select * into claim_row from public.claim_userbot_auth_flow_step(
    user_id_value, flow_row.auth_flow_id, 2, 'CODE_REQUIRED'
  );
  if claim_row.result_status <> 'CLAIMED'
     or claim_row.auth_flow_status <> 'VERIFYING'
     or claim_row.auth_flow_version <> 3
     or claim_row.auth_flow_encrypted_state <> decode('01020304', 'hex') then
    raise exception 'OTP step was not claimed with its encrypted state';
  end if;

  select * into claim_row from public.claim_userbot_auth_flow_step(
    user_id_value, flow_row.auth_flow_id, 2, 'CODE_REQUIRED'
  );
  if claim_row.result_status <> 'VERSION_CONFLICT'
     or claim_row.auth_flow_encrypted_state is not null then
    raise exception 'duplicate OTP claim was not fenced';
  end if;

  select * into transition_row from public.transition_userbot_auth_flow(
    user_id_value, flow_row.auth_flow_id, 3, 'PASSWORD_REQUIRED',
    decode('05060708', 'hex'), 1, null
  );
  if transition_row.result_status <> 'UPDATED'
     or transition_row.auth_flow_status <> 'PASSWORD_REQUIRED'
     or transition_row.auth_flow_version <> 4 then
    raise exception 'VERIFYING did not advance to 2FA';
  end if;

  select * into claim_row from public.claim_userbot_auth_flow_step(
    user_id_value, flow_row.auth_flow_id, 4, 'PASSWORD_REQUIRED'
  );
  select * into completion_row from public.complete_userbot_auth_flow(
    user_id_value, flow_row.auth_flow_id, 5,
    '13131313-1313-4313-8313-131313131313', 900001302,
    '@authorization_owner', decode(repeat('ab', 41), 'hex'), 1
  );
  if completion_row.result_status <> 'CONNECTED'
     or completion_row.account_id is null
     or completion_row.auth_flow_version <> 6 then
    raise exception 'verified account was not completed';
  end if;
  if not exists (
    select 1 from public.telegram_accounts
     where id = completion_row.account_id
       and owner_user_id = user_id_value
       and provider_user_id = 900001302
       and status = 'READY'
       and octet_length(encrypted_session) = 41
  ) then
    raise exception 'completed account is not runnable';
  end if;
  if not exists (
    select 1 from public.userbot_profiles
     where user_id = user_id_value
       and active_account_id = completion_row.account_id
       and status = 'CONNECTED'
  ) then
    raise exception 'completed account was not switched into its profile';
  end if;
  if not exists (
    select 1 from public.telegram_account_auth_flows
     where id = flow_row.auth_flow_id
       and status = 'SUCCEEDED'
       and completed_account_id = completion_row.account_id
       and encrypted_state is null
       and encryption_key_version is null
       and finalized_at is not null
  ) then
    raise exception 'completed flow retained transient state';
  end if;
end;
$$;

select 1 / case when
  not has_function_privilege(
    'anon', 'public.claim_userbot_auth_flow_step(uuid,uuid,bigint,text)', 'EXECUTE'
  )
  and not has_function_privilege(
    'authenticated',
    'public.complete_userbot_auth_flow(uuid,uuid,bigint,uuid,bigint,text,bytea,integer)',
    'EXECUTE'
  )
then 1 else 0 end;

rollback;
