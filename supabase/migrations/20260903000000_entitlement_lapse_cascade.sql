-- expire_due_entitlements() already existed with the right cascade (mark
-- EXPIRED, disconnect the userbot profile, release worker assignments,
-- cancel queued Jasa Sebar/Auto Komen work) for natural time-based expiry --
-- it was just never called from anywhere, so none of that ever actually ran.
-- Separately, revoke_entitlement() (the admin "Cabut akses" action) only
-- ever flipped the entitlement's own status, with no cascade at all, so a
-- revoked user's connected account and queued work silently sat there doing
-- nothing rather than being cleaned up the same way an expiry is.
--
-- Both lapse events should produce the same visible outcome. Pull the
-- cascade out into its own function, parameterized by user + an error code
-- (so an operation cancelled by expiry vs by an explicit admin revoke stays
-- distinguishable in delivery_status/error_code history), and have both
-- entry points call it.

create or replace function public.deactivate_lapsed_user_operations(
  p_user_id uuid,
  p_error_code text,
  p_at timestamptz default now()
)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.userbot_profiles profile set status = 'DISCONNECTED', updated_at = p_at
   where profile.user_id = p_user_id and profile.status = 'CONNECTED'
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = 'USERBOT'
     );

  update public.worker_assignments assignment set status = 'RELEASED', released_at = p_at, updated_at = p_at
   where assignment.user_id = p_user_id and assignment.status in ('RESERVED', 'ACTIVE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = 'JASEB_WORKER'
     );

  update public.broadcast_targets target set delivery_status = 'CANCELLED', last_error_code = p_error_code
    from public.workflow_operations operation
   where operation.id = target.operation_id and operation.user_id = p_user_id
     and target.delivery_status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = operation.payload->>'accountMode'
     );

  update public.workflow_commands command set status = 'CANCELLED', last_error_code = p_error_code, outcome_checked_at = p_at
    from public.workflow_operations operation
   where operation.id = command.operation_id and operation.user_id = p_user_id
     and command.status in ('PENDING', 'FAILED_RETRYABLE')
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = case when operation.operation_type = 'AUTO_COMMENT' then 'USERBOT' else operation.payload->>'accountMode' end
     );

  update public.workflow_operations operation set status = 'CANCELLED', error_code = p_error_code
   where operation.user_id = p_user_id
     and operation.status not in ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN')
     and not exists (
       select 1 from public.workflow_commands command
        where command.operation_id = operation.id and command.status in ('PENDING', 'FAILED_RETRYABLE', 'CLAIMED', 'SENDING')
     )
     and not exists (
       select 1 from public.entitlements active
        where active.user_id = p_user_id and active.status = 'ACTIVE' and active.expires_at > p_at
          and active.package_snapshot->>'packageType' = case when operation.operation_type = 'AUTO_COMMENT' then 'USERBOT' else operation.payload->>'accountMode' end
     );
end;
$$;

comment on function public.deactivate_lapsed_user_operations(uuid, text, timestamptz)
  is 'Shared cascade for a user losing their active entitlement (expiry or revoke): disconnects the userbot profile / releases worker assignment if no other active entitlement of that package type covers it, and cancels queued Jasa Sebar/Auto Komen work. Does not touch the Telegram session itself -- disconnect only, session deletion stays an explicit Logout action.';

revoke all on function public.deactivate_lapsed_user_operations(uuid, text, timestamptz) from public;

create or replace function public.expire_due_entitlements(p_at timestamptz default now())
returns integer
language plpgsql
set search_path = public
as $$
declare
  expired_count integer := 0;
  affected_user_id uuid;
begin
  for affected_user_id in
    update public.entitlements set status = 'EXPIRED', updated_at = p_at
     where status = 'ACTIVE' and expires_at <= p_at
    returning user_id
  loop
    expired_count := expired_count + 1;
    perform public.deactivate_lapsed_user_operations(affected_user_id, 'SUBSCRIPTION_EXPIRED', p_at);
  end loop;
  return expired_count;
end;
$$;

comment on function public.expire_due_entitlements(timestamptz)
  is 'Marks past-due ACTIVE entitlements EXPIRED and runs the lapse cascade for each affected user. Meant to be called periodically by the engine.';

revoke all on function public.expire_due_entitlements(timestamptz) from public;

create or replace function public.revoke_entitlement(p_entitlement_id uuid)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  affected_user_id uuid;
begin
  update public.entitlements
     set status = 'REVOKED', updated_at = now()
   where id = p_entitlement_id and status = 'ACTIVE'
  returning user_id into affected_user_id;

  if not found then
    return false;
  end if;

  perform public.deactivate_lapsed_user_operations(affected_user_id, 'SUBSCRIPTION_REVOKED', now());
  return true;
end;
$$;

comment on function public.revoke_entitlement(uuid)
  is 'Admin-initiated revoke of an ACTIVE entitlement; runs the same lapse cascade as a natural expiry.';

revoke all on function public.revoke_entitlement(uuid) from public;
