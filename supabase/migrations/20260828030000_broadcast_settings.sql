-- Persistent user settings for Jasa Sebar. Operational preparation and delivery
-- remain in broadcast_targets/workflow_commands and are intentionally separate.

create table public.broadcast_materials (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('TEXT', 'FORWARD')),
  text_content text,
  forward_channel_username text,
  forward_message_id integer,
  source_attribution text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (
      kind = 'TEXT'
      and char_length(btrim(coalesce(text_content, ''))) between 1 and 4096
      and forward_channel_username is null
      and forward_message_id is null
      and source_attribution is null
    )
    or (
      kind = 'FORWARD'
      and text_content is null
      and forward_channel_username ~ '^[A-Za-z][A-Za-z0-9_]{4,31}$'
      and forward_message_id > 0
      and source_attribution in ('SHOW_SOURCE', 'HIDE_SOURCE')
    )
  )
);

create index broadcast_materials_user_active_idx
  on public.broadcast_materials (user_id, created_at desc)
  where active;

create table public.broadcast_lpm_targets (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  telegram_target_ref text not null check (char_length(btrim(telegram_target_ref)) between 1 and 256),
  label text check (label is null or char_length(btrim(label)) between 1 and 80),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index broadcast_lpm_targets_user_ref_unique_idx
  on public.broadcast_lpm_targets (user_id, lower(btrim(telegram_target_ref)));
create index broadcast_lpm_targets_user_active_idx
  on public.broadcast_lpm_targets (user_id, created_at desc)
  where active;

create trigger broadcast_materials_set_updated_at
before update on public.broadcast_materials
for each row execute function public.set_updated_at();

create trigger broadcast_lpm_targets_set_updated_at
before update on public.broadcast_lpm_targets
for each row execute function public.set_updated_at();

alter table public.broadcast_materials enable row level security;
alter table public.broadcast_lpm_targets enable row level security;

create policy broadcast_materials_owner_read on public.broadcast_materials
  for select to authenticated using (user_id = auth.uid());
create policy broadcast_lpm_targets_owner_read on public.broadcast_lpm_targets
  for select to authenticated using (user_id = auth.uid());

comment on table public.broadcast_materials is 'User-owned TEXT/FORWARD settings. Each future outbox command snapshots one material.';
comment on table public.broadcast_lpm_targets is 'User-owned Grup LPM settings. Account-specific preparation occurs per broadcast operation, not here.';
comment on column public.broadcast_materials.source_attribution is 'SHOW_SOURCE asks Telegram to show forward origin; HIDE_SOURCE asks Telegram to hide it.';
