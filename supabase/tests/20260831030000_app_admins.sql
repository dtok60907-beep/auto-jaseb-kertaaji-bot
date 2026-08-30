-- R1-003 fresh-schema proof: admin grants are revocable and backend-only.

begin;

insert into public.app_users (
  id, telegram_user_id, first_name, last_authenticated_at
)
values (
  '94949494-9494-4494-8494-949494949494',
  900000009,
  'Admin Proof',
  now()
);

insert into public.app_admins (user_id)
values ('94949494-9494-4494-8494-949494949494');

select 1 / case when exists (
  select 1
    from public.app_admins
   where user_id = '94949494-9494-4494-8494-949494949494'
     and revoked_at is null
) then 1 else 0 end;

update public.app_admins
   set revoked_at = now()
 where user_id = '94949494-9494-4494-8494-949494949494';

select 1 / case when not exists (
  select 1
    from public.app_admins
   where user_id = '94949494-9494-4494-8494-949494949494'
     and revoked_at is null
) then 1 else 0 end;

do $$
begin
  begin
    update public.app_admins
       set granted_at = now(), revoked_at = now() - interval '1 second'
     where user_id = '94949494-9494-4494-8494-949494949494';
    raise exception 'invalid revocation boundary was accepted';
  exception when check_violation then
    null;
  end;
end;
$$;

select 1 / case when
  not has_table_privilege('anon', 'public.app_admins', 'SELECT')
  and not has_table_privilege('anon', 'public.app_admins', 'INSERT')
  and not has_table_privilege('authenticated', 'public.app_admins', 'SELECT')
  and not has_table_privilege('authenticated', 'public.app_admins', 'UPDATE')
then 1 else 0 end;

rollback;
