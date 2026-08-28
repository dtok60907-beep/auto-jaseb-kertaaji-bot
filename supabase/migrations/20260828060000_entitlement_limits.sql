-- Entitlement limits and admin assignment.
-- No total broadcast quota is stored: an active subscription may send freely.

alter table public.entitlements
  add column max_lpm_groups integer not null default 0
    check (max_lpm_groups >= 0),
  add column max_channel_targets integer not null default 0
    check (max_channel_targets >= 0);

create index entitlements_active_limits_idx
  on public.entitlements (user_id, status, expires_at);

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
      'maxLpmGroups', p_max_lpm_groups,
      'maxChannelTargets', p_max_channel_targets
    ),
    'ACTIVE', now(), expires, p_max_lpm_groups, p_max_channel_targets
  )
  returning id into entitlement_id;
  return entitlement_id;
end;
$$;

create or replace function public.extend_entitlement(
  p_entitlement_id uuid,
  p_duration_days integer
)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  if p_duration_days <= 0 then
    raise exception using errcode = '22023', message = 'extension duration must be positive';
  end if;
  update public.entitlements
     set expires_at = greatest(expires_at, now()) + make_interval(days => p_duration_days),
         status = 'ACTIVE',
         updated_at = now()
   where id = p_entitlement_id;
  return found;
end;
$$;

create or replace function public.revoke_entitlement(p_entitlement_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
begin
  update public.entitlements
     set status = 'REVOKED', updated_at = now()
   where id = p_entitlement_id and status = 'ACTIVE';
  return found;
end;
$$;

revoke all on function public.grant_entitlement(uuid, uuid, integer, integer, integer) from public;
revoke all on function public.extend_entitlement(uuid, integer) from public;
revoke all on function public.revoke_entitlement(uuid) from public;
