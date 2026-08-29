-- Database-level admission control closes concurrent target-creation races.
-- Existing rows are untouched; only a newly active target is checked.

create or replace function public.assert_lpm_target_capacity(
  p_user_id uuid,
  p_excluding_target_id uuid default null
)
returns void
language plpgsql
set search_path = public
as $$
declare
  configured_limit integer;
  current_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1001));

  select max(max_lpm_groups) into configured_limit
    from public.entitlements
   where user_id = p_user_id
     and status = 'ACTIVE'
     and expires_at > now()
     and package_snapshot->>'packageType' in ('JASEB_WORKER', 'USERBOT');

  if configured_limit is null then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;

  select count(*) into current_count
    from public.broadcast_lpm_targets
   where user_id = p_user_id and active
     and id is distinct from p_excluding_target_id;

  if current_count >= configured_limit then
    raise exception using errcode = 'P0001', message = 'LPM_GROUP_LIMIT_REACHED';
  end if;
end;
$$;

create or replace function public.enforce_lpm_target_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform public.assert_lpm_target_capacity(new.user_id, case when tg_op = 'UPDATE' then new.id else null end);
  end if;
  return new;
end;
$$;

create trigger broadcast_lpm_targets_enforce_capacity
before insert or update of active on public.broadcast_lpm_targets
for each row execute function public.enforce_lpm_target_capacity();

create or replace function public.assert_auto_comment_channel_capacity(
  p_user_id uuid,
  p_excluding_target_id uuid default null
)
returns void
language plpgsql
set search_path = public
as $$
declare
  configured_limit integer;
  current_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 1002));

  select max(max_channel_targets) into configured_limit
    from public.entitlements
   where user_id = p_user_id
     and status = 'ACTIVE'
     and expires_at > now()
     and package_snapshot->>'packageType' = 'USERBOT';

  if configured_limit is null then
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;

  select count(*) into current_count
    from public.auto_comment_channel_targets
   where user_id = p_user_id and active
     and id is distinct from p_excluding_target_id;

  if current_count >= configured_limit then
    raise exception using errcode = 'P0001', message = 'CHANNEL_TARGET_LIMIT_REACHED';
  end if;
end;
$$;

create or replace function public.enforce_auto_comment_channel_capacity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.active and (tg_op = 'INSERT' or not old.active) then
    perform public.assert_auto_comment_channel_capacity(new.user_id, case when tg_op = 'UPDATE' then new.id else null end);
  end if;
  return new;
end;
$$;

create trigger auto_comment_channel_targets_enforce_capacity
before insert or update of active on public.auto_comment_channel_targets
for each row execute function public.enforce_auto_comment_channel_capacity();

revoke all on function public.assert_lpm_target_capacity(uuid, uuid) from public;
revoke all on function public.assert_auto_comment_channel_capacity(uuid, uuid) from public;
