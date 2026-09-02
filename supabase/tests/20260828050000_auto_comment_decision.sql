-- decide_auto_comment_candidate: OOT never creates a command; a Tepat
-- decision creates exactly one AUTO_COMMENT operation + COMMENT_TEXT command,
-- whose payload carries the source channel ref and matched post id (needed so
-- the engine can send the reply as an actual comment on that post rather than
-- a bare message into the discussion group).

begin;
insert into public.app_users (id) values ('39393939-3939-3939-3939-393939393939');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '39393939-3939-3939-3939-393939393939',
  '{"packageId":"decision-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '39393939-3939-3939-3939-393939393939', 'USERBOT', 'Decision userbot', decode('00', 'hex'), 1, 'READY');

insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', '39393939-3939-3939-3939-393939393939', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', 'Review division', 'APPROVAL_REQUIRED');
insert into public.auto_comment_division_keywords (id, division_id, keyword)
values ('cccccccc-cccc-cccc-cccc-cccccccccc39', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', 'wtb');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('dddddddd-dddd-dddd-dddd-dddddddddd39', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', 'Ready kak, cek DM ya');

insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', '39393939-3939-3939-3939-393939393939', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '@menfess_decision', '@menfess_decision_discussion', 'READY');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39');

-- Two pending candidates: one gets OOT, one gets Tepat.
select result_status, candidate_id as candidate_oot from public.create_auto_comment_candidate(
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '@menfess_decision', 'post-oot', 'ini bukan wtb',
  array['wtb'], 'dddddddd-dddd-dddd-dddd-dddddddddd39', 'Ready kak, cek DM ya',
  'APPROVAL_REQUIRED', '@menfess_decision_discussion'
) \gset
select result_status, candidate_id as candidate_tepat from public.create_auto_comment_candidate(
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee39', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb39',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa39', '@menfess_decision', 'post-tepat', 'wtb sepatu size 42',
  array['wtb'], 'dddddddd-dddd-dddd-dddd-dddddddddd39', 'Ready kak, cek DM ya',
  'APPROVAL_REQUIRED', '@menfess_decision_discussion'
) \gset

-- OOT: no review-status change beyond OOT, no operation/command created.
select 1 / case when (
  select result_status = 'OOT' and operation_id is null and command_id is null
    from public.decide_auto_comment_candidate(:'candidate_oot', '39393939-3939-3939-3939-393939393939', 'OOT')
) then 1 else 0 end;
select 1 / case when (select status = 'OOT' from public.auto_comment_candidates where id = :'candidate_oot') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_commands where auto_comment_candidate_id = :'candidate_oot'::uuid) then 1 else 0 end;

-- Tepat: queues exactly one AUTO_COMMENT operation + COMMENT_TEXT command,
-- with the source channel ref + matched post id carried into the payload.
select 1 / case when (
  select result_status = 'COMMENT_QUEUED' and operation_id is not null and command_id is not null
    from public.decide_auto_comment_candidate(:'candidate_tepat', '39393939-3939-3939-3939-393939393939', 'TEPAT')
) then 1 else 0 end;
select 1 / case when (select status = 'COMMENT_QUEUED' from public.auto_comment_candidates where id = :'candidate_tepat') then 1 else 0 end;
select 1 / case when (
  select count(*) = 1 from public.workflow_commands
   where auto_comment_candidate_id = :'candidate_tepat'::uuid and kind = 'COMMENT_TEXT' and target_id = '@menfess_decision_discussion'
) then 1 else 0 end;
select 1 / case when (
  select payload = jsonb_build_object('text', 'Ready kak, cek DM ya', 'sourceChannelRef', '@menfess_decision', 'channelPostId', 'post-tepat')
    from public.workflow_commands
   where auto_comment_candidate_id = :'candidate_tepat'::uuid
) then 1 else 0 end;

-- A second decision on either candidate is rejected, not double-applied.
select 1 / case when (
  select result_status = 'ALREADY_DECIDED'
    from public.decide_auto_comment_candidate(:'candidate_tepat', '39393939-3939-3939-3939-393939393939', 'OOT')
) then 1 else 0 end;
select 1 / case when (select count(*) = 1 from public.workflow_commands where auto_comment_candidate_id = :'candidate_tepat'::uuid) then 1 else 0 end;

-- A decision from someone who doesn't own the candidate is rejected.
insert into public.app_users (id) values ('39393939-3939-3939-3939-393939393940');
select 1 / case when (
  select result_status = 'NOT_FOUND'
    from public.decide_auto_comment_candidate(:'candidate_oot', '39393939-3939-3939-3939-393939393940', 'TEPAT')
) then 1 else 0 end;

rollback;
