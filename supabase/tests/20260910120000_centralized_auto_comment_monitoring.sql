begin;

insert into auth.users (id) values ('71000000-0000-4000-8000-000000000001');
insert into public.app_users (id, telegram_user_id, first_name, last_authenticated_at)
values ('71000000-0000-4000-8000-000000000001', 710001, 'Monitor admin', now());

insert into public.telegram_accounts (
  id, account_type, label, encrypted_session, encryption_key_version,
  provider_user_id, status, monitor_active
) values (
  '71000000-0000-4000-8000-000000000002', 'MONITOR', 'Central monitor',
  decode('00', 'hex'), 1, 710002, 'READY', true
);

select 1 / case when (
  select account_type = 'MONITOR' and monitor_active
    from public.telegram_accounts
   where id = '71000000-0000-4000-8000-000000000002'
) then 1 else 0 end;

select 1 / case when (
  select result_status = 'CREATED'
    from public.begin_telegram_account_auth_flow(
      '71000000-0000-4000-8000-000000000001', 'MONITOR', 600
    )
) then 1 else 0 end;

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session,
  encryption_key_version, provider_user_id, status
) values (
  '71000000-0000-4000-8000-000000000003',
  '71000000-0000-4000-8000-000000000001', 'USERBOT', 'Buyer userbot',
  decode('00', 'hex'), 1, 710003, 'READY'
);

insert into public.entitlements (
  user_id, package_snapshot, status, starts_at, expires_at,
  max_lpm_groups, max_channel_targets
) values (
  '71000000-0000-4000-8000-000000000001',
  '{"packageId":"central-monitor-test","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 1, 2
);

insert into public.userbot_profiles (user_id, active_account_id, status)
values (
  '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000003', 'CONNECTED'
);

insert into public.auto_comment_divisions (
  id, user_id, account_id, name, mode
) values (
  '71000000-0000-4000-8000-000000000004',
  '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000003', 'Desain', 'AUTO_SEND'
);
insert into public.auto_comment_division_keywords (division_id, keyword)
values ('71000000-0000-4000-8000-000000000004', 'butuh desain');
insert into public.auto_comment_division_templates (division_id, text_content)
values ('71000000-0000-4000-8000-000000000004', 'Kami siap membantu');

insert into public.auto_comment_channel_targets (
  id, user_id, account_id, source_channel_ref,
  discussion_target_ref, resolution_status
) values (
  '71000000-0000-4000-8000-000000000005',
  '71000000-0000-4000-8000-000000000001',
  '71000000-0000-4000-8000-000000000003', '@menfess_shared',
  '@menfess_shared_chat', 'READY'
);
insert into public.auto_comment_division_channels (division_id, channel_target_id)
values (
  '71000000-0000-4000-8000-000000000004',
  '71000000-0000-4000-8000-000000000005'
);

select 1 / case when (
  select count(*) = 1
    from public.auto_comment_monitor_sources source
    join public.auto_comment_channel_targets target on target.monitor_source_id = source.id
   where target.id = '71000000-0000-4000-8000-000000000005'
     and source.normalized_ref = '@menfess_shared'
) then 1 else 0 end;

-- The legacy per-userbot polling claim is permanently non-due.
select 1 / case when not exists (
  select 1
    from public.auto_comment_runtime_eligible_targets
   where channel_target_id = '71000000-0000-4000-8000-000000000005'
     and monitoring_available_at is not null
) then 1 else 0 end;

-- The centralized inbox is idempotent for one Telegram source/message pair.
with source as (
  select monitor_source_id id from public.auto_comment_channel_targets
   where id = '71000000-0000-4000-8000-000000000005'
)
insert into public.auto_comment_monitor_events (source_id, provider_post_id, content)
select id, 42, 'butuh desain logo' from source
on conflict (source_id, provider_post_id) do nothing;
with source as (
  select monitor_source_id id from public.auto_comment_channel_targets
   where id = '71000000-0000-4000-8000-000000000005'
)
insert into public.auto_comment_monitor_events (source_id, provider_post_id, content)
select id, 42, 'duplikat' from source
on conflict (source_id, provider_post_id) do nothing;
select 1 / case when (
  select count(*) = 1 from public.auto_comment_monitor_events where provider_post_id = 42
) then 1 else 0 end;

select 1 / case when not has_table_privilege(
  'authenticated', 'public.auto_comment_monitor_events', 'select'
) then 1 else 0 end;

rollback;
