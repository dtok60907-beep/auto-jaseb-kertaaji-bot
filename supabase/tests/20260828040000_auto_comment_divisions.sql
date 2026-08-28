-- Run after migrations V1 through V5. Test bootstrap must provide auth.users(id uuid),
-- auth.uid() based on request.jwt.claim.sub, and grants for role authenticated.

begin;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status
)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'USERBOT', 'Userbot owner', decode('00', 'hex'), 1, 'READY'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', 'USERBOT', 'Userbot other', decode('00', 'hex'), 1, 'READY');

insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Kos Putri', 'APPROVAL_REQUIRED'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', 'Laundry', 'AUTO_SEND');

insert into public.auto_comment_division_keywords (division_id, keyword)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'cari kos'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'cari laundry');

insert into public.auto_comment_division_templates (id, division_id, text_content)
values
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'Halo, masih cari kos putri?'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'Halo, butuh laundry?');

insert into public.auto_comment_channel_targets (
  id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status
)
values (
  'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  '@base_menfess',
  '@base_menfess_discussion',
  'READY'
);

insert into public.auto_comment_division_channels (division_id, channel_target_id)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'dddddddd-dddd-dddd-dddd-ddddddddddd1'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'dddddddd-dddd-dddd-dddd-ddddddddddd1');

insert into public.incoming_channel_posts (
  id, account_id, source_channel_ref, provider_post_id, content
)
values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-1', 'cari kos putri'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-2', 'cari laundry'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-3', 'cari kos lagi'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-4', 'cari kos tapi tidak tepat');

insert into public.auto_comment_candidates (
  id, division_id, channel_target_id, incoming_post_id, selected_template_id,
  template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
  discussion_target_ref_snapshot, status
)
values (
  'ffffffff-ffff-ffff-ffff-fffffffffff1',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
  'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1',
  'cccccccc-cccc-cccc-cccc-ccccccccccc1',
  'Halo, masih cari kos putri?',
  array['cari kos'],
  'APPROVAL_REQUIRED',
  '@base_menfess_discussion',
  'PENDING_REVIEW'
);

update public.auto_comment_candidates
   set status = 'COMMENT_QUEUED'
 where id = 'ffffffff-ffff-ffff-ffff-fffffffffff1';

insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
values ('ffffffff-ffff-ffff-ffff-fffffffffff1', '11111111-1111-1111-1111-111111111111', 'TEPAT');

insert into public.workflow_operations (
  id, user_id, account_id, operation_type, status, idempotency_key, payload
)
values (
  '99999999-9999-9999-9999-999999999991',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'AUTO_COMMENT', 'QUEUED', 'auto-op-approval-1', '{}'::jsonb
);

insert into public.workflow_commands (
  operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id
)
values (
  '99999999-9999-9999-9999-999999999991',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'COMMENT_TEXT', '@base_menfess_discussion', 'auto-command-approval-1', '{}'::jsonb,
  'ffffffff-ffff-ffff-ffff-fffffffffff1'
);

insert into public.auto_comment_candidates (
  id, division_id, channel_target_id, incoming_post_id, selected_template_id,
  template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
  discussion_target_ref_snapshot, status
)
values (
  'ffffffff-ffff-ffff-ffff-fffffffffff2',
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
  'dddddddd-dddd-dddd-dddd-ddddddddddd1',
  'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee2',
  'cccccccc-cccc-cccc-cccc-ccccccccccc2',
  'Halo, butuh laundry?',
  array['cari laundry'],
  'AUTO_SEND',
  '@base_menfess_discussion',
  'COMMENT_QUEUED'
);

insert into public.workflow_operations (
  id, user_id, account_id, operation_type, status, idempotency_key, payload
)
values (
  '99999999-9999-9999-9999-999999999992',
  '11111111-1111-1111-1111-111111111111',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'AUTO_COMMENT', 'QUEUED', 'auto-op-auto-send-1', '{}'::jsonb
);

insert into public.workflow_commands (
  operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id
)
values (
  '99999999-9999-9999-9999-999999999992',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
  'COMMENT_TEXT', '@base_menfess_discussion', 'auto-command-auto-send-1', '{}'::jsonb,
  'ffffffff-ffff-ffff-ffff-fffffffffff2'
);

do $$
begin
  begin
    insert into public.auto_comment_divisions (user_id, account_id, name)
    values (
      '11111111-1111-1111-1111-111111111111',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      'Akun orang lain'
    );
    raise exception 'cross-owner division was accepted';
  exception when insufficient_privilege then
    null;
  end;

  begin
    insert into public.auto_comment_candidates (
      division_id, channel_target_id, incoming_post_id, selected_template_id,
      template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
      discussion_target_ref_snapshot, status
    )
    values (
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
      'dddddddd-dddd-dddd-dddd-ddddddddddd1',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3',
      'cccccccc-cccc-cccc-cccc-ccccccccccc2',
      'Halo, butuh laundry?',
      array['cari kos'],
      'APPROVAL_REQUIRED',
      '@base_menfess_discussion',
      'PENDING_REVIEW'
    );
    raise exception 'foreign division template was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.auto_comment_candidates (
      id, division_id, channel_target_id, incoming_post_id, selected_template_id,
      template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
      discussion_target_ref_snapshot, status
    )
    values (
      'ffffffff-ffff-ffff-ffff-fffffffffff3',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
      'dddddddd-dddd-dddd-dddd-ddddddddddd1',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee3',
      'cccccccc-cccc-cccc-cccc-ccccccccccc1',
      'Halo, masih cari kos putri?',
      array['cari kos'],
      'APPROVAL_REQUIRED',
      '@base_menfess_discussion',
      'COMMENT_QUEUED'
    );
    insert into public.workflow_operations (
      id, user_id, account_id, operation_type, status, idempotency_key, payload
    )
    values (
      '99999999-9999-9999-9999-999999999993',
      '11111111-1111-1111-1111-111111111111',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'AUTO_COMMENT', 'QUEUED', 'auto-op-no-review-1', '{}'::jsonb
    );
    insert into public.workflow_commands (
      operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id
    )
    values (
      '99999999-9999-9999-9999-999999999993',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'COMMENT_TEXT', '@base_menfess_discussion', 'auto-command-no-review-1', '{}'::jsonb,
      'ffffffff-ffff-ffff-ffff-fffffffffff3'
    );
    raise exception 'approval command without Tepat was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
    values ('ffffffff-ffff-ffff-ffff-fffffffffff1', '11111111-1111-1111-1111-111111111111', 'TEPAT');
    raise exception 'duplicate review was accepted';
  exception when unique_violation then
    null;
  end;

  begin
    insert into public.auto_comment_candidates (
      id, division_id, channel_target_id, incoming_post_id, selected_template_id,
      template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
      discussion_target_ref_snapshot, status
    )
    values (
      'ffffffff-ffff-ffff-ffff-fffffffffff4',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
      'dddddddd-dddd-dddd-dddd-ddddddddddd1',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee4',
      'cccccccc-cccc-cccc-cccc-ccccccccccc1',
      'Halo, masih cari kos putri?',
      array['cari kos'],
      'APPROVAL_REQUIRED',
      '@base_menfess_discussion',
      'OOT'
    );
    insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
    values ('ffffffff-ffff-ffff-ffff-fffffffffff4', '11111111-1111-1111-1111-111111111111', 'OOT');
    insert into public.workflow_operations (
      id, user_id, account_id, operation_type, status, idempotency_key, payload
    )
    values (
      '99999999-9999-9999-9999-999999999994',
      '11111111-1111-1111-1111-111111111111',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'AUTO_COMMENT', 'QUEUED', 'auto-op-oot-1', '{}'::jsonb
    );
    insert into public.workflow_commands (
      operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id
    )
    values (
      '99999999-9999-9999-9999-999999999994',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'COMMENT_TEXT', '@base_menfess_discussion', 'auto-command-oot-1', '{}'::jsonb,
      'ffffffff-ffff-ffff-ffff-fffffffffff4'
    );
    raise exception 'OOT candidate command was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

insert into public.incoming_channel_posts (id, account_id, source_channel_ref, provider_post_id, content)
values
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-5', 'cari kos final'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '@base_menfess', 'post-6', 'cari kos oot');

insert into public.auto_comment_candidates (
  id, division_id, channel_target_id, incoming_post_id, selected_template_id,
  template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
  discussion_target_ref_snapshot, status
)
values
  ('ffffffff-ffff-ffff-ffff-fffffffffff5', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
   'dddddddd-dddd-dddd-dddd-ddddddddddd1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee5',
   'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'Halo, masih cari kos putri?', array['cari kos'],
   'APPROVAL_REQUIRED', '@base_menfess_discussion', 'PENDING_REVIEW'),
  ('ffffffff-ffff-ffff-ffff-fffffffffff6', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
   'dddddddd-dddd-dddd-dddd-ddddddddddd1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee6',
   'cccccccc-cccc-cccc-cccc-ccccccccccc1', 'Halo, masih cari kos putri?', array['cari kos'],
   'APPROVAL_REQUIRED', '@base_menfess_discussion', 'PENDING_REVIEW');

select 1 / case when (select result_status from public.decide_auto_comment_candidate(
  'ffffffff-ffff-ffff-ffff-fffffffffff5', '11111111-1111-1111-1111-111111111111', 'TEPAT'
)) = 'COMMENT_QUEUED' then 1 else 0 end;
select 1 / case when (select count(*) from public.workflow_commands
  where auto_comment_candidate_id = 'ffffffff-ffff-ffff-ffff-fffffffffff5') = 1 then 1 else 0 end;
select 1 / case when (select result_status from public.decide_auto_comment_candidate(
  'ffffffff-ffff-ffff-ffff-fffffffffff5', '11111111-1111-1111-1111-111111111111', 'TEPAT'
)) = 'ALREADY_DECIDED' then 1 else 0 end;
select 1 / case when (select result_status from public.decide_auto_comment_candidate(
  'ffffffff-ffff-ffff-ffff-fffffffffff6', '11111111-1111-1111-1111-111111111111', 'OOT'
)) = 'OOT' then 1 else 0 end;
select 1 / case when (select count(*) from public.workflow_commands
  where auto_comment_candidate_id = 'ffffffff-ffff-ffff-ffff-fffffffffff6') = 0 then 1 else 0 end;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select 1 / case when (select count(*) from public.auto_comment_divisions) = 2 then 1 else 0 end;
select 1 / case when (select count(*) from public.auto_comment_candidates) = 4 then 1 else 0 end;

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select 1 / case when (select count(*) from public.auto_comment_divisions) = 0 then 1 else 0 end;
select 1 / case when (select count(*) from public.auto_comment_candidates) = 0 then 1 else 0 end;
reset role;

rollback;
