-- Expiry transition is idempotent. Runtime workers must call this periodically.
-- It never deletes settings or encrypted Telegram sessions.

create or replace function public.expire_due_entitlements(p_at timestamptz default now())
returns integer
language plpgsql
set search_path = public
as $$
declare
  expired_count integer;
begin
  with expired as (
    update public.entitlements
       set status = 'EXPIRED', updated_at = p_at
     where status = 'ACTIVE' and expires_at <= p_at
     returning user_id
  )
  select count(*) into expired_count from expired;

  update public.userbot_profiles profile
     set status = 'DISCONNECTED', updated_at = p_at
   where profile.user_id in (
     select distinct user_id from public.entitlements
      where status = 'EXPIRED' and expires_at <= p_at
   )
     and not exists (select 1 from public.entitlements active
                      where active.user_id = profile.user_id and active.status = 'ACTIVE'
                        and active.expires_at > p_at)
     and profile.status = 'CONNECTED';

  update public.worker_assignments assignment
     set status = 'RELEASED', released_at = p_at, updated_at = p_at
    from public.workflow_operations operation
   where operation.id = assignment.operation_id
     and assignment.status = 'RESERVED'
     and operation.user_id in (
       select distinct user_id from public.entitlements
        where status = 'EXPIRED' and expires_at <= p_at
     )
     and not exists (select 1 from public.entitlements active
                      where active.user_id = operation.user_id and active.status = 'ACTIVE'
                        and active.expires_at > p_at);

  return expired_count;
end;
$$;

revoke all on function public.expire_due_entitlements(timestamptz) from public;
