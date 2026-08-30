-- Temporary production admission registry with an absolute 15-user active cap.

create table public.canary_admissions (
  telegram_user_id bigint primary key,
  slot smallint unique,
  admitted_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint canary_admissions_telegram_user_id_check check (
    telegram_user_id between 1 and 4503599627370495
  ),
  constraint canary_admissions_slot_check check (slot between 1 and 15),
  constraint canary_admissions_state_check check (
    (slot is not null and revoked_at is null)
    or (slot is null and revoked_at is not null)
  )
);

create function public.set_canary_admission(
  p_telegram_user_id bigint,
  p_enabled boolean
)
returns table (admission_status text, assigned_slot smallint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  available_slot smallint;
  previous_slot smallint;
begin
  if p_telegram_user_id not between 1 and 4503599627370495 or p_enabled is null then
    raise exception using errcode = '22023', message = 'INVALID_CANARY_ADMISSION_INPUT';
  end if;

  perform pg_advisory_xact_lock(907150000001);

  if p_enabled then
    select slot into available_slot
      from public.canary_admissions
     where telegram_user_id = p_telegram_user_id
       and revoked_at is null;
    if available_slot is not null then
      return query select 'ALREADY_ADMITTED'::text, available_slot;
      return;
    end if;

    select candidate::smallint into available_slot
      from generate_series(1, 15) candidate
     where not exists (
       select 1 from public.canary_admissions admission where admission.slot = candidate
     )
     order by candidate
     limit 1;
    if available_slot is null then
      return query select 'LIMIT_REACHED'::text, null::smallint;
      return;
    end if;

    insert into public.canary_admissions (
      telegram_user_id, slot, admitted_at, revoked_at
    ) values (
      p_telegram_user_id, available_slot, now(), null
    )
    on conflict (telegram_user_id) do update
      set slot = excluded.slot,
          admitted_at = excluded.admitted_at,
          revoked_at = null;
    return query select 'ADMITTED'::text, available_slot;
    return;
  end if;

  select slot into previous_slot
    from public.canary_admissions
   where telegram_user_id = p_telegram_user_id
     and revoked_at is null;
  if previous_slot is null then
    return query select 'NOT_ADMITTED'::text, null::smallint;
    return;
  end if;

  update public.canary_admissions
     set slot = null,
         revoked_at = now()
   where telegram_user_id = p_telegram_user_id
     and revoked_at is null;

  update public.api_sessions session
     set revoked_at = coalesce(session.revoked_at, now())
    from public.app_users app_user
   where session.user_id = app_user.id
     and app_user.telegram_user_id = p_telegram_user_id
     and session.revoked_at is null;

  return query select 'REVOKED'::text, previous_slot;
end;
$$;

alter table public.canary_admissions enable row level security;
revoke all on table public.canary_admissions from public, anon, authenticated, service_role;
revoke all on function public.set_canary_admission(bigint, boolean)
  from public, anon, authenticated;
grant select on table public.canary_admissions to service_role;
grant execute on function public.set_canary_admission(bigint, boolean) to service_role;

comment on table public.canary_admissions
  is 'Backend-only temporary canary registry. Unique slots 1..15 enforce the absolute active-user cap.';
comment on function public.set_canary_admission(bigint, boolean)
  is 'Serializes pre-login admission/revocation and revokes existing API sessions without deleting app user data.';
