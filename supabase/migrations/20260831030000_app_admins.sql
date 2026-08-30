-- Backend-only admin grants for canonical Mini App users.

create table public.app_admins (
  user_id uuid primary key references public.app_users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint app_admins_revocation_check check (
    revoked_at is null or revoked_at >= granted_at
  )
);

alter table public.app_admins enable row level security;
revoke all on table public.app_admins from public, anon, authenticated;
grant select, insert, update, delete on table public.app_admins to service_role;

comment on table public.app_admins
  is 'Backend-only admin grants. Bootstrap and revocation are controlled deployment operations; no self-promotion API.';
