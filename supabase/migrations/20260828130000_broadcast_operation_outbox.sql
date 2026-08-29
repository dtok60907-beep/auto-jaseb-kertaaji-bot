-- Atomic Jasa Sebar admission. A request either creates one complete operation
-- with one outbox command per selected Grup LPM, or writes nothing at all.

alter table public.workflow_commands
  drop constraint workflow_commands_kind_check,
  add constraint workflow_commands_kind_check
    check (kind in ('SEND_TEXT', 'FORWARD_MESSAGE', 'COMMENT_TEXT'));

alter table public.broadcast_targets
  add column sequence_number integer;

with ordered as (
  select id, row_number() over (partition by operation_id order by created_at, id)::integer as sequence_number
    from public.broadcast_targets
)
update public.broadcast_targets target
   set sequence_number = ordered.sequence_number
  from ordered
 where ordered.id = target.id;

alter table public.broadcast_targets
  alter column sequence_number set not null,
  add constraint broadcast_targets_sequence_positive check (sequence_number > 0);

create unique index broadcast_targets_operation_sequence_unique_idx
  on public.broadcast_targets (operation_id, sequence_number);

create or replace function public.create_broadcast_operation(
  p_user_id uuid,
  p_account_mode text,
  p_material_id uuid,
  p_target_ids uuid[],
  p_idempotency_key text
)
returns table (result_status text, operation_id uuid)
language plpgsql
set search_path = public
as $$
declare
  existing_operation_id uuid;
  existing_operation_type text;
  selected_account_id uuid;
  selected_interval_seconds integer;
  material_row public.broadcast_materials%rowtype;
  material_snapshot jsonb;
  created_operation_id uuid;
  selected_target_count integer;
begin
  if p_account_mode not in ('JASEB_WORKER', 'USERBOT') then
    raise exception using errcode = 'P0001', message = 'INVALID_ACCOUNT_MODE';
  end if;
  if char_length(btrim(coalesce(p_idempotency_key, ''))) not between 8 and 128 then
    raise exception using errcode = 'P0001', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;
  if p_target_ids is null or cardinality(p_target_ids) = 0 then
    raise exception using errcode = 'P0001', message = 'BROADCAST_TARGETS_REQUIRED';
  end if;
  if cardinality(p_target_ids) <> (
    select count(distinct target_id) from unnest(p_target_ids) as target_id
  ) then
    raise exception using errcode = 'P0001', message = 'DUPLICATE_LPM_TARGET';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_idempotency_key, 1301));
  select id, operation_type into existing_operation_id, existing_operation_type
    from public.workflow_operations
   where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_operation_type <> 'BROADCAST' then
      raise exception using errcode = 'P0001', message = 'IDEMPOTENCY_KEY_CONFLICT';
    end if;
    return query select 'IDEMPOTENT'::text, existing_operation_id;
    return;
  end if;

  if not exists (
    select 1 from public.entitlements entitlement
     where entitlement.user_id = p_user_id
       and entitlement.status = 'ACTIVE'
       and entitlement.expires_at > now()
       and entitlement.package_snapshot->>'packageType' = p_account_mode
       and entitlement.package_snapshot->'features' ? 'JASEB'
  ) then
    if exists (
      select 1 from public.entitlements entitlement
       where entitlement.user_id = p_user_id
         and entitlement.package_snapshot->>'packageType' = p_account_mode
         and (entitlement.status = 'EXPIRED' or (entitlement.status = 'ACTIVE' and entitlement.expires_at <= now()))
    ) then
      raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_EXPIRED';
    end if;
    raise exception using errcode = 'P0001', message = 'SUBSCRIPTION_REQUIRED';
  end if;

  select * into material_row
    from public.broadcast_materials
   where id = p_material_id and user_id = p_user_id and active
   for share;
  if not found then
    raise exception using errcode = 'P0001', message = 'BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE';
  end if;

  select count(*) into selected_target_count
    from public.broadcast_lpm_targets
   where user_id = p_user_id and active and id = any(p_target_ids);
  if selected_target_count <> cardinality(p_target_ids) then
    raise exception using errcode = 'P0001', message = 'LPM_TARGET_NOT_FOUND_OR_INACTIVE';
  end if;

  if p_account_mode = 'USERBOT' then
    select account.id, profile.broadcast_interval_seconds
      into selected_account_id, selected_interval_seconds
      from public.userbot_profiles profile
      join public.telegram_accounts account on account.id = profile.active_account_id
     where profile.user_id = p_user_id
       and profile.status = 'CONNECTED'
       and account.owner_user_id = p_user_id
       and account.account_type = 'USERBOT'
       and account.status = 'READY'
     for update of profile, account;
    if not found then
      raise exception using errcode = 'P0001', message = 'USERBOT_NOT_CONNECTED';
    end if;
  else
    select account.id, setting.interval_seconds
      into selected_account_id, selected_interval_seconds
      from public.worker_account_settings setting
      join public.telegram_accounts account on account.id = setting.worker_account_id
     where setting.active
       and account.account_type = 'JASEB_WORKER'
       and account.status = 'READY'
       and not exists (
         select 1 from public.worker_assignments assignment
          where assignment.worker_account_id = account.id
            and assignment.status in ('RESERVED', 'ACTIVE')
       )
     order by account.created_at, account.id
     for update of account skip locked
     limit 1;
    if not found then
      raise exception using errcode = 'P0001', message = 'WORKER_UNAVAILABLE';
    end if;
  end if;

  material_snapshot := case material_row.kind
    when 'TEXT' then jsonb_build_object(
      'id', material_row.id::text, 'kind', 'TEXT', 'text', material_row.text_content
    )
    else jsonb_build_object(
      'id', material_row.id::text, 'kind', 'FORWARD',
      'source', jsonb_build_object(
        'channelUsername', material_row.forward_channel_username,
        'messageId', material_row.forward_message_id,
        'canonicalLink', 'https://t.me/' || material_row.forward_channel_username || '/' || material_row.forward_message_id
      ),
      'sourceAttribution', material_row.source_attribution
    )
  end;

  insert into public.workflow_operations (
    user_id, account_id, operation_type, status, idempotency_key, payload
  ) values (
    p_user_id, selected_account_id, 'BROADCAST', 'QUEUED', p_idempotency_key,
    jsonb_build_object(
      'accountMode', p_account_mode,
      'intervalSeconds', selected_interval_seconds,
      'material', material_snapshot
    )
  ) returning id into created_operation_id;

  if p_account_mode = 'JASEB_WORKER' then
    insert into public.worker_assignments (operation_id, worker_account_id)
    values (created_operation_id, selected_account_id);
  end if;

  insert into public.broadcast_targets (
    operation_id, telegram_target_ref, interval_seconds, sequence_number
  )
  select created_operation_id, target.telegram_target_ref, selected_interval_seconds, requested.ordinality::integer
    from unnest(p_target_ids) with ordinality as requested(id, ordinality)
    join public.broadcast_lpm_targets target on target.id = requested.id;

  insert into public.workflow_commands (
    operation_id, account_id, kind, target_id, idempotency_key, payload, broadcast_target_id
  )
  select created_operation_id, selected_account_id,
         case when material_row.kind = 'TEXT' then 'SEND_TEXT' else 'FORWARD_MESSAGE' end,
         target.telegram_target_ref,
         'broadcast-command:' || target.id::text,
         jsonb_build_object('material', material_snapshot),
         target.id
    from public.broadcast_targets target
   where target.operation_id = created_operation_id;

  return query select 'CREATED'::text, created_operation_id;
end;
$$;

comment on function public.create_broadcast_operation(uuid, text, uuid, uuid[], text)
  is 'Atomically verifies entitlement and account readiness, snapshots Jasa Sebar material/interval, reserves a worker when needed, then creates one outbox command per selected LPM target.';

revoke all on function public.create_broadcast_operation(uuid, text, uuid, uuid[], text) from public;
