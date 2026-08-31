-- Keep immutable package snapshots compatible with the entitlement snapshot contract.

update public.package_versions
   set snapshot = snapshot || jsonb_build_object('packageId', package_id)
 where snapshot->>'packageId' is distinct from package_id::text;

alter table public.package_versions
  add constraint package_versions_snapshot_package_id_check
  check (snapshot->>'packageId' = package_id::text);

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
    p_config || jsonb_build_object('code', package_code, 'packageId', p_package_id),
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

create or replace function public.grant_entitlement(
  p_user_id uuid,
  p_package_id uuid,
  p_duration_days integer,
  p_max_lpm_groups integer,
  p_max_channel_targets integer default 0
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  package_row record;
  entitlement_id uuid;
  expires timestamptz;
begin
  if p_duration_days <= 0 or p_max_lpm_groups < 0 or p_max_channel_targets < 0 then
    raise exception using errcode = '22023', message = 'entitlement limits must be non-negative and duration positive';
  end if;

  select c.id, c.package_type, c.features, c.current_version_id, v.snapshot
    into package_row
    from public.package_catalog c
    join public.package_versions v on v.id = c.current_version_id
   where c.id = p_package_id and c.active
   for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'active package not found';
  end if;

  if package_row.package_type = 'JASEB_WORKER' and p_max_channel_targets <> 0 then
    raise exception using errcode = '22023', message = 'worker package cannot configure auto-comment channels';
  end if;
  expires := now() + make_interval(days => p_duration_days);

  update public.entitlements
     set status = 'REVOKED', updated_at = now()
   where user_id = p_user_id
     and status = 'ACTIVE'
     and package_snapshot->>'packageType' = package_row.package_type;

  insert into public.entitlements (
    user_id, package_id, package_version_id, package_snapshot,
    status, starts_at, expires_at, max_lpm_groups, max_channel_targets
  )
  values (
    p_user_id, p_package_id, package_row.current_version_id,
    package_row.snapshot || jsonb_build_object(
      'packageId', p_package_id,
      'maxLpmGroups', p_max_lpm_groups,
      'maxChannelTargets', p_max_channel_targets
    ),
    'ACTIVE', now(), expires, p_max_lpm_groups, p_max_channel_targets
  )
  returning id into entitlement_id;
  return entitlement_id;
end;
$$;

comment on constraint package_versions_snapshot_package_id_check on public.package_versions
  is 'Prevents immutable package snapshots from losing or misidentifying their package id.';
