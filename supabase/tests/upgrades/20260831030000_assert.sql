select 1 / case when exists (
  select 1
    from public.app_users
   where id = '95959595-9595-4595-8595-959595959595'
     and telegram_user_id = 900000010
) then 1 else 0 end;

select 1 / case when to_regclass('public.app_admins') is not null then 1 else 0 end;

insert into public.app_admins (user_id)
values ('95959595-9595-4595-8595-959595959595');

select 1 / case when exists (
  select 1
    from public.app_admins
   where user_id = '95959595-9595-4595-8595-959595959595'
     and revoked_at is null
) then 1 else 0 end;
