-- R3-001 advisor follow-up: cover the completed-account foreign key without
-- widening the active-flow or expiry indexes.

create index telegram_account_auth_flows_completed_account_idx
  on public.telegram_account_auth_flows (completed_account_id)
  where completed_account_id is not null;
