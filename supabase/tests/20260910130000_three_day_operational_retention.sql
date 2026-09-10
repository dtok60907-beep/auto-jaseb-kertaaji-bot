begin;

insert into auth.users (id) values ('72000000-0000-4000-8000-000000000001');
insert into public.app_users (id, telegram_user_id, first_name, last_authenticated_at)
values ('72000000-0000-4000-8000-000000000001', 720001, 'Retention user', now());

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session,
  encryption_key_version, provider_user_id, status
) values (
  '72000000-0000-4000-8000-000000000002',
  '72000000-0000-4000-8000-000000000001', 'USERBOT', 'Retention userbot',
  decode('00', 'hex'), 1, 720002, 'READY'
);

insert into public.entitlements (
  user_id, package_snapshot, status, starts_at, expires_at,
  max_lpm_groups, max_channel_targets
) values (
  '72000000-0000-4000-8000-000000000001',
  '{"packageId":"retention-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);

insert into public.userbot_profiles (user_id, active_account_id, status)
values (
  '72000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002', 'CONNECTED'
);
select 1 / case when public.set_auto_comment_enabled(
  '72000000-0000-4000-8000-000000000001', true
) then 1 else 0 end;

insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values
  (
    '72000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002', 'Auto', 'AUTO_SEND'
  ),
  (
    '72000000-0000-4000-8000-000000000004',
    '72000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002', 'Approval', 'APPROVAL_REQUIRED'
  );
insert into public.auto_comment_division_keywords (division_id, keyword)
values
  ('72000000-0000-4000-8000-000000000003', 'auto'),
  ('72000000-0000-4000-8000-000000000004', 'approval');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values
  ('72000000-0000-4000-8000-000000000005', '72000000-0000-4000-8000-000000000003', 'Auto reply'),
  ('72000000-0000-4000-8000-000000000006', '72000000-0000-4000-8000-000000000004', 'Approval reply');

insert into public.auto_comment_channel_targets (
  id, user_id, account_id, source_channel_ref,
  discussion_target_ref, resolution_status
) values (
  '72000000-0000-4000-8000-000000000007',
  '72000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002', '@retention_source',
  '@retention_discussion', 'READY'
);
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values
  ('72000000-0000-4000-8000-000000000003', '72000000-0000-4000-8000-000000000007'),
  ('72000000-0000-4000-8000-000000000004', '72000000-0000-4000-8000-000000000007');

select * from public.create_auto_comment_candidate(
  '72000000-0000-4000-8000-000000000007',
  '72000000-0000-4000-8000-000000000003',
  '72000000-0000-4000-8000-000000000002',
  '@retention_source', 'old-auto', 'auto request', array['auto'],
  '72000000-0000-4000-8000-000000000005', 'Auto reply', 'AUTO_SEND',
  '@retention_discussion'
);
select * from public.create_auto_comment_candidate(
  '72000000-0000-4000-8000-000000000007',
  '72000000-0000-4000-8000-000000000004',
  '72000000-0000-4000-8000-000000000002',
  '@retention_source', 'old-review', 'approval request', array['approval'],
  '72000000-0000-4000-8000-000000000006', 'Approval reply', 'APPROVAL_REQUIRED',
  '@retention_discussion'
);
select * from public.decide_auto_comment_candidate(
  (
    select candidate.id
      from public.auto_comment_candidates candidate
      join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
     where post.provider_post_id = 'old-review'
  ),
  '72000000-0000-4000-8000-000000000001', 'OOT'
);
select * from public.create_auto_comment_candidate(
  '72000000-0000-4000-8000-000000000007',
  '72000000-0000-4000-8000-000000000003',
  '72000000-0000-4000-8000-000000000002',
  '@retention_source', 'recent-auto', 'auto recent', array['auto'],
  '72000000-0000-4000-8000-000000000005', 'Auto reply', 'AUTO_SEND',
  '@retention_discussion'
);

update public.auto_comment_candidates candidate
   set created_at = now() - interval '4 days'
  from public.incoming_channel_posts post
 where post.id = candidate.incoming_post_id
   and post.provider_post_id in ('old-auto', 'old-review');
update public.incoming_channel_posts
   set received_at = now() - interval '4 days'
 where provider_post_id in ('old-auto', 'old-review');

insert into public.comment_rules (
  id, user_id, account_id, source_channel_ref, discussion_target_ref,
  regex_source, comment_text
) values (
  '72000000-0000-4000-8000-000000000008',
  '72000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002', '@legacy_source',
  '@legacy_discussion', 'legacy', 'Legacy reply'
);
insert into public.incoming_channel_posts (
  id, account_id, source_channel_ref, provider_post_id, content, received_at
) values (
  '72000000-0000-4000-8000-000000000009',
  '72000000-0000-4000-8000-000000000002', '@legacy_source',
  'old-legacy', 'legacy', now() - interval '4 days'
);
insert into public.comment_matches (
  id, rule_id, incoming_post_id, status, created_at, updated_at
) values (
  '72000000-0000-4000-8000-000000000010',
  '72000000-0000-4000-8000-000000000008',
  '72000000-0000-4000-8000-000000000009', 'MATCHED',
  now() - interval '4 days', now() - interval '4 days'
);

insert into public.auto_comment_monitor_events (
  source_id, provider_post_id, content, received_at
)
select monitor_source_id, 801, 'old pending event', now() - interval '4 days'
  from public.auto_comment_channel_targets
 where id = '72000000-0000-4000-8000-000000000007';
insert into public.auto_comment_monitor_events (
  source_id, provider_post_id, content, received_at
)
select monitor_source_id, 802, 'recent event', now()
  from public.auto_comment_channel_targets
 where id = '72000000-0000-4000-8000-000000000007';

do $$
begin
  begin
    delete from public.auto_comment_reviews;
    raise exception 'review delete unexpectedly allowed';
  exception when sqlstate '55000' then
    null;
  end;
end;
$$;

select * from public.prune_expired_auto_comment_data(interval '3 days', 5000);

select 1 / case when not exists (
  select 1
    from public.auto_comment_candidates candidate
    join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
   where post.provider_post_id in ('old-auto', 'old-review')
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.auto_comment_reviews
) then 1 else 0 end;
select 1 / case when (
  select count(*) = 1
    from public.workflow_operations operation
    join public.workflow_commands command on command.operation_id = operation.id
    join public.auto_comment_candidates candidate on candidate.id = command.auto_comment_candidate_id
    join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
   where operation.operation_type = 'AUTO_COMMENT'
     and post.provider_post_id = 'recent-auto'
) then 1 else 0 end;
select 1 / case when (
  select count(*) = 1 from public.workflow_operations
   where operation_type = 'AUTO_COMMENT'
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.comment_matches
   where id = '72000000-0000-4000-8000-000000000010'
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.incoming_channel_posts
   where provider_post_id in ('old-auto', 'old-review', 'old-legacy')
) then 1 else 0 end;
select 1 / case when not exists (
  select 1 from public.auto_comment_monitor_events where provider_post_id = 801
) then 1 else 0 end;

select 1 / case when (
  select count(*) = 1
    from public.auto_comment_candidates candidate
    join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
   where post.provider_post_id = 'recent-auto'
) then 1 else 0 end;
select 1 / case when exists (
  select 1 from public.auto_comment_monitor_events where provider_post_id = 802
) then 1 else 0 end;
select 1 / case when exists (
  select 1 from public.auto_comment_channel_targets
   where id = '72000000-0000-4000-8000-000000000007'
) and exists (
  select 1 from public.telegram_accounts
   where id = '72000000-0000-4000-8000-000000000002'
) and exists (
  select 1 from public.entitlements
   where user_id = '72000000-0000-4000-8000-000000000001'
) then 1 else 0 end;

rollback;
