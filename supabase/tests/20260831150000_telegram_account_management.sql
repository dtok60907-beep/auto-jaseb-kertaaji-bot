begin;

insert into public.app_users (id) values
  ('51515151-5151-4151-8151-515151515151'),
  ('52525252-5252-4252-8252-525252525252');

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, provider_user_id,
  encrypted_session, encryption_key_version, status
) values
  (
    '53535353-5353-4353-8353-535353535353',
    '51515151-5151-4151-8151-515151515151',
    'USERBOT', 'First account', 900001501,
    decode('010203', 'hex'), 1, 'READY'
  ),
  (
    '54545454-5454-4454-8454-545454545454',
    '51515151-5151-4151-8151-515151515151',
    'USERBOT', 'Second account', 900001502,
    decode('040506', 'hex'), 1, 'READY'
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    '51515151-5151-4151-8151-515151515151',
    'USERBOT', 'Degraded account', 900001503,
    decode('070809', 'hex'), 1, 'DEGRADED'
  ),
  (
    '56565656-5656-4656-8656-565656565656',
    '52525252-5252-4252-8252-525252525252',
    'USERBOT', 'Other owner account', 900001504,
    decode('0a0b0c', 'hex'), 1, 'READY'
  );

insert into public.userbot_profiles (
  id, user_id, active_account_id, status, broadcast_interval_seconds
) values (
  '57575757-5757-4757-8757-575757575757',
  '51515151-5151-4151-8151-515151515151',
  '53535353-5353-4353-8353-535353535353',
  'CONNECTED', 37
);
insert into public.userbot_profile_accounts (profile_id, account_id, status)
values (
  '57575757-5757-4757-8757-575757575757',
  '53535353-5353-4353-8353-535353535353',
  'ATTACHED'
);

insert into public.account_leases (account_id, lease_owner, fencing_token, lease_until)
values
  ('53535353-5353-4353-8353-535353535353', '58585858-5858-4858-8858-585858585858', 8, now() + interval '5 minutes'),
  ('54545454-5454-4454-8454-545454545454', '59595959-5959-4959-8959-595959595959', 11, now() + interval '5 minutes');

select public.switch_userbot_profile_account(
  '51515151-5151-4151-8151-515151515151',
  '54545454-5454-4454-8454-545454545454'
);

do $$
declare
  profile_row public.userbot_profiles%rowtype;
  live_leases integer;
  attached_id uuid;
begin
  select * into strict profile_row from public.userbot_profiles
   where user_id = '51515151-5151-4151-8151-515151515151';
  if profile_row.active_account_id <> '54545454-5454-4454-8454-545454545454'
     or profile_row.status <> 'CONNECTED'
     or profile_row.broadcast_interval_seconds <> 37 then
    raise exception 'switch changed profile ownership/settings';
  end if;
  select count(*) into live_leases from public.account_leases
   where account_id in (
     '53535353-5353-4353-8353-535353535353',
     '54545454-5454-4454-8454-545454545454'
   ) and lease_until > now();
  if live_leases <> 0 then raise exception 'switch did not fence runtime leases'; end if;
  select account_id into strict attached_id from public.userbot_profile_accounts
   where profile_id = profile_row.id and status = 'ATTACHED';
  if attached_id <> profile_row.active_account_id then raise exception 'attached link mismatch'; end if;
end;
$$;

do $$
begin
  begin
    perform public.switch_userbot_profile_account(
      '51515151-5151-4151-8151-515151515151',
      '56565656-5656-4656-8656-565656565656'
    );
    raise exception 'other owner switch unexpectedly succeeded';
  exception when no_data_found then null;
  end;
  begin
    perform public.switch_userbot_profile_account(
      '51515151-5151-4151-8151-515151515151',
      '55555555-5555-4555-8555-555555555555'
    );
    raise exception 'degraded switch unexpectedly succeeded';
  exception when object_not_in_prerequisite_state then null;
  end;
end;
$$;

select public.detach_userbot_profile_account('51515151-5151-4151-8151-515151515151');
select public.detach_userbot_profile_account('51515151-5151-4151-8151-515151515151');

do $$
declare
  profile_row public.userbot_profiles%rowtype;
  retained_sessions integer;
begin
  select * into strict profile_row from public.userbot_profiles
   where user_id = '51515151-5151-4151-8151-515151515151';
  if profile_row.active_account_id is not null
     or profile_row.status <> 'DISCONNECTED'
     or profile_row.broadcast_interval_seconds <> 37 then
    raise exception 'detach changed retained profile settings';
  end if;
  select count(*) into retained_sessions from public.telegram_accounts
   where owner_user_id = profile_row.user_id and encrypted_session is not null;
  if retained_sessions <> 3 then raise exception 'detach destroyed a saved session'; end if;
end;
$$;

select public.revoke_userbot_account_session(
  '51515151-5151-4151-8151-515151515151',
  '54545454-5454-4454-8454-545454545454'
);

do $$
declare
  account_row public.telegram_accounts%rowtype;
  retained_interval integer;
begin
  select * into strict account_row from public.telegram_accounts
   where id = '54545454-5454-4454-8454-545454545454';
  if account_row.status <> 'REVOKED' or account_row.encrypted_session is not null then
    raise exception 'logout retained executable session material';
  end if;
  select broadcast_interval_seconds into strict retained_interval
    from public.userbot_profiles
   where user_id = '51515151-5151-4151-8151-515151515151';
  if retained_interval <> 37 then raise exception 'logout changed profile settings'; end if;
end;
$$;

rollback;
