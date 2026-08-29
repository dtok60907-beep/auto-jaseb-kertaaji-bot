-- Jasa Sebar worker interval is controlled per worker account by admin.
-- Zero is valid because the product does not impose an artificial delay.

create table public.worker_account_settings (
  worker_account_id uuid primary key references public.telegram_accounts(id) on delete cascade,
  interval_seconds integer not null check (interval_seconds >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.validate_worker_account_setting()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_type_value text;
begin
  select account_type into account_type_value
    from public.telegram_accounts
   where id = new.worker_account_id;
  if account_type_value is distinct from 'JASEB_WORKER' then
    raise exception using errcode = '42501', message = 'worker setting requires a JASEB_WORKER account';
  end if;
  return new;
end;
$$;

create trigger worker_account_settings_validate_account
before insert or update of worker_account_id on public.worker_account_settings
for each row execute function public.validate_worker_account_setting();

create trigger worker_account_settings_set_updated_at
before update on public.worker_account_settings
for each row execute function public.set_updated_at();

alter table public.worker_account_settings enable row level security;

revoke all on table public.worker_account_settings from public;
