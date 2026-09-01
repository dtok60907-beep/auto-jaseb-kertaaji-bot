-- prune_expired_operational_data respects each table's own retention window,
-- cascades correctly, and never touches a reviewed Auto Komen candidate.

begin;
insert into public.app_users (id) values ('59595959-5959-5959-5959-595959595959');
insert into public.entitlements (user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets)
values (
  '59595959-5959-5959-5959-595959595959',
  '{"packageId":"retention-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', '59595959-5959-5959-5959-595959595959', 'USERBOT', 'Retention userbot', decode('00', 'hex'), 1, 'READY');

-- A SUCCEEDED delivery older than 3 days is pruned; one inside the window survives.
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload, updated_at)
values ('11111111-1111-1111-1111-111111111159', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'BROADCAST', 'SUCCEEDED', 'retention-op-old-succeeded', '{}', now() - interval '5 days');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number, preparation_status, delivery_status, last_success_at, created_at, updated_at)
values ('22222222-2222-2222-2222-222222222259', '11111111-1111-1111-1111-111111111159', '@old_succeeded', 0, 1, 'READY', 'SUCCEEDED', now() - interval '4 days', now() - interval '4 days', now() - interval '4 days');

insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload)
values ('11111111-1111-1111-1111-111111111160', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'BROADCAST', 'SUCCEEDED', 'retention-op-recent-succeeded', '{}');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number, preparation_status, delivery_status, last_success_at, created_at, updated_at)
values ('22222222-2222-2222-2222-222222222260', '11111111-1111-1111-1111-111111111160', '@recent_succeeded', 0, 1, 'READY', 'SUCCEEDED', now() - interval '1 day', now() - interval '1 day', now() - interval '1 day');

-- A FAILED_FINAL target older than 2 days (internal window) is pruned; a
-- command attached to it cascades away too. workflow_operations with no
-- targets left, itself old and terminal, is pruned right after.
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload, updated_at)
values ('11111111-1111-1111-1111-111111111161', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'BROADCAST', 'FAILED_FINAL', 'retention-op-old-failed', '{}', now() - interval '3 days');
insert into public.broadcast_targets (id, operation_id, telegram_target_ref, interval_seconds, sequence_number, preparation_status, delivery_status, created_at, updated_at)
values ('22222222-2222-2222-2222-222222222261', '11111111-1111-1111-1111-111111111161', '@old_failed', 0, 1, 'FAILED_FINAL', 'FAILED_FINAL', now() - interval '3 days', now() - interval '3 days');
insert into public.workflow_commands (id, operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id)
values ('33333333-3333-3333-3333-333333333361', '11111111-1111-1111-1111-111111111161', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'SEND_TEXT', '@old_failed', 'retention-cmd-old-failed', '{}', '22222222-2222-2222-2222-222222222261');

select 1 / case when (select count(*) = 3 from public.broadcast_targets where operation_id in (
  '11111111-1111-1111-1111-111111111159', '11111111-1111-1111-1111-111111111160', '11111111-1111-1111-1111-111111111161'
)) then 1 else 0 end;

select * from public.prune_expired_operational_data();

select 1 / case when not exists (select 1 from public.broadcast_targets where id = '22222222-2222-2222-2222-222222222259') then 1 else 0 end;
select 1 / case when exists (select 1 from public.broadcast_targets where id = '22222222-2222-2222-2222-222222222260') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.broadcast_targets where id = '22222222-2222-2222-2222-222222222261') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_commands where id = '33333333-3333-3333-3333-333333333361') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_operations where id = '11111111-1111-1111-1111-111111111159') then 1 else 0 end;
select 1 / case when exists (select 1 from public.workflow_operations where id = '11111111-1111-1111-1111-111111111160') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_operations where id = '11111111-1111-1111-1111-111111111161') then 1 else 0 end;

-- An expired api_session is pruned; a recent one survives.
insert into public.api_sessions (id, user_id, token_hash, init_data_hash, created_at, expires_at)
values ('44444444-4444-4444-4444-444444444459', '59595959-5959-5959-5959-595959595959', decode(repeat('a1', 32), 'hex'), decode(repeat('a2', 32), 'hex'), now() - interval '10 days', now() - interval '3 days');
insert into public.api_sessions (id, user_id, token_hash, init_data_hash, created_at, expires_at)
values ('44444444-4444-4444-4444-444444444460', '59595959-5959-5959-5959-595959595959', decode(repeat('b1', 32), 'hex'), decode(repeat('b2', 32), 'hex'), now() - interval '1 hour', now() + interval '1 day');

-- A terminal auth flow older than 2 days is pruned; a fresh one survives.
insert into public.telegram_account_auth_flows (id, user_id, status, expires_at, finalized_at, created_at, updated_at)
values ('55555555-5555-5555-5555-555555555559', '59595959-5959-5959-5959-595959595959', 'EXPIRED', now() - interval '3 days', now() - interval '3 days', now() - interval '4 days', now() - interval '3 days');
insert into public.telegram_account_auth_flows (id, user_id, status, expires_at, created_at, updated_at)
values ('55555555-5555-5555-5555-555555555560', '59595959-5959-5959-5959-595959595959', 'CREATED', now() + interval '10 minutes', now(), now());

select * from public.prune_expired_operational_data();

select 1 / case when not exists (select 1 from public.api_sessions where id = '44444444-4444-4444-4444-444444444459') then 1 else 0 end;
select 1 / case when exists (select 1 from public.api_sessions where id = '44444444-4444-4444-4444-444444444460') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.telegram_account_auth_flows where id = '55555555-5555-5555-5555-555555555559') then 1 else 0 end;
select 1 / case when exists (select 1 from public.telegram_account_auth_flows where id = '55555555-5555-5555-5555-555555555560') then 1 else 0 end;

-- Auto Komen: a reviewed candidate is never touched, no matter how old --
-- auto_comment_reviews is immutable and its FK blocks the delete anyway.
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('66666666-6666-6666-6666-666666666659', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'Retention division', 'APPROVAL_REQUIRED');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('77777777-7777-7777-7777-777777777759', '66666666-6666-6666-6666-666666666659', 'template balasan');
insert into public.auto_comment_division_keywords (division_id, keyword)
values ('66666666-6666-6666-6666-666666666659', 'promo');
insert into public.auto_comment_channel_targets (id, user_id, account_id, source_channel_ref, discussion_target_ref, resolution_status)
values ('88888888-8888-8888-8888-888888888859', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', '@retention_channel', '@retention_discussion', 'READY');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('66666666-6666-6666-6666-666666666659', '88888888-8888-8888-8888-888888888859');

insert into public.incoming_channel_posts (id, account_id, source_channel_ref, provider_post_id, content, received_at)
values ('99999999-9999-9999-9999-999999999959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', '@retention_channel', 'post-reviewed', 'promo lama', now() - interval '10 days');
insert into public.auto_comment_candidates (id, division_id, channel_target_id, incoming_post_id, selected_template_id, template_text_snapshot, matched_keywords_snapshot, mode_snapshot, discussion_target_ref_snapshot, status, created_at, updated_at)
values ('aaaa1111-1111-1111-1111-111111111159', '66666666-6666-6666-6666-666666666659', '88888888-8888-8888-8888-888888888859', '99999999-9999-9999-9999-999999999959', '77777777-7777-7777-7777-777777777759', 'template balasan', array['promo'], 'APPROVAL_REQUIRED', '@retention_discussion', 'OOT', now() - interval '10 days', now() - interval '10 days');
insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision, decided_at)
values ('aaaa1111-1111-1111-1111-111111111159', '59595959-5959-5959-5959-595959595959', 'OOT', now() - interval '10 days');

-- An unreviewed AUTO_SEND candidate, old and terminal, is pruned along with
-- its queued command, its operation, and its now-unreferenced post.
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode)
values ('66666666-6666-6666-6666-666666666660', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'Retention auto-send division', 'AUTO_SEND');
insert into public.auto_comment_division_templates (id, division_id, text_content)
values ('77777777-7777-7777-7777-777777777760', '66666666-6666-6666-6666-666666666660', 'template auto-send');
insert into public.auto_comment_division_keywords (division_id, keyword)
values ('66666666-6666-6666-6666-666666666660', 'promo');
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('66666666-6666-6666-6666-666666666660', '88888888-8888-8888-8888-888888888859');

insert into public.incoming_channel_posts (id, account_id, source_channel_ref, provider_post_id, content, received_at)
values ('99999999-9999-9999-9999-999999999960', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', '@retention_channel', 'post-unreviewed', 'promo auto', now() - interval '10 days');
insert into public.auto_comment_candidates (id, division_id, channel_target_id, incoming_post_id, selected_template_id, template_text_snapshot, matched_keywords_snapshot, mode_snapshot, discussion_target_ref_snapshot, status, created_at, updated_at)
values ('aaaa1111-1111-1111-1111-111111111160', '66666666-6666-6666-6666-666666666660', '88888888-8888-8888-8888-888888888859', '99999999-9999-9999-9999-999999999960', '77777777-7777-7777-7777-777777777760', 'template auto-send', array['promo'], 'AUTO_SEND', '@retention_discussion', 'COMMENT_QUEUED', now() - interval '10 days', now() - interval '10 days');
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload)
values ('11111111-1111-1111-1111-111111111162', '59595959-5959-5959-5959-595959595959', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'AUTO_COMMENT', 'SUCCEEDED', 'retention-auto-comment-op', '{"candidateId":"aaaa1111-1111-1111-1111-111111111160"}');
insert into public.workflow_commands (id, operation_id, account_id, kind, target_id, idempotency_key, payload, auto_comment_candidate_id)
values ('33333333-3333-3333-3333-333333333362', '11111111-1111-1111-1111-111111111162', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa59', 'COMMENT_TEXT', '@retention_discussion', 'retention-auto-comment-cmd', '{"text":"template auto-send"}', 'aaaa1111-1111-1111-1111-111111111160');
update public.workflow_commands set status = 'SUCCEEDED' where id = '33333333-3333-3333-3333-333333333362';
-- Simulate the candidate having reached its terminal state after the
-- (not-yet-built) send executor ran, without disturbing the backdated
-- updated_at that set_updated_at would otherwise reset on any UPDATE.
alter table public.auto_comment_candidates disable trigger auto_comment_candidates_set_updated_at;
update public.auto_comment_candidates set status = 'COMMENT_SENT', updated_at = now() - interval '10 days' where id = 'aaaa1111-1111-1111-1111-111111111160';
alter table public.auto_comment_candidates enable trigger auto_comment_candidates_set_updated_at;

select * from public.prune_expired_operational_data();

-- The reviewed candidate and its immutable review both survive untouched.
select 1 / case when exists (select 1 from public.auto_comment_candidates where id = 'aaaa1111-1111-1111-1111-111111111159') then 1 else 0 end;
select 1 / case when exists (select 1 from public.auto_comment_reviews where candidate_id = 'aaaa1111-1111-1111-1111-111111111159') then 1 else 0 end;
select 1 / case when exists (select 1 from public.incoming_channel_posts where id = '99999999-9999-9999-9999-999999999959') then 1 else 0 end;

-- The unreviewed AUTO_SEND candidate, its command, its operation, and its
-- post (no longer referenced by any candidate) are all pruned.
select 1 / case when not exists (select 1 from public.auto_comment_candidates where id = 'aaaa1111-1111-1111-1111-111111111160') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_commands where id = '33333333-3333-3333-3333-333333333362') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.workflow_operations where id = '11111111-1111-1111-1111-111111111162') then 1 else 0 end;
select 1 / case when not exists (select 1 from public.incoming_channel_posts where id = '99999999-9999-9999-9999-999999999960') then 1 else 0 end;

-- An invalid retention window is rejected outright.
do $$ begin
  begin
    perform public.prune_expired_operational_data(interval '0', interval '2 days');
    raise exception 'zero retention window was accepted';
  exception when others then
    if sqlerrm <> 'INVALID_RETENTION_WINDOW' then raise; end if;
  end;
end $$;

rollback;
