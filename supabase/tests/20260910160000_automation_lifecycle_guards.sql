-- Regression matrix for disable/delete/final-execution guards.

begin;

insert into auth.users (id) values ('81818181-8181-8181-8181-818181818181');

insert into public.app_users (id, telegram_user_id, first_name, last_authenticated_at)
values ('81818181-8181-8181-8181-818181818181', 81818181, 'Lifecycle user', now());

insert into public.entitlements (
  user_id, package_snapshot, status, starts_at, expires_at,
  max_lpm_groups, max_channel_targets
) values (
  '81818181-8181-8181-8181-818181818181',
  '{"packageId":"lifecycle","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":20,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 20, 20
);

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session,
  encryption_key_version, status
) values (
  '82828282-8282-8282-8282-828282828282',
  '81818181-8181-8181-8181-818181818181',
  'USERBOT', 'Lifecycle userbot', decode('deadbeef', 'hex'), 1, 'READY'
);

insert into public.userbot_profiles (user_id, active_account_id, status, broadcast_interval_seconds)
values ('81818181-8181-8181-8181-818181818181', '82828282-8282-8282-8282-828282828282', 'CONNECTED', 0);

insert into public.broadcast_materials (id, user_id, kind, text_content, active)
values ('83838383-8383-8383-8383-838383838383', '81818181-8181-8181-8181-818181818181', 'TEXT', 'promo', true);

insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref, active)
values ('84848484-8484-8484-8484-848484848484', '81818181-8181-8181-8181-818181818181', '@lifecycle_group', true);

select operation_id as first_operation_id
  from public.create_broadcast_operation(
    '81818181-8181-8181-8181-818181818181', 'USERBOT',
    '83838383-8383-8383-8383-838383838383',
    array['84848484-8484-8484-8484-848484848484']::uuid[],
    'lifecycle-first-operation'
  ) \gset

update public.broadcast_lpm_targets set active = false where id = '84848484-8484-8484-8484-848484848484';
select 1 / case when (select status = 'CANCELLED' from public.workflow_operations where id = :'first_operation_id') then 1 else 0 end;
select 1 / case when (select delivery_status = 'CANCELLED' from public.broadcast_targets where operation_id = :'first_operation_id') then 1 else 0 end;

update public.broadcast_lpm_targets set active = true where id = '84848484-8484-8484-8484-848484848484';
select public.create_broadcast_campaign(
  '81818181-8181-8181-8181-818181818181', 'USERBOT',
  '83838383-8383-8383-8383-838383838383',
  array['84848484-8484-8484-8484-848484848484']::uuid[], 300
) as campaign_id \gset
select operation_id as campaign_operation_id
  from public.create_broadcast_campaign_cycle(:'campaign_id', now()) \gset
select 1 / case when public.stop_broadcast_campaign(:'campaign_id', '81818181-8181-8181-8181-818181818181') then 1 else 0 end;
select 1 / case when (select status = 'CANCELLED' from public.workflow_operations where id = :'campaign_operation_id') then 1 else 0 end;

-- A config deletion committed after a claim must still prevent the side effect.
select operation_id as claimed_operation_id
  from public.create_broadcast_operation(
    '81818181-8181-8181-8181-818181818181', 'USERBOT',
    '83838383-8383-8383-8383-838383838383',
    array['84848484-8484-8484-8484-848484848484']::uuid[],
    'lifecycle-claimed-operation'
  ) \gset
update public.broadcast_targets
   set preparation_status = 'READY'
 where operation_id = :'claimed_operation_id';
select * from public.acquire_account_lease(
  '82828282-8282-8282-8282-828282828282',
  '85858585-8585-8585-8585-858585858585', 120
);
select command_id as claimed_target_id
  from public.claim_next_broadcast_command(
    '82828282-8282-8282-8282-828282828282',
    '85858585-8585-8585-8585-858585858585', 1, 60
  ) \gset
update public.broadcast_lpm_targets set active = false where id = '84848484-8484-8484-8484-848484848484';
select 1 / case when public.validate_broadcast_execution(
  :'claimed_target_id', '82828282-8282-8282-8282-828282828282',
  '85858585-8585-8585-8585-858585858585', 1
) = 'CANCELLED' then 1 else 0 end;

-- A deleted configuration row stays available to historical jobs, but no
-- longer owns the user-facing uniqueness key.
update public.broadcast_lpm_targets
   set active = false, deleted_at = now()
 where id = '84848484-8484-8484-8484-848484848484';
insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref, active)
values (
  '89898989-8989-8989-8989-898989898989',
  '81818181-8181-8181-8181-818181818181', '@lifecycle_group', true
);
select 1 / case when (
  select count(*) = 1 from public.broadcast_lpm_targets
   where user_id = '81818181-8181-8181-8181-818181818181'
     and telegram_target_ref = '@lifecycle_group' and deleted_at is null
) then 1 else 0 end;

-- A first target waiting for join approval cannot block a later READY target.
insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref, active)
values (
  '91919191-9191-9191-9191-919191919191',
  '81818181-8181-8181-8181-818181818181', '@lifecycle_ready_group', true
);
select operation_id as independent_operation_id
  from public.create_broadcast_operation(
    '81818181-8181-8181-8181-818181818181', 'USERBOT',
    '83838383-8383-8383-8383-838383838383',
    array[
      '89898989-8989-8989-8989-898989898989',
      '91919191-9191-9191-9191-919191919191'
    ]::uuid[],
    'lifecycle-independent-targets'
  ) \gset
update public.broadcast_targets
   set preparation_status = case sequence_number when 1 then 'WAITING_APPROVAL' else 'READY' end,
       preparation_available_at = case sequence_number when 1 then now() + interval '1 hour' else now() end
 where operation_id = :'independent_operation_id';
select 1 / case when (
  select has_delivery_work
    from public.list_broadcast_runtime_accounts(1, 0, now(), 10)
   where account_id = '82828282-8282-8282-8282-828282828282'
) then 1 else 0 end;
select command_id as independent_claimed_target_id
  from public.claim_next_broadcast_command(
    '82828282-8282-8282-8282-828282828282',
    '85858585-8585-8585-8585-858585858585', 1, 60
  ) \gset
select 1 / case when :'independent_claimed_target_id' = (
  select id::text from public.broadcast_targets
   where operation_id = :'independent_operation_id' and sequence_number = 2
) then 1 else 0 end;

-- Auto Comment setup and master-disable guard.
insert into public.auto_comment_channel_targets (
  id, user_id, account_id, source_channel_ref, discussion_target_ref,
  resolution_status, active
) values (
  '86868686-8686-8686-8686-868686868686',
  '81818181-8181-8181-8181-818181818181',
  '82828282-8282-8282-8282-828282828282', '@lifecycle_source',
  '@lifecycle_discussion', 'READY', true
);
insert into public.auto_comment_divisions (id, user_id, account_id, name, mode, active)
values (
  '87878787-8787-8787-8787-878787878787',
  '81818181-8181-8181-8181-818181818181',
  '82828282-8282-8282-8282-828282828282', 'Lifecycle', 'AUTO_SEND', true
);
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values ('87878787-8787-8787-8787-878787878787', '86868686-8686-8686-8686-868686868686');
insert into public.auto_comment_division_keywords (division_id, keyword)
values ('87878787-8787-8787-8787-878787878787', 'ready');
insert into public.auto_comment_division_templates (id, division_id, text_content, display_order, active)
values ('88888888-8888-8888-8888-888888888888', '87878787-8787-8787-8787-878787878787', 'comment', 0, true);
select 1 / case when public.set_auto_comment_enabled(
  '81818181-8181-8181-8181-818181818181', true
) then 1 else 0 end;

select candidate_id as comment_candidate_id
  from public.create_auto_comment_candidate(
    '86868686-8686-8686-8686-868686868686',
    '87878787-8787-8787-8787-878787878787',
    '82828282-8282-8282-8282-828282828282', '@lifecycle_source', '10',
    'ready now', array['ready'], '88888888-8888-8888-8888-888888888888',
    'comment', 'AUTO_SEND', '@lifecycle_discussion'
  ) \gset
select command_id as comment_command_id
  from public.claim_next_workflow_command(
    '82828282-8282-8282-8282-828282828282',
    '85858585-8585-8585-8585-858585858585', 1, 60
  ) \gset
select 1 / case when public.set_auto_comment_enabled('81818181-8181-8181-8181-818181818181', false) then 1 else 0 end;
select 1 / case when public.validate_auto_comment_execution(
  :'comment_command_id', '82828282-8282-8282-8282-828282828282',
  '85858585-8585-8585-8585-858585858585', 1
) = 'CANCELLED' then 1 else 0 end;
select 1 / case when (select status = 'REJECTED' from public.auto_comment_candidates where id = :'comment_candidate_id') then 1 else 0 end;

-- Disconnect/switch is terminal for already-created work; reconnect never
-- resurrects that stale job.
select 1 / case when public.set_auto_comment_enabled('81818181-8181-8181-8181-818181818181', true) then 1 else 0 end;
select candidate_id as disconnected_candidate_id
  from public.create_auto_comment_candidate(
    '86868686-8686-8686-8686-868686868686',
    '87878787-8787-8787-8787-878787878787',
    '82828282-8282-8282-8282-828282828282', '@lifecycle_source', '11',
    'ready again', array['ready'], '88888888-8888-8888-8888-888888888888',
    'comment', 'AUTO_SEND', '@lifecycle_discussion'
  ) \gset
update public.userbot_profiles
   set status = 'DISCONNECTED'
 where user_id = '81818181-8181-8181-8181-818181818181';
select 1 / case when (
  select status = 'REJECTED' and error_code = 'USERBOT_DISCONNECTED'
    from public.auto_comment_candidates where id = :'disconnected_candidate_id'
) then 1 else 0 end;
select 1 / case when (
  select cancel_requested_at is not null
    from public.broadcast_targets where id = :'independent_claimed_target_id'
) then 1 else 0 end;
update public.userbot_profiles
   set status = 'CONNECTED'
 where user_id = '81818181-8181-8181-8181-818181818181';
select 1 / case when (
  select status = 'REJECTED'
    from public.auto_comment_candidates where id = :'disconnected_candidate_id'
) then 1 else 0 end;

-- The Jasa Sebar switch is the lifecycle authority. ON creates one active
-- campaign, live config changes are synchronized, and OFF cancels all work.
select 1 / case when public.validate_broadcast_execution(
  :'independent_claimed_target_id', '82828282-8282-8282-8282-828282828282',
  '85858585-8585-8585-8585-858585858585', 1
) = 'CANCELLED' then 1 else 0 end;
select public.set_broadcast_service_enabled(
  '81818181-8181-8181-8181-818181818181', true, 'USERBOT',
  '83838383-8383-8383-8383-838383838383',
  array[
    '89898989-8989-8989-8989-898989898989',
    '91919191-9191-9191-9191-919191919191'
  ]::uuid[], 300
) as toggled_campaign_id \gset
select 1 / case when (
  select status = 'ACTIVE' from public.broadcast_campaigns where id = :'toggled_campaign_id'
) then 1 else 0 end;

insert into public.broadcast_lpm_targets (id, user_id, telegram_target_ref, active)
values (
  '92929292-9292-9292-9292-929292929292',
  '81818181-8181-8181-8181-818181818181', '@lifecycle_live_target', true
);
select 1 / case when (
  select '92929292-9292-9292-9292-929292929292'::uuid = any(target_ids)
    from public.broadcast_campaigns where id = :'toggled_campaign_id'
) then 1 else 0 end;

update public.broadcast_materials set text_content = 'promo changed'
 where id = '83838383-8383-8383-8383-838383838383';
select 1 / case when (
  select status = 'ACTIVE' and next_cycle_at <= now()
    from public.broadcast_campaigns where id = :'toggled_campaign_id'
) then 1 else 0 end;

select operation_id as toggled_cycle_operation_id
  from public.create_broadcast_campaign_cycle(:'toggled_campaign_id', now()) \gset
select 1 / case when public.set_broadcast_service_enabled(
  '81818181-8181-8181-8181-818181818181', false
) is null then 1 else 0 end;
select 1 / case when (
  select status = 'STOPPED' from public.broadcast_campaigns where id = :'toggled_campaign_id'
) then 1 else 0 end;
select 1 / case when (
  select status = 'CANCELLED' from public.workflow_operations where id = :'toggled_cycle_operation_id'
) then 1 else 0 end;

update public.auto_comment_channel_targets
   set active = false, deleted_at = now()
 where id = '86868686-8686-8686-8686-868686868686';
insert into public.auto_comment_channel_targets (
  id, user_id, account_id, source_channel_ref, active
) values (
  '90909090-9090-9090-9090-909090909090',
  '81818181-8181-8181-8181-818181818181',
  '82828282-8282-8282-8282-828282828282', '@lifecycle_source', true
);
select 1 / case when (
  select count(*) = 1 from public.auto_comment_channel_targets
   where profile_id = (
     select id from public.userbot_profiles
      where user_id = '81818181-8181-8181-8181-818181818181'
   ) and source_channel_ref = '@lifecycle_source' and deleted_at is null
) then 1 else 0 end;

rollback;
