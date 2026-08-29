-- The Userbot Jasa Sebar interval belongs to the profile, never to the currently
-- connected Telegram account. A switch or reconnect therefore keeps the user's
-- Jasa Sebar behavior. Auto Komen intentionally has no configured interval.

alter table public.userbot_profiles
  add column broadcast_interval_seconds integer not null default 0
  check (broadcast_interval_seconds >= 0);

comment on column public.userbot_profiles.broadcast_interval_seconds is
  'User-selected minimum interval between Jasa Sebar sends for the active Userbot profile; zero is valid. Auto Komen is not delayed by this value.';
