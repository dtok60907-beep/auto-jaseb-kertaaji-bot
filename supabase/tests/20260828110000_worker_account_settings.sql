-- Run after migrations V1 through V12. Verifies only JASEB_WORKER can receive settings.

begin;

insert into auth.users (id) values ('11111111-1111-1111-1111-111111111111');

insert into public.telegram_accounts (
  id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status
)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7', null, 'JASEB_WORKER', 'Worker fixture', decode('00', 'hex'), 1, 'READY'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8', '11111111-1111-1111-1111-111111111111', 'USERBOT', 'Userbot fixture', decode('00', 'hex'), 1, 'READY');

insert into public.worker_account_settings (worker_account_id, interval_seconds, active)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7', 0, true);

update public.worker_account_settings
   set interval_seconds = 300, active = false
 where worker_account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7';

select 1 / case when (
  select interval_seconds = 300 and active = false
    from public.worker_account_settings
   where worker_account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7'
) then 1 else 0 end;

do $$
begin
  begin
    insert into public.worker_account_settings (worker_account_id, interval_seconds)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa8', 60);
    raise exception 'userbot was accepted as worker';
  exception when insufficient_privilege then
    if sqlerrm <> 'worker setting requires a JASEB_WORKER account' then raise; end if;
  end;
end;
$$;

rollback;
