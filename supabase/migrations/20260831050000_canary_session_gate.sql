-- Enforce canary admission inside the atomic Mini App identity/session exchange.

create or replace function public.issue_telegram_mini_app_session(
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

  if not exists (
    select 1
      from public.canary_admissions admission
     where admission.telegram_user_id = p_telegram_user_id
       and admission.revoked_at is null
       and admission.slot is not null
  ) then
    return query select 'ACCESS_DENIED'::text, null::uuid, null::uuid, null::timestamptz;
    return;
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

revoke all on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
) from public, anon, authenticated;
grant execute on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
) to service_role;

comment on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
)
  is 'Atomically enforces active canary admission, resolves verified Telegram identity, consumes initData, and creates an API session.';
