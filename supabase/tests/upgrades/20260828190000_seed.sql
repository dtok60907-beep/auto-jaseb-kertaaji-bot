-- Apply after V1-V19 and before V20 to rehearse legacy worker-assignment repair.

insert into auth.users (id) values ('26262626-2626-2626-2626-262626262626');
insert into public.telegram_accounts (id, owner_user_id, account_type, label, encrypted_session, encryption_key_version, status)
values
  ('27272727-2727-2727-2727-272727272721', null, 'JASEB_WORKER', 'Legacy worker one', decode('00', 'hex'), 1, 'READY'),
  ('27272727-2727-2727-2727-272727272722', null, 'JASEB_WORKER', 'Legacy worker two', decode('00', 'hex'), 1, 'READY');
insert into public.workflow_operations (id, user_id, account_id, operation_type, status, idempotency_key, payload)
values
  ('28282828-2828-2828-2828-282828282821', '26262626-2626-2626-2626-262626262626', '27272727-2727-2727-2727-272727272721', 'BROADCAST', 'QUEUED', 'legacy-worker-operation-0001', '{}'),
  ('28282828-2828-2828-2828-282828282822', '26262626-2626-2626-2626-262626262626', '27272727-2727-2727-2727-272727272722', 'BROADCAST', 'QUEUED', 'legacy-worker-operation-0002', '{}');
insert into public.worker_assignments (id, operation_id, worker_account_id, status)
values
  ('29292929-2929-2929-2929-292929292921', '28282828-2828-2828-2828-282828282821', '27272727-2727-2727-2727-272727272721', 'RESERVED'),
  ('29292929-2929-2929-2929-292929292922', '28282828-2828-2828-2828-282828282822', '27272727-2727-2727-2727-272727272722', 'RESERVED');
