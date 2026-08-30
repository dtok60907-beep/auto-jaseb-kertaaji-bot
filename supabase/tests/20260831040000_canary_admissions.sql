-- R2-001 fresh-schema proof: hard cap, slot reuse, session revoke, and isolation.

begin;

do $$
declare
  candidate bigint;
  status text;
  resolved_slot smallint;
begin
  for candidate in 900000101..900000115 loop
    select admission_status, assigned_slot into status, resolved_slot
      from public.set_canary_admission(candidate, true);
    if status <> 'ADMITTED' or resolved_slot is null then
      raise exception 'candidate % was not admitted', candidate;
    end if;
  end loop;

  select admission_status, assigned_slot into status, resolved_slot
    from public.set_canary_admission(900000116, true);
  if status <> 'LIMIT_REACHED' or resolved_slot is not null then
    raise exception 'sixteenth candidate bypassed the hard cap';
  end if;
end;
$$;

select 1 / case when
  (select count(*) from public.canary_admissions where revoked_at is null) = 15
  and (select count(distinct slot) from public.canary_admissions where revoked_at is null) = 15
then 1 else 0 end;

insert into public.app_users (
  id, telegram_user_id, first_name, last_authenticated_at
)
values (
  '98989898-9898-4898-8898-989898989898',
  900000101,
  'Canary Session Proof',
  now()
);

insert into public.api_sessions (
  user_id, token_hash, init_data_hash, expires_at
)
values (
  '98989898-9898-4898-8898-989898989898',
  decode(repeat('33', 32), 'hex'),
  decode(repeat('44', 32), 'hex'),
  now() + interval '1 hour'
);

select 1 / case when (
  select admission_status = 'REVOKED' and assigned_slot = 1
    from public.set_canary_admission(900000101, false)
) then 1 else 0 end;

select 1 / case when
  (select revoked_at is not null from public.api_sessions
    where user_id = '98989898-9898-4898-8898-989898989898')
  and (select count(*) from public.canary_admissions where revoked_at is null) = 14
then 1 else 0 end;

select 1 / case when (
  select admission_status = 'ADMITTED' and assigned_slot = 1
    from public.set_canary_admission(900000116, true)
) then 1 else 0 end;

select 1 / case when
  (select count(*) from public.canary_admissions where revoked_at is null) = 15
  and not has_table_privilege('anon', 'public.canary_admissions', 'SELECT')
  and not has_table_privilege('authenticated', 'public.canary_admissions', 'SELECT')
  and not has_function_privilege('anon', 'public.set_canary_admission(bigint,boolean)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.set_canary_admission(bigint,boolean)', 'EXECUTE')
then 1 else 0 end;

rollback;
