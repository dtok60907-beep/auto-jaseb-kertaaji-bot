begin;

do $$
declare
  admin_user_id uuid;
  userbot_flow record;
  worker_flow record;
  transition_row record;
  claim_row record;
  completion_row record;
begin
  select public.upsert_telegram_mini_app_user(
    900009001, 'Worker Admin', null, null, 'id', false, false, now()
  ) into admin_user_id;

  select * into userbot_flow
    from public.begin_telegram_account_auth_flow(admin_user_id, 'USERBOT', 600);
  select * into worker_flow
    from public.begin_telegram_account_auth_flow(admin_user_id, 'JASEB_WORKER', 600);
  if userbot_flow.result_status <> 'CREATED'
     or worker_flow.result_status <> 'CREATED'
     or userbot_flow.auth_flow_id = worker_flow.auth_flow_id then
    raise exception 'account-scoped flows were not created independently';
  end if;

  select * into transition_row from public.transition_telegram_account_auth_flow(
    admin_user_id, 'USERBOT', worker_flow.auth_flow_id, 1, 'VERIFYING',
    decode('01020304', 'hex'), 1, null
  );
  if transition_row.result_status <> 'NOT_FOUND' then
    raise exception 'worker flow was accepted through the Userbot fence';
  end if;

  select * into transition_row from public.transition_telegram_account_auth_flow(
    admin_user_id, 'JASEB_WORKER', worker_flow.auth_flow_id, 1, 'CODE_REQUIRED',
    decode('05060708', 'hex'), 1, null
  );
  select * into claim_row from public.claim_telegram_account_auth_flow_step(
    admin_user_id, 'JASEB_WORKER', worker_flow.auth_flow_id, 2, 'CODE_REQUIRED'
  );
  if claim_row.result_status <> 'CLAIMED' or claim_row.auth_flow_version <> 3 then
    raise exception 'worker OTP step was not claimed';
  end if;

  select * into completion_row from public.complete_telegram_account_auth_flow(
    admin_user_id, 'JASEB_WORKER', worker_flow.auth_flow_id, 3,
    '90909090-9090-4090-8090-909090909090', 900009002,
    '@worker_admin', decode(repeat('ab', 41), 'hex'), 1
  );
  if completion_row.result_status <> 'CONNECTED' then
    raise exception 'worker account was not completed';
  end if;
  if not exists (
    select 1 from public.telegram_accounts
     where id = completion_row.account_id
       and owner_user_id is null
       and account_type = 'JASEB_WORKER'
       and status = 'READY'
       and provider_user_id = 900009002
       and octet_length(encrypted_session) = 41
  ) then
    raise exception 'completed worker is not runnable or is buyer-owned';
  end if;
  if exists (
    select 1 from public.userbot_profiles where active_account_id = completion_row.account_id
  ) then
    raise exception 'worker was attached to a Userbot profile';
  end if;
end;
$$;

select 1 / case when
  not has_function_privilege('anon', 'public.begin_telegram_account_auth_flow(uuid,text,integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.transition_telegram_account_auth_flow(uuid,text,uuid,bigint,text,bytea,integer,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.complete_telegram_account_auth_flow(uuid,text,uuid,bigint,uuid,bigint,text,bytea,integer)', 'EXECUTE')
then 1 else 0 end;

rollback;
