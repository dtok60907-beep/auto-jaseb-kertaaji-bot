-- Run after migrations V1 through V15. Proves both account types share the same fencing-safe lease primitive.

begin;

insert into auth.users (id) values ('15151515-1515-1515-1515-151515151515');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', null, 'JASEB_WORKER', 'Lease worker', decode('00', 'hex'), 1, 'READY'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa52', '15151515-1515-1515-1515-151515151515', 'USERBOT', 'Lease userbot', decode('00', 'hex'), 1, 'READY');

select 1 / case when (select result_status = 'ACQUIRED' and fencing_token = 1 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb51', 60
)) then 1 else 0 end;
select 1 / case when (select result_status = 'RENEWED' and fencing_token = 1 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb51', 60
)) then 1 else 0 end;
select 1 / case when (select result_status = 'HELD_BY_OTHER' from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'cccccccc-cccc-cccc-cccc-cccccccccc51', 60
)) then 1 else 0 end;

update public.account_leases set lease_until = now() - interval '1 second'
 where account_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51';
select 1 / case when (select result_status = 'TAKEN_OVER' and fencing_token = 2 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'cccccccc-cccc-cccc-cccc-cccccccccc51', 60
)) then 1 else 0 end;
select 1 / case when not exists (select 1 from public.renew_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb51', 1, 60
)) then 1 else 0 end;
select 1 / case when public.release_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'cccccccc-cccc-cccc-cccc-cccccccccc51', 2
) then 1 else 0 end;
select 1 / case when (select result_status = 'TAKEN_OVER' and fencing_token = 3 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa51', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb51', 60
)) then 1 else 0 end;

select 1 / case when (select result_status = 'ACQUIRED' and fencing_token = 1 from public.acquire_account_lease(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa52', 'dddddddd-dddd-dddd-dddd-dddddddddd51', 60
)) then 1 else 0 end;

rollback;
