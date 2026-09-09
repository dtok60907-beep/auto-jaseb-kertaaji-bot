-- Public buyer onboarding and durable, exactly-once Pakasir fulfillment.

create table public.payment_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  package_id uuid references public.package_catalog(id) on delete set null,
  package_version_id uuid references public.package_versions(id) on delete restrict,
  package_snapshot jsonb not null check (
    jsonb_typeof(package_snapshot) = 'object'
    and package_snapshot ?& array[
      'packageId', 'name', 'packageType', 'priceIdr', 'durationDays',
      'features', 'maxTargetsPerMinute', 'intervalMinSeconds', 'intervalMaxSeconds'
    ]
  ),
  project_slug text not null check (project_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  provider_order_id text not null check (provider_order_id ~ '^[A-Z0-9-]{12,64}$'),
  amount_idr bigint not null check (amount_idr > 0),
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID')),
  payment_method text,
  provider_completed_at timestamptz,
  paid_at timestamptz,
  entitlement_id uuid references public.entitlements(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_slug, provider_order_id),
  check (
    (status = 'PENDING' and paid_at is null and entitlement_id is null)
    or
    (status = 'PAID' and paid_at is not null and entitlement_id is not null)
  )
);

create index payment_orders_user_created_idx
  on public.payment_orders (user_id, created_at desc);
create index payment_orders_pending_idx
  on public.payment_orders (status, created_at)
  where status = 'PENDING';
create unique index payment_orders_one_pending_package_idx
  on public.payment_orders (user_id, package_id)
  where status = 'PENDING';

create trigger payment_orders_set_updated_at
before update on public.payment_orders
for each row execute function public.set_updated_at();

alter table public.payment_orders enable row level security;
revoke all on table public.payment_orders from public, anon, authenticated, service_role;
grant select, insert, update on table public.payment_orders to service_role;

create function public.create_payment_order(
  p_user_id uuid,
  p_package_id uuid,
  p_project_slug text,
  p_provider_order_id text
)
returns table (
  order_id uuid,
  order_code text,
  package_id uuid,
  package_name text,
  package_type text,
  amount_idr bigint,
  order_status text,
  created_at timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  package_row record;
  created_order public.payment_orders%rowtype;
begin
  if p_project_slug !~ '^[a-z0-9][a-z0-9-]{1,62}$'
     or p_provider_order_id !~ '^[A-Z0-9-]{12,64}$' then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_ORDER';
  end if;
  perform 1 from public.app_users where id = p_user_id for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'APP_USER_NOT_FOUND';
  end if;

  select catalog.id, catalog.current_version_id, catalog.price_idr,
         catalog.name, catalog.package_type, version.snapshot
    into package_row
    from public.package_catalog catalog
    join public.package_versions version on version.id = catalog.current_version_id
   where catalog.id = p_package_id and catalog.active
   for share of catalog, version;
  if not found then
    raise exception using errcode = 'P0002', message = 'PACKAGE_NOT_FOUND';
  end if;
  if package_row.price_idr <= 0 then
    raise exception using errcode = 'P0001', message = 'PACKAGE_NOT_PURCHASABLE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_package_id::text, 1900));
  select pending_order.* into created_order
    from public.payment_orders pending_order
   where pending_order.user_id = p_user_id
     and pending_order.package_id = p_package_id
     and pending_order.status = 'PENDING'
   for update;
  if found then
    return query select created_order.id, created_order.provider_order_id,
      package_row.id, package_row.name, package_row.package_type,
      created_order.amount_idr, created_order.status, created_order.created_at;
    return;
  end if;

  insert into public.payment_orders (
    user_id, package_id, package_version_id, package_snapshot,
    project_slug, provider_order_id, amount_idr
  ) values (
    p_user_id, package_row.id, package_row.current_version_id,
    package_row.snapshot, p_project_slug, p_provider_order_id, package_row.price_idr
  ) returning * into created_order;

  return query select created_order.id, created_order.provider_order_id,
    package_row.id, package_row.name, package_row.package_type,
    created_order.amount_idr, created_order.status, created_order.created_at;
end;
$$;

create function public.fulfill_payment_order(
  p_order_id uuid,
  p_payment_method text,
  p_provider_completed_at timestamptz
)
returns table (
  result_status text,
  fulfilled_entitlement_id uuid,
  entitlement_expires_at timestamptz
)
language plpgsql
set search_path = public
as $$
declare
  order_row public.payment_orders%rowtype;
  account_mode text;
  duration_days integer;
  max_targets integer;
  preserved_expiry timestamptz;
  new_expiry timestamptz;
  new_entitlement_id uuid;
begin
  select * into order_row from public.payment_orders
   where id = p_order_id for update;
  if not found then
    return query select 'NOT_FOUND'::text, null::uuid, null::timestamptz;
    return;
  end if;
  if order_row.status = 'PAID' then
    return query select 'ALREADY_PAID'::text, order_row.entitlement_id,
      (select expires_at from public.entitlements where id = order_row.entitlement_id);
    return;
  end if;
  if coalesce(btrim(p_payment_method), '') = ''
     or p_provider_completed_at is null
     or p_provider_completed_at > now() + interval '10 minutes' then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_COMPLETION';
  end if;

  account_mode := order_row.package_snapshot->>'packageType';
  duration_days := (order_row.package_snapshot->>'durationDays')::integer;
  max_targets := (order_row.package_snapshot->>'maxTargetsPerMinute')::integer;
  if account_mode not in ('JASEB_WORKER', 'USERBOT')
     or duration_days <= 0 or max_targets <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_PAYMENT_PACKAGE_SNAPSHOT';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(order_row.user_id::text || ':' || account_mode, 1901));
  select max(expires_at) into preserved_expiry
    from public.entitlements
   where user_id = order_row.user_id and status = 'ACTIVE'
     and expires_at > now()
     and package_snapshot->>'packageType' = account_mode;
  new_expiry := greatest(coalesce(preserved_expiry, now()), now())
    + make_interval(days => duration_days);

  update public.entitlements set status = 'REVOKED', updated_at = now()
   where user_id = order_row.user_id and status = 'ACTIVE'
     and package_snapshot->>'packageType' = account_mode;

  insert into public.entitlements (
    user_id, package_id, package_version_id, package_snapshot,
    status, starts_at, expires_at, max_lpm_groups, max_channel_targets
  ) values (
    order_row.user_id, order_row.package_id, order_row.package_version_id,
    order_row.package_snapshot || jsonb_build_object(
      'maxLpmGroups', max_targets,
      'maxChannelTargets', case when account_mode = 'USERBOT' then max_targets else 0 end
    ),
    'ACTIVE', now(), new_expiry, max_targets,
    case when account_mode = 'USERBOT' then max_targets else 0 end
  ) returning id into new_entitlement_id;

  update public.payment_orders
     set status = 'PAID', payment_method = left(btrim(p_payment_method), 80),
         provider_completed_at = p_provider_completed_at,
         paid_at = now(), entitlement_id = new_entitlement_id
   where id = order_row.id;

  return query select 'FULFILLED'::text, new_entitlement_id, new_expiry;
end;
$$;

revoke all on function public.create_payment_order(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fulfill_payment_order(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_payment_order(uuid, uuid, text, text) to service_role;
grant execute on function public.fulfill_payment_order(uuid, text, timestamptz) to service_role;

-- The paid storefront is public to any Telegram-authenticated user. Feature
-- access remains guarded by entitlements, so canary admission is no longer an
-- authentication prerequisite.
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

  select public.upsert_telegram_mini_app_user(
    p_telegram_user_id, p_first_name, p_last_name, p_username,
    p_language_code, p_is_premium, p_allows_write_to_pm, p_authenticated_at
  ) into application_user_id;

  insert into public.api_sessions (user_id, token_hash, init_data_hash, expires_at)
  values (application_user_id, p_token_hash, p_init_data_hash, p_expires_at)
  on conflict (init_data_hash) do nothing
  returning id into session_id;
  if session_id is null then
    return query select 'REPLAY'::text, null::uuid, null::uuid, null::timestamptz;
    return;
  end if;
  return query select 'CREATED'::text, application_user_id, session_id, p_expires_at;
end;
$$;

comment on table public.payment_orders
  is 'Immutable package purchase intents and exactly-once Pakasir fulfillment receipts.';
comment on function public.fulfill_payment_order(uuid, text, timestamptz)
  is 'Atomically fulfills one verified Pakasir payment and preserves remaining subscription time of the same account mode.';
comment on function public.issue_telegram_mini_app_session(
  bigint, text, text, text, text, boolean, boolean, timestamptz, bytea, bytea, timestamptz
)
  is 'Atomically resolves any verified Telegram identity, consumes initData, and creates a buyer storefront API session.';
