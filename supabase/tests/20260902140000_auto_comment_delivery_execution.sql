-- claim_next_workflow_command / finish_claimed_workflow_command actually
-- deliver a COMMENT_TEXT command and advance its owning candidate; discovery
-- picks up pending/recovering delivery work; claim_next_broadcast_command
-- never touches a COMMENT_TEXT command on the same account.
--
-- Uses \gset throughout to pin exact ids: every insert in this file runs
-- inside one transaction, and now() (and therefore created_at) is the same
-- for every statement in that transaction, so "order by created_at" cannot
-- tell rows created moments apart within this test apart.

begin;
insert into public.app_users (id) values ('69696969-6969-6969-6969-696969696969');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '69696969-6969-6969-6969-696969696969',
  '{"packageId":"delivery-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '69696969-6969-6969-6969-696969696969', 'USERBOT', 'Delivery userbot', decode('00', 'hex'), 1, 'READY');
insert into public.userbot_profiles (user_id, active_account_id, status)
values ('69696969-6969-6969-6969-696969696969', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', 'CONNECTED');
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', '69696969-6969-6969-6969-696969696969', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', 'Delivery division', 'AUTO_SEND');
insert into public.auto_comment_division_keywords (division_id, keyword)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'promo');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('cccccccc-cccc-cccc-cccc-cccccccccc69', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'gua ready kak pc aja');
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status)
values ('dddddddd-dddd-dddd-dddd-dddddddddd69', '69696969-6969-6969-6969-696969696969', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '@delivery_channel', '@delivery_discussion', 'READY');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'dddddddd-dddd-dddd-dddd-dddddddddd69');

select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 300)) then 1 else 0 end;

-- Not discoverable and nothing to claim before any candidate exists.
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69' and has_delivery_work
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60)
) then 1 else 0 end;

-- An AUTO_SEND match queues a command immediately; the account is now
-- discoverable for delivery, and the command claims with attempt_count 1.
select candidate_id as candidate_1 from public.create_auto_comment_candidate(
  'dddddddd-dddd-dddd-dddd-dddddddddd69', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69',
  '@delivery_channel', 'post-1', 'cari admin promo dong', array['promo'],
  'cccccccc-cccc-cccc-cccc-cccccccccc69', 'gua ready kak pc aja', 'AUTO_SEND', '@delivery_discussion'
) \gset
select 1 / case when exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69' and has_delivery_work
) then 1 else 0 end;

select command_id as command_1, attempt_count as command_1_attempts, kind as command_1_kind, target_id as command_1_target
  from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60) \gset
select 1 / case when :'command_1_kind' = 'COMMENT_TEXT' and :command_1_attempts = 1 and :'command_1_target' = '@delivery_discussion' then 1 else 0 end;
-- Already claimed: nothing left to claim, and it dropped out of discovery.
select 1 / case when not exists (
  select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60)
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.list_broadcast_runtime_accounts(1, 0, 'infinity'::timestamptz, 100)
   where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69' and has_delivery_work
) then 1 else 0 end;

-- Finishing SUCCEEDED advances the command, its candidate, and its operation.
select 1 / case when public.finish_claimed_workflow_command(
  :'command_1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1,
  'SUCCEEDED', null, null, array['9001'], now()
) then 1 else 0 end;
select 1 / case when (select status = 'SUCCEEDED' from public.workflow_commands where id = :'command_1') then 1 else 0 end;
select 1 / case when (select status = 'COMMENT_SENT' from public.auto_comment_candidates where id = :'candidate_1') then 1 else 0 end;
select 1 / case when (select status = 'SUCCEEDED' from public.workflow_operations where id = (select operation_id from public.workflow_commands where id = :'command_1')) then 1 else 0 end;

-- A second match: FAILED_RETRYABLE never advances the candidate past
-- COMMENT_QUEUED, pushes the command's availability out, and a claim before
-- that window elapses finds nothing.
select candidate_id as candidate_2 from public.create_auto_comment_candidate(
  'dddddddd-dddd-dddd-dddd-dddddddddd69', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69',
  '@delivery_channel', 'post-2', 'promo lagi nih', array['promo'],
  'cccccccc-cccc-cccc-cccc-cccccccccc69', 'gua ready kak pc aja', 'AUTO_SEND', '@delivery_discussion'
) \gset
select command_id as command_2 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60) \gset
select 1 / case when :'command_2' is not null then 1 else 0 end;
select 1 / case when public.finish_claimed_workflow_command(
  :'command_2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1,
  'FAILED_RETRYABLE', 'FLOOD_WAIT', 30, null, null
) then 1 else 0 end;
select 1 / case when (select status = 'COMMENT_QUEUED' from public.auto_comment_candidates where id = :'candidate_2') then 1 else 0 end;
select 1 / case when (
  select status = 'FAILED_RETRYABLE' and available_at > now() and retry_after is not null
    from public.workflow_commands where id = :'command_2'
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60)
) then 1 else 0 end;

-- A third match: FAILED_FINAL marks the candidate COMMENT_FAILED with the
-- error code attached.
select candidate_id as candidate_3 from public.create_auto_comment_candidate(
  'dddddddd-dddd-dddd-dddd-dddddddddd69', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69',
  '@delivery_channel', 'post-3', 'promo ketiga', array['promo'],
  'cccccccc-cccc-cccc-cccc-cccccccccc69', 'gua ready kak pc aja', 'AUTO_SEND', '@delivery_discussion'
) \gset
update public.workflow_commands set available_at = now() - interval '1 second' where id = :'command_2';
-- Two commands due now (the retried one and the fresh one); claim + finish both.
select command_id as command_2_retry from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60) \gset
select 1 / case when public.finish_claimed_workflow_command(
  :'command_2_retry', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1,
  'FAILED_FINAL', 'CHAT_WRITE_FORBIDDEN', null, null, null
) then 1 else 0 end;
select command_id as command_3 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60) \gset
select 1 / case when public.finish_claimed_workflow_command(
  :'command_3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1,
  'FAILED_FINAL', 'CHAT_WRITE_FORBIDDEN', null, null, null
) then 1 else 0 end;
select 1 / case when (
  select count(*) = 2 from public.auto_comment_candidates
   where id in (:'candidate_2', :'candidate_3') and status = 'COMMENT_FAILED' and error_code = 'CHAT_WRITE_FORBIDDEN'
) then 1 else 0 end;

-- An invalid finish status is rejected outright.
do $$ begin
  begin
    perform public.finish_claimed_workflow_command(
      gen_random_uuid(), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 'CANCELLED'
    );
    raise exception 'an unsupported finish status was accepted';
  exception when others then
    if sqlerrm <> 'INVALID_COMMENT_FINISH_STATUS' then raise; end if;
  end;
end $$;

-- claim_next_broadcast_command never claims a COMMENT_TEXT command, even
-- when one is due on the very same account.
select candidate_id as candidate_4 from public.create_auto_comment_candidate(
  'dddddddd-dddd-dddd-dddd-dddddddddd69', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb69', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69',
  '@delivery_channel', 'post-4', 'promo keempat', array['promo'],
  'cccccccc-cccc-cccc-cccc-cccccccccc69', 'gua ready kak pc aja', 'AUTO_SEND', '@delivery_discussion'
) \gset
select 1 / case when not exists (
  select 1 from public.claim_next_broadcast_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa69', '99999999-9999-9999-9999-999999999969', 1, 60)
) then 1 else 0 end;

rollback;
