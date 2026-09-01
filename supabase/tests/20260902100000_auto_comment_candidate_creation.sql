-- create_auto_comment_candidate persists a matched post once per division,
-- shares one incoming_channel_posts row across divisions, and only queues an
-- AUTO_COMMENT command for AUTO_SEND divisions.

begin;
insert into public.app_users (id) values ('29292929-2929-2929-2929-292929292929');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '29292929-2929-2929-2929-292929292929',
  '{"packageId":"candidate-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '29292929-2929-2929-2929-292929292929', 'USERBOT', 'Candidate userbot', decode('00', 'hex'), 1, 'READY');

insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92', '29292929-2929-2929-2929-292929292929', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', 'Auto send division', 'AUTO_SEND');
insert into public.auto_comment_division_keywords (id, division_id, keyword)
values ('cccccccc-cccc-cccc-cccc-cccccccccc92', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92', 'promo');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('dddddddd-dddd-dddd-dddd-dddddddddd92', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92', 'Komentar promo otomatis');

insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93', '29292929-2929-2929-2929-292929292929', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', 'Approval division', 'APPROVAL_REQUIRED');
insert into public.auto_comment_division_keywords (id, division_id, keyword)
values ('cccccccc-cccc-cccc-cccc-cccccccccc93', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93', 'promo');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('dddddddd-dddd-dddd-dddd-dddddddddd93', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93', 'Menunggu review admin');

insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92', '29292929-2929-2929-2929-292929292929', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_candidate', '@menfess_candidate_discussion', 'READY');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92');

-- AUTO_SEND: a matched post immediately queues a comment command.
select 1 / case when (
  select result_status = 'COMMENT_QUEUED' and operation_id is not null and command_id is not null
    from public.create_auto_comment_candidate(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_candidate', 'post-1', 'cari admin promo dong',
      array['promo'], 'dddddddd-dddd-dddd-dddd-dddddddddd92', 'Komentar promo otomatis',
      'AUTO_SEND', '@menfess_candidate_discussion'
    )
) then 1 else 0 end;

select 1 / case when (select status = 'COMMENT_QUEUED' from public.auto_comment_candidates where division_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92' and channel_target_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92') then 1 else 0 end;
select 1 / case when (select count(*) = 1 from public.workflow_commands where auto_comment_candidate_id in (select id from public.auto_comment_candidates where division_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92')) then 1 else 0 end;

-- Re-processing the identical post for the same division is idempotent: no
-- second candidate or command, even though the matcher might observe it twice.
select 1 / case when (
  select result_status = 'ALREADY_EXISTS'
    from public.create_auto_comment_candidate(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_candidate', 'post-1', 'cari admin promo dong',
      array['promo'], 'dddddddd-dddd-dddd-dddd-dddddddddd92', 'Komentar promo otomatis',
      'AUTO_SEND', '@menfess_candidate_discussion'
    )
) then 1 else 0 end;
select 1 / case when (select count(*) = 1 from public.auto_comment_candidates where division_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92') then 1 else 0 end;

-- APPROVAL_REQUIRED: the same post matched by a different division waits for
-- review and never creates a command.
select 1 / case when (
  select result_status = 'PENDING_REVIEW' and operation_id is null and command_id is null
    from public.create_auto_comment_candidate(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_candidate', 'post-1', 'cari admin promo dong',
      array['promo'], 'dddddddd-dddd-dddd-dddd-dddddddddd93', 'Menunggu review admin',
      'APPROVAL_REQUIRED', '@menfess_candidate_discussion'
    )
) then 1 else 0 end;
select 1 / case when (select status = 'PENDING_REVIEW' from public.auto_comment_candidates where division_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_commands where auto_comment_candidate_id in (select id from public.auto_comment_candidates where division_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb93')) then 1 else 0 end;

-- Both candidates for the same post share one incoming_channel_posts row.
select 1 / case when (select count(distinct incoming_post_id) = 1 from public.auto_comment_candidates where channel_target_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee92') then 1 else 0 end;

-- A channel target that is not READY refuses any candidate at all: the
-- matcher must only call this for READY targets, but the database is the
-- final guard against a stale or racing caller.
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, resolution_status)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee93', '29292929-2929-2929-2929-292929292929', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_not_ready', 'QUEUED');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee93');
do $$ begin
  begin
    perform public.create_auto_comment_candidate(
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee93', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb92',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa92', '@menfess_not_ready', 'post-2', 'promo juga',
      array['promo'], 'dddddddd-dddd-dddd-dddd-dddddddddd92', 'Komentar promo otomatis',
      'AUTO_SEND', null
    );
    raise exception 'candidate was accepted for a channel target that is not ready';
  exception when check_violation then null; end;
end $$;

rollback;
