begin;

do $$
declare
  buyer_id uuid;
  session_result record;
  package_id uuid;
  first_order record;
  first_fulfillment record;
  repeated_order record;
  repeated_fulfillment record;
  second_order record;
  second_fulfillment record;
  first_expiry timestamptz;
begin
  -- A never-admitted Telegram identity can now enter the production storefront.
  select * into session_result from public.issue_telegram_mini_app_session(
    900013001, 'Public Buyer', null, 'public_buyer', 'id', false, false,
    now(), decode(repeat('91', 32), 'hex'), decode(repeat('92', 32), 'hex'),
    now() + interval '12 hours'
  );
  if session_result.result_status <> 'CREATED' then
    raise exception 'public buyer session was not created';
  end if;
  buyer_id := session_result.resolved_user_id;

  select public.create_package_with_version(
    'pakasir-userbot',
    jsonb_build_object(
      'name', 'Userbot 30 Hari', 'packageType', 'USERBOT', 'priceIdr', 99000,
      'durationDays', 30, 'features', jsonb_build_array('JASEB', 'AUTO_COMMENT_MF'),
      'maxTargetsPerMinute', 5, 'maxAccounts', 1,
      'intervalMinSeconds', 300, 'intervalMaxSeconds', 86400,
      'displayOrder', 0, 'active', true
    )
  ) into package_id;

  select * into first_order from public.create_payment_order(
    buyer_id, package_id, 'auto-promosi-kertaaji', 'KRT-TEST-00000001'
  );
  if first_order.amount_idr <> 99000 or first_order.order_status <> 'PENDING'
     or first_order.package_type <> 'USERBOT' then
    raise exception 'payment order did not snapshot the package';
  end if;
  select * into repeated_order from public.create_payment_order(
    buyer_id, package_id, 'auto-promosi-kertaaji', 'KRT-TEST-IGNORED01'
  );
  if repeated_order.order_id <> first_order.order_id then
    raise exception 'repeated checkout created a duplicate pending order';
  end if;

  select * into first_fulfillment from public.fulfill_payment_order(
    first_order.order_id, 'qris', now()
  );
  if first_fulfillment.result_status <> 'FULFILLED'
     or first_fulfillment.fulfilled_entitlement_id is null then
    raise exception 'payment was not fulfilled';
  end if;
  first_expiry := first_fulfillment.entitlement_expires_at;
  if not exists (
    select 1 from public.entitlements
     where id = first_fulfillment.fulfilled_entitlement_id
       and user_id = buyer_id and status = 'ACTIVE'
       and max_lpm_groups = 5 and max_channel_targets = 5
  ) then
    raise exception 'fulfilled entitlement has wrong access limits';
  end if;

  select * into repeated_fulfillment from public.fulfill_payment_order(
    first_order.order_id, 'qris', now()
  );
  if repeated_fulfillment.result_status <> 'ALREADY_PAID'
     or repeated_fulfillment.fulfilled_entitlement_id <> first_fulfillment.fulfilled_entitlement_id then
    raise exception 'duplicate webhook was not idempotent';
  end if;

  select * into second_order from public.create_payment_order(
    buyer_id, package_id, 'auto-promosi-kertaaji', 'KRT-TEST-00000002'
  );
  select * into second_fulfillment from public.fulfill_payment_order(
    second_order.order_id, 'bri_va', now()
  );
  if second_fulfillment.entitlement_expires_at < first_expiry + interval '29 days 23 hours' then
    raise exception 'renewal did not preserve remaining subscription time';
  end if;
  if (select count(*) from public.entitlements where user_id = buyer_id and status = 'ACTIVE' and package_snapshot->>'packageType' = 'USERBOT') <> 1 then
    raise exception 'renewal left multiple active entitlements of the same type';
  end if;
end;
$$;

select 1 / case when
  not has_table_privilege('anon', 'public.payment_orders', 'SELECT')
  and not has_table_privilege('authenticated', 'public.payment_orders', 'SELECT')
  and has_function_privilege('service_role', 'public.create_payment_order(uuid,uuid,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.fulfill_payment_order(uuid,text,timestamptz)', 'EXECUTE')
then 1 else 0 end;

rollback;
