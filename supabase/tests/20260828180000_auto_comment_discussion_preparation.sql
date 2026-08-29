-- Linked discussion approval gates both candidate creation and command claims.

begin;
insert into auth.users (id) values ('19191919-1919-1919-1919-191919191919');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '19191919-1919-1919-1919-191919191919',
  '{"packageId":"discussion-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 1
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '19191919-1919-1919-1919-191919191919', 'USERBOT', 'Discussion userbot', decode('00', 'hex'), 1, 'READY');
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91', '19191919-1919-1919-1919-191919191919', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', 'Approval division', 'AUTO_SEND');
insert into public.auto_comment_division_keywords (id, division_id, keyword)
values ('cccccccc-cccc-cccc-cccc-cccccccccc91', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91', 'keyword');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('dddddddd-dddd-dddd-dddd-dddddddddd91', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91', 'komentar');
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref)
values ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', '19191919-1919-1919-1919-191919191919', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '@menfess_approval');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91');
insert into public.incoming_channel_posts (id, account_id, source_channel_ref, provider_post_id, content)
values ('ffffffff-ffff-ffff-ffff-fffffffffff1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '@menfess_approval', 'post-approval-1', 'keyword');
select 1 / case when (select result_status = 'ACQUIRED' from public.acquire_account_lease('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 60)) then 1 else 0 end;

select 1 / case when (select previous_status = 'QUEUED' from public.claim_next_auto_comment_preparation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1)) then 1 else 0 end;
select 1 / case when public.transition_auto_comment_preparation('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 'CHECKING', 'JOINING', '@menfess_discussion') then 1 else 0 end;
select 1 / case when public.transition_auto_comment_preparation('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 'JOINING', 'WAITING_APPROVAL', '@menfess_discussion', 'JOIN_APPROVAL_PENDING', 30) then 1 else 0 end;
select 1 / case when (select resolution_approval_requested_at is not null and last_error_code = 'JOIN_APPROVAL_PENDING' from public.auto_comment_channel_targets where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91') then 1 else 0 end;

do $$ begin
  begin
    insert into public.auto_comment_candidates (
      id, division_id, channel_target_id, incoming_post_id, selected_template_id,
      template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
      discussion_target_ref_snapshot, status
    ) values (
      'ffffffff-ffff-ffff-ffff-fffffffffff2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'ffffffff-ffff-ffff-ffff-fffffffffff1',
      'dddddddd-dddd-dddd-dddd-dddddddddd91', 'komentar', array['keyword'], 'AUTO_SEND',
      '@menfess_discussion', 'COMMENT_QUEUED'
    );
    raise exception 'candidate was accepted while discussion approval was pending';
  exception when check_violation then null; end;
end $$;

update public.auto_comment_channel_targets set resolution_available_at = now() - interval '1 second' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91';
select 1 / case when (select previous_status = 'WAITING_APPROVAL' from public.claim_next_auto_comment_preparation('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1)) then 1 else 0 end;
select 1 / case when not public.transition_auto_comment_preparation('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999992', 1, 'CHECKING', 'READY', '@menfess_discussion') then 1 else 0 end;
select 1 / case when public.transition_auto_comment_preparation('eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 'CHECKING', 'READY', '@menfess_discussion') then 1 else 0 end;

insert into public.auto_comment_candidates (
  id, division_id, channel_target_id, incoming_post_id, selected_template_id,
  template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
  discussion_target_ref_snapshot, status
) values (
  'ffffffff-ffff-ffff-ffff-fffffffffff2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb91',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91', 'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'dddddddd-dddd-dddd-dddd-dddddddddd91', 'komentar', array['keyword'], 'AUTO_SEND',
  '@menfess_discussion', 'COMMENT_QUEUED'
);
insert into public.workflow_operations (id, user_id, account_id, operation_type, idempotency_key, payload)
values ('11111111-1111-1111-1111-111111111191', '19191919-1919-1919-1919-191919191919', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', 'AUTO_COMMENT', 'discussion-operation-0001', '{}');
insert into public.workflow_commands (id, operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id)
values ('22222222-2222-2222-2222-222222222291', '11111111-1111-1111-1111-111111111191', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', 'COMMENT_TEXT', '@menfess_discussion', 'discussion-command-0001', '{"text":"komentar"}', 'ffffffff-ffff-ffff-ffff-fffffffffff2');

update public.auto_comment_channel_targets set active = false where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91';
select 1 / case when not exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 60)) then 1 else 0 end;
update public.auto_comment_channel_targets set active = true, resolution_status = 'WAITING_APPROVAL', last_error_code = 'JOIN_APPROVAL_PENDING' where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91';
select 1 / case when not exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 60)) then 1 else 0 end;
update public.auto_comment_channel_targets set resolution_status = 'READY', last_error_code = null where id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeee91';
select 1 / case when exists (select 1 from public.claim_next_workflow_command('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa91', '99999999-9999-9999-9999-999999999991', 1, 60)) then 1 else 0 end;

rollback;
