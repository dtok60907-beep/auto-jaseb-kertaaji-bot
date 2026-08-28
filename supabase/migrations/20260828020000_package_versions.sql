-- Immutable package versions. The catalog remains a fast current-version projection.

create table public.package_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  package_id uuid not null references public.package_catalog(id) on delete restrict,
  version integer not null check (version > 0),
  snapshot jsonb not null
    check (jsonb_typeof(snapshot) = 'object')
    check (snapshot ?& array[
      'code', 'name', 'packageType', 'priceIdr', 'durationDays', 'features',
      'maxTargetsPerMinute', 'maxAccounts', 'intervalMinSeconds',
      'intervalMaxSeconds', 'displayOrder', 'active'
    ]),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (package_id, version)
);

alter table public.package_catalog
  add column current_version_id uuid references public.package_versions(id) on delete restrict;
alter table public.entitlements
  add column package_version_id uuid references public.package_versions(id) on delete restrict;

create index package_versions_package_created_idx
  on public.package_versions (package_id, version desc);
create index entitlements_package_version_idx
  on public.entitlements (package_version_id);

create or replace function public.validate_current_package_version()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  version_package_id uuid;
begin
  if new.current_version_id is null then
    return new;
  end if;
  select package_id into version_package_id from public.package_versions where id = new.current_version_id;
  if version_package_id is distinct from new.id then
    raise exception using errcode = '23514', message = 'catalog current version belongs to another package';
  end if;
  return new;
end;
$$;

create trigger package_catalog_validate_current_version
before insert or update of current_version_id on public.package_catalog
for each row execute function public.validate_current_package_version();

create or replace function public.validate_entitlement_package_version()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  version_package_id uuid;
begin
  if new.package_version_id is null then
    return new;
  end if;
  select package_id into version_package_id from public.package_versions where id = new.package_version_id;
  if version_package_id is distinct from new.package_id then
    raise exception using errcode = '23514', message = 'entitlement package version belongs to another package';
  end if;
  return new;
end;
$$;

create trigger entitlements_validate_package_version
before insert or update of package_id, package_version_id on public.entitlements
for each row execute function public.validate_entitlement_package_version();

create or replace function public.publish_package_version(
  p_package_id uuid,
  p_config jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  next_version integer;
  version_id uuid;
  package_code text;
  features_value text[];
begin
  if jsonb_typeof(p_config) <> 'object'
     or not (p_config ?& array[
       'name', 'packageType', 'priceIdr', 'durationDays', 'features',
       'maxTargetsPerMinute', 'maxAccounts', 'intervalMinSeconds',
       'intervalMaxSeconds', 'displayOrder', 'active'
     ])
     or jsonb_typeof(p_config->'features') <> 'array' then
    raise exception using errcode = '22023', message = 'invalid package version config';
  end if;

  select code into package_code from public.package_catalog where id = p_package_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package not found';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
    from public.package_versions
   where package_id = p_package_id;
  select coalesce(array_agg(value), '{}'::text[]) into features_value
    from jsonb_array_elements_text(p_config->'features');

  insert into public.package_versions (package_id, version, snapshot, created_by)
  values (
    p_package_id,
    next_version,
    p_config || jsonb_build_object('code', package_code),
    p_actor_id
  )
  returning id into version_id;

  update public.package_catalog
     set name = p_config->>'name',
         package_type = p_config->>'packageType',
         price_idr = (p_config->>'priceIdr')::bigint,
         duration_days = (p_config->>'durationDays')::integer,
         features = features_value,
         max_targets_per_minute = (p_config->>'maxTargetsPerMinute')::integer,
         max_accounts = (p_config->>'maxAccounts')::integer,
         interval_min_seconds = (p_config->>'intervalMinSeconds')::integer,
         interval_max_seconds = (p_config->>'intervalMaxSeconds')::integer,
         display_order = (p_config->>'displayOrder')::integer,
         active = (p_config->>'active')::boolean,
         current_version_id = version_id
   where id = p_package_id;

  return version_id;
end;
$$;

create or replace function public.create_package_with_version(
  p_code text,
  p_config jsonb,
  p_actor_id uuid default null
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  package_id uuid;
  version_id uuid;
begin
  insert into public.package_catalog (
    code, name, package_type, price_idr, duration_days, features,
    max_targets_per_minute, max_accounts, interval_min_seconds,
    interval_max_seconds, display_order, active, created_by
  )
  values (
    p_code,
    p_config->>'name',
    p_config->>'packageType',
    (p_config->>'priceIdr')::bigint,
    (p_config->>'durationDays')::integer,
    (select coalesce(array_agg(value), '{}'::text[]) from jsonb_array_elements_text(p_config->'features')),
    (p_config->>'maxTargetsPerMinute')::integer,
    (p_config->>'maxAccounts')::integer,
    (p_config->>'intervalMinSeconds')::integer,
    (p_config->>'intervalMaxSeconds')::integer,
    (p_config->>'displayOrder')::integer,
    (p_config->>'active')::boolean,
    p_actor_id
  )
  returning id into package_id;

  version_id := public.publish_package_version(package_id, p_config, p_actor_id);
  return package_id;
end;
$$;

alter table public.package_versions enable row level security;

comment on function public.publish_package_version(uuid, jsonb, uuid) is 'Creates an immutable version and atomically updates the catalog projection.';
