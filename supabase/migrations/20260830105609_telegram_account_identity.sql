-- A Telegram identity may only back one runtime account. The provider id is
-- nullable for legacy fixtures, but every production provisioning path writes it.

alter table public.telegram_accounts
  add column provider_user_id bigint
    check (provider_user_id is null or provider_user_id > 0);

create unique index telegram_accounts_provider_user_unique_idx
  on public.telegram_accounts (provider_user_id)
  where provider_user_id is not null;

comment on column public.telegram_accounts.provider_user_id
  is 'Stable Telegram user id verified from the authorized session; never inferred from user input.';
