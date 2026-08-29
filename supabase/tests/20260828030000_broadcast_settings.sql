-- Run after migrations V1 through V4. Test bootstrap must provide auth.users(id uuid).

begin;

insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into public.entitlements (
  user_id, package_snapshot, status, starts_at, expires_at, max_lpm_groups, max_channel_targets
)
values (
  '11111111-1111-1111-1111-111111111111',
  '{"packageId":"fixture","packageType":"USERBOT","features":["JASEB","AUTO_COMMENT_MF"],"maxTargetsPerMinute":1,"maxAccounts":1,"intervalMinSeconds":0,"intervalMaxSeconds":0}',
  'ACTIVE', now() - interval '1 minute', now() + interval '1 day', 10, 10
);

insert into public.broadcast_materials (user_id, kind, text_content)
values ('11111111-1111-1111-1111-111111111111', 'TEXT', 'Promo kos putri');

insert into public.broadcast_materials (
  user_id, kind, forward_channel_username, forward_message_id, source_attribution
)
values (
  '11111111-1111-1111-1111-111111111111',
  'FORWARD', 'KosPutri_Bali', 123, 'HIDE_SOURCE'
);

insert into public.broadcast_lpm_targets (user_id, telegram_target_ref, label)
values ('11111111-1111-1111-1111-111111111111', '@grup_lpm_bali', 'LPM Bali');

do $$
begin
  if (select count(*) from public.broadcast_materials where user_id = '11111111-1111-1111-1111-111111111111') <> 2 then
    raise exception 'expected two valid broadcast materials';
  end if;

  begin
    insert into public.broadcast_materials (
      user_id, kind, text_content, forward_channel_username, forward_message_id, source_attribution
    )
    values (
      '11111111-1111-1111-1111-111111111111',
      'TEXT', 'mixed payload', 'KosPutri_Bali', 123, 'SHOW_SOURCE'
    );
    raise exception 'mixed material was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.broadcast_materials (
      user_id, kind, forward_channel_username, forward_message_id, source_attribution
    )
    values (
      '11111111-1111-1111-1111-111111111111',
      'FORWARD', '+privateInvite', 123, 'SHOW_SOURCE'
    );
    raise exception 'non-public source username was accepted';
  exception when check_violation then
    null;
  end;

  begin
    insert into public.broadcast_lpm_targets (user_id, telegram_target_ref)
    values ('11111111-1111-1111-1111-111111111111', '@GRUP_LPM_BALI');
    raise exception 'case-insensitive duplicate LPM target was accepted';
  exception when unique_violation then
    null;
  end;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'broadcast_materials'
       and policyname = 'broadcast_materials_owner_read'
  ) then
    raise exception 'broadcast material RLS policy missing';
  end if;
end;
$$;

update public.entitlements set max_lpm_groups = 1
 where user_id = '11111111-1111-1111-1111-111111111111';

do $$
begin
  begin
    insert into public.broadcast_lpm_targets (user_id, telegram_target_ref)
    values ('11111111-1111-1111-1111-111111111111', '@grup_lpm_lain');
    raise exception 'LPM target capacity was exceeded';
  exception when raise_exception then
    if sqlerrm <> 'LPM_GROUP_LIMIT_REACHED' then raise; end if;
  end;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
select 1 / case when (select count(*) from public.broadcast_materials) = 2 then 1 else 0 end;
select 1 / case when (select count(*) from public.broadcast_lpm_targets) = 1 then 1 else 0 end;

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select 1 / case when (select count(*) from public.broadcast_materials) = 0 then 1 else 0 end;
select 1 / case when (select count(*) from public.broadcast_lpm_targets) = 0 then 1 else 0 end;
reset role;

rollback;
