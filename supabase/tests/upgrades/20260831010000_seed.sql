-- Apply every migration before 20260831010000, then seed this legacy fixture.

insert into auth.users (id)
values ('91919191-9191-4191-8191-919191919191');

insert into public.entitlements (
  id,
  user_id,
  package_snapshot,
  status,
  starts_at,
  expires_at,
  max_lpm_groups,
  max_channel_targets
)
values (
  '92929292-9292-4292-8292-929292929292',
  '91919191-9191-4191-8191-919191919191',
  '{"packageId":"legacy","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":3600}',
  'ACTIVE',
  now() - interval '1 minute',
  now() + interval '1 day',
  10,
  10
);
