-- Short-lived backend API sessions issued from verified Telegram Mini App data.
-- Raw bearer tokens and raw initData are never persisted.

create table public.api_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash bytea not null unique,
  init_data_hash bytea not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint api_sessions_token_hash_check check (octet_length(token_hash) = 32),
  constraint api_sessions_init_data_hash_check check (octet_length(init_data_hash) = 32),
  constraint api_sessions_expiry_check check (expires_at > created_at),
  constraint api_sessions_revocation_check check (
    revoked_at is null or revoked_at >= created_at
  )
);

create index api_sessions_active_user_idx
  on public.api_sessions (user_id, expires_at desc)
  where revoked_at is null;
create index api_sessions_expiry_idx on public.api_sessions (expires_at);

create function public.issue_telegram_mini_app_session(
  p_telegram_user_id bigint,
  p_first_name text,
  p_last_name text,
  p_username text,
  p_language_code text,
  p_is_premium boolean,
  p_allows_write_to_pm boolean,
  p_authenticated_at timestamptz,
  p_token_hash bytea,
  p_init_data_hash bytea,
  p_expires_at timestamptz
)
returns table (
  result_status text,
  resolved_user_id uuid,
  created_session_id uuid,
  session_expires_at timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  application_user_id uuid;
  session_id uuid;
begin
  if octet_length(p_token_hash) <> 32 or octet_length(p_init_data_hash) <> 32 then
    raise exception using errcode = '22023', message = 'INVALID_API_SESSION_HASH';
  end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '7 days' then
    raise exception using errcode = '22023', message = 'INVALID_API_SESSION_EXPIRY';
  end if;

  select public.upsert_telegram_mini_app_user(
    p_telegram_user_id,
    p_first_name,
    p_last_name,
    p_username,
    p_language_code,
    p_is_premium,
    p_allows_write_to_pm,
    p_authenticated_at
  ) into application_user_id;

  insert into public.api_sessions (
    user_id,
    token_hash,
    init_data_hash,
    expires_at
  )
  values (
    application_user_id,
    p_token_hash,
    p_init_data_hash,
    p_expires_at
  )
  on conflict (init_data_hash) do nothing
  returning id into session_id;

  if session_id is null then
    return query select 'REPLAY'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;

  return query select 'CREATED'::text, application_user_id, session_id, p_expires_at;
end;
$$;

alter table public.api_sessions enable row level security;
revoke all on table public.api_sessions from public, anon, authenticated;
revoke all on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
) from public, anon, authenticated;
grant select, insert, update, delete on table public.api_sessions to service_role;
grant execute on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
) to service_role;

comment on table public.api_sessions
  is 'Backend-only bearer sessions; contains SHA-256 hashes, never raw access tokens or Telegram initData.';
comment on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
)
  is 'Atomically resolves a verified Telegram identity, consumes one initData hash, and creates one API session.';
