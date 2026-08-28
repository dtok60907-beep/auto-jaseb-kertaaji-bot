-- Auto Komen Menfess configuration and review persistence.
-- Legacy comment_rules/comment_matches stay intact for a forward-compatible migration.

create table public.auto_comment_divisions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  mode text not null default 'APPROVAL_REQUIRED'
    check (mode in ('APPROVAL_REQUIRED', 'AUTO_SEND')),
  active boolean not null default true,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index auto_comment_divisions_user_account_name_unique_idx
  on public.auto_comment_divisions (user_id, account_id, lower(btrim(name)));
create index auto_comment_divisions_account_active_idx
  on public.auto_comment_divisions (account_id, created_at desc)
  where active;

create table public.auto_comment_division_keywords (
  id uuid primary key default extensions.gen_random_uuid(),
  division_id uuid not null references public.auto_comment_divisions(id) on delete cascade,
  keyword text not null check (char_length(btrim(keyword)) between 1 and 256),
  created_at timestamptz not null default now()
);

create unique index auto_comment_division_keywords_unique_idx
  on public.auto_comment_division_keywords (division_id, lower(btrim(keyword)));

create table public.auto_comment_division_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  division_id uuid not null references public.auto_comment_divisions(id) on delete cascade,
  text_content text not null check (char_length(btrim(text_content)) between 1 and 4096),
  display_order integer not null default 0 check (display_order >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index auto_comment_division_templates_unique_idx
  on public.auto_comment_division_templates (division_id, lower(btrim(text_content)));
create index auto_comment_division_templates_active_idx
  on public.auto_comment_division_templates (division_id, display_order, created_at)
  where active;

create table public.auto_comment_channel_targets (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  source_channel_ref text not null check (char_length(btrim(source_channel_ref)) between 1 and 256),
  discussion_target_ref text,
  resolution_status text not null default 'QUEUED'
    check (resolution_status in ('QUEUED', 'CHECKING', 'READY', 'FAILED_FINAL')),
  last_error_code text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (discussion_target_ref is null or char_length(btrim(discussion_target_ref)) between 1 and 256),
  check ((resolution_status = 'READY') = (discussion_target_ref is not null))
);

create unique index auto_comment_channel_targets_account_channel_unique_idx
  on public.auto_comment_channel_targets (account_id, lower(btrim(source_channel_ref)));
create index auto_comment_channel_targets_account_active_idx
  on public.auto_comment_channel_targets (account_id, created_at desc)
  where active;

create table public.auto_comment_division_channels (
  division_id uuid not null references public.auto_comment_divisions(id) on delete cascade,
  channel_target_id uuid not null references public.auto_comment_channel_targets(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (division_id, channel_target_id)
);

create index auto_comment_division_channels_target_idx
  on public.auto_comment_division_channels (channel_target_id, division_id);

create table public.auto_comment_candidates (
  id uuid primary key default extensions.gen_random_uuid(),
  division_id uuid not null references public.auto_comment_divisions(id) on delete restrict,
  channel_target_id uuid not null references public.auto_comment_channel_targets(id) on delete restrict,
  incoming_post_id uuid not null references public.incoming_channel_posts(id) on delete restrict,
  selected_template_id uuid references public.auto_comment_division_templates(id) on delete set null,
  template_text_snapshot text not null check (char_length(btrim(template_text_snapshot)) between 1 and 4096),
  matched_keywords_snapshot text[] not null
    check (cardinality(matched_keywords_snapshot) > 0)
    check (array_position(matched_keywords_snapshot, null) is null),
  mode_snapshot text not null check (mode_snapshot in ('APPROVAL_REQUIRED', 'AUTO_SEND')),
  discussion_target_ref_snapshot text,
  status text not null
    check (status in (
      'PENDING_REVIEW', 'COMMENT_QUEUED', 'OOT', 'COMMENT_SENT',
      'COMMENT_FAILED', 'SIDE_EFFECT_UNCERTAIN', 'REJECTED'
    )),
  error_code text,
  notification_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    status = 'REJECTED'
    or char_length(btrim(coalesce(discussion_target_ref_snapshot, ''))) between 1 and 256
  ),
  unique (division_id, incoming_post_id)
);

create index auto_comment_candidates_pending_idx
  on public.auto_comment_candidates (status, created_at)
  where status in ('PENDING_REVIEW', 'COMMENT_QUEUED', 'SIDE_EFFECT_UNCERTAIN');
create index auto_comment_candidates_division_created_idx
  on public.auto_comment_candidates (division_id, created_at desc);

create table public.auto_comment_reviews (
  candidate_id uuid primary key references public.auto_comment_candidates(id) on delete restrict,
  decided_by_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check (decision in ('TEPAT', 'OOT')),
  decided_at timestamptz not null default now()
);

alter table public.workflow_commands
  drop constraint workflow_commands_one_context_check,
  add column auto_comment_candidate_id uuid references public.auto_comment_candidates(id) on delete restrict,
  add constraint workflow_commands_one_context_check
    check (num_nonnulls(broadcast_target_id, comment_match_id, auto_comment_candidate_id) = 1),
  add constraint workflow_commands_unique_auto_comment_candidate unique (auto_comment_candidate_id);

create or replace function public.validate_auto_comment_userbot_account()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_owner uuid;
  account_type_value text;
begin
  select owner_user_id, account_type into account_owner, account_type_value
    from public.telegram_accounts
   where id = new.account_id;
  if account_type_value is distinct from 'USERBOT' or account_owner is distinct from new.user_id then
    raise exception using errcode = '42501', message = 'auto comment requires the user-owned userbot account';
  end if;
  return new;
end;
$$;

create trigger auto_comment_divisions_validate_account
before insert or update of user_id, account_id on public.auto_comment_divisions
for each row execute function public.validate_auto_comment_userbot_account();

create trigger auto_comment_channel_targets_validate_account
before insert or update of user_id, account_id on public.auto_comment_channel_targets
for each row execute function public.validate_auto_comment_userbot_account();

create or replace function public.validate_auto_comment_division_channel()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  division_user_id uuid;
  division_account_id uuid;
  channel_user_id uuid;
  channel_account_id uuid;
begin
  select user_id, account_id into division_user_id, division_account_id
    from public.auto_comment_divisions where id = new.division_id;
  select user_id, account_id into channel_user_id, channel_account_id
    from public.auto_comment_channel_targets where id = new.channel_target_id;
  if division_user_id is distinct from channel_user_id
     or division_account_id is distinct from channel_account_id then
    raise exception using errcode = '42501', message = 'division and channel target ownership mismatch';
  end if;
  return new;
end;
$$;

create trigger auto_comment_division_channels_validate_context
before insert or update of division_id, channel_target_id on public.auto_comment_division_channels
for each row execute function public.validate_auto_comment_division_channel();

create or replace function public.validate_auto_comment_candidate_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  division_account_id uuid;
  division_mode text;
  channel_account_id uuid;
  channel_source_ref text;
  channel_discussion_ref text;
  post_account_id uuid;
  post_source_ref text;
begin
  if tg_op = 'INSERT' and new.selected_template_id is null then
    raise exception using errcode = '23514', message = 'candidate requires a division template snapshot';
  end if;
  select account_id, mode into division_account_id, division_mode
    from public.auto_comment_divisions where id = new.division_id;
  select account_id, source_channel_ref, discussion_target_ref
    into channel_account_id, channel_source_ref, channel_discussion_ref
    from public.auto_comment_channel_targets where id = new.channel_target_id;
  select account_id, source_channel_ref
    into post_account_id, post_source_ref
    from public.incoming_channel_posts where id = new.incoming_post_id;

  if division_account_id is distinct from channel_account_id
     or channel_account_id is distinct from post_account_id
     or channel_source_ref is distinct from post_source_ref then
    raise exception using errcode = '23514', message = 'auto comment candidate account or channel mismatch';
  end if;
  if not exists (
    select 1 from public.auto_comment_division_channels mapping
     where mapping.division_id = new.division_id
       and mapping.channel_target_id = new.channel_target_id
  ) then
    raise exception using errcode = '23514', message = 'candidate channel is not assigned to division';
  end if;
  if new.selected_template_id is not null and not exists (
    select 1 from public.auto_comment_division_templates template
     where template.id = new.selected_template_id
       and template.division_id = new.division_id
       and template.text_content = new.template_text_snapshot
  ) then
    raise exception using errcode = '23514', message = 'candidate template does not belong to division snapshot';
  end if;
  if exists (
    select 1
      from unnest(new.matched_keywords_snapshot) as matched(keyword)
     where not exists (
       select 1 from public.auto_comment_division_keywords configured
        where configured.division_id = new.division_id
          and lower(btrim(configured.keyword)) = lower(btrim(matched.keyword))
     )
  ) then
    raise exception using errcode = '23514', message = 'candidate keyword does not belong to division';
  end if;
  if new.mode_snapshot is distinct from division_mode then
    raise exception using errcode = '23514', message = 'candidate mode snapshot mismatch';
  end if;
  if new.status <> 'REJECTED'
     and new.discussion_target_ref_snapshot is distinct from channel_discussion_ref then
    raise exception using errcode = '23514', message = 'candidate discussion target snapshot mismatch';
  end if;
  return new;
end;
$$;

create trigger auto_comment_candidates_validate_context
before insert or update of division_id, channel_target_id, incoming_post_id, selected_template_id,
  template_text_snapshot, matched_keywords_snapshot, mode_snapshot, discussion_target_ref_snapshot
on public.auto_comment_candidates
for each row execute function public.validate_auto_comment_candidate_context();

create or replace function public.validate_auto_comment_review()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  candidate_user_id uuid;
  candidate_mode text;
  candidate_status text;
begin
  select division.user_id, candidate.mode_snapshot, candidate.status
    into candidate_user_id, candidate_mode, candidate_status
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
   where candidate.id = new.candidate_id;
  if candidate_user_id is distinct from new.decided_by_user_id then
    raise exception using errcode = '42501', message = 'review decision ownership mismatch';
  end if;
  if candidate_mode is distinct from 'APPROVAL_REQUIRED' then
    raise exception using errcode = '23514', message = 'auto-send candidate does not accept review decision';
  end if;
  if (new.decision = 'TEPAT' and candidate_status is distinct from 'COMMENT_QUEUED')
     or (new.decision = 'OOT' and candidate_status is distinct from 'OOT') then
    raise exception using errcode = '23514', message = 'review decision and candidate status mismatch';
  end if;
  return new;
end;
$$;

create trigger auto_comment_reviews_validate_context
before insert on public.auto_comment_reviews
for each row execute function public.validate_auto_comment_review();

create or replace function public.prevent_auto_comment_review_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception using errcode = '55000', message = 'auto comment review is immutable';
end;
$$;

create trigger auto_comment_reviews_immutable
before update or delete on public.auto_comment_reviews
for each row execute function public.prevent_auto_comment_review_mutation();

create or replace function public.validate_workflow_command_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  expected_operation_id uuid;
  expected_account_id uuid;
  expected_target_ref text;
  operation_type_value text;
  candidate_mode text;
  candidate_status text;
begin
  if new.broadcast_target_id is not null then
    select operation_id, telegram_target_ref
      into expected_operation_id, expected_target_ref
      from public.broadcast_targets
     where id = new.broadcast_target_id;
    if expected_operation_id is distinct from new.operation_id or expected_target_ref is distinct from new.target_id then
      raise exception using errcode = '23514', message = 'broadcast command context mismatch';
    end if;
  elsif new.comment_match_id is not null then
    select rule.account_id, rule.discussion_target_ref
      into expected_account_id, expected_target_ref
      from public.comment_matches matched
      join public.comment_rules rule on rule.id = matched.rule_id
     where matched.id = new.comment_match_id;
    select operation_type into operation_type_value from public.workflow_operations where id = new.operation_id;
    if operation_type_value is distinct from 'AUTO_COMMENT' then
      raise exception using errcode = '23514', message = 'comment command requires an auto-comment operation';
    end if;
    if expected_account_id is distinct from new.account_id or expected_target_ref is distinct from new.target_id then
      raise exception using errcode = '23514', message = 'comment command context mismatch';
    end if;
  else
    select division.account_id, candidate.discussion_target_ref_snapshot,
           candidate.mode_snapshot, candidate.status
      into expected_account_id, expected_target_ref, candidate_mode, candidate_status
      from public.auto_comment_candidates candidate
      join public.auto_comment_divisions division on division.id = candidate.division_id
     where candidate.id = new.auto_comment_candidate_id;
    select operation_type into operation_type_value from public.workflow_operations where id = new.operation_id;
    if operation_type_value is distinct from 'AUTO_COMMENT' then
      raise exception using errcode = '23514', message = 'candidate command requires an auto-comment operation';
    end if;
    if new.kind is distinct from 'COMMENT_TEXT'
       or candidate_status is distinct from 'COMMENT_QUEUED'
       or expected_account_id is distinct from new.account_id
       or expected_target_ref is distinct from new.target_id then
      raise exception using errcode = '23514', message = 'auto comment candidate command context mismatch';
    end if;
    if candidate_mode = 'APPROVAL_REQUIRED' and not exists (
      select 1 from public.auto_comment_reviews review
       where review.candidate_id = new.auto_comment_candidate_id
         and review.decision = 'TEPAT'
    ) then
      raise exception using errcode = '23514', message = 'approval-required candidate needs Tepat review before command';
    end if;
  end if;
  return new;
end;
$$;

drop trigger workflow_commands_validate_context on public.workflow_commands;
create trigger workflow_commands_validate_context
before insert or update of operation_id, account_id, kind, target_id,
  broadcast_target_id, comment_match_id, auto_comment_candidate_id
on public.workflow_commands
for each row execute function public.validate_workflow_command_context();

create trigger auto_comment_divisions_set_updated_at
before update on public.auto_comment_divisions
for each row execute function public.set_updated_at();
create trigger auto_comment_division_templates_set_updated_at
before update on public.auto_comment_division_templates
for each row execute function public.set_updated_at();
create trigger auto_comment_channel_targets_set_updated_at
before update on public.auto_comment_channel_targets
for each row execute function public.set_updated_at();
create trigger auto_comment_candidates_set_updated_at
before update on public.auto_comment_candidates
for each row execute function public.set_updated_at();

alter table public.auto_comment_divisions enable row level security;
alter table public.auto_comment_division_keywords enable row level security;
alter table public.auto_comment_division_templates enable row level security;
alter table public.auto_comment_channel_targets enable row level security;
alter table public.auto_comment_division_channels enable row level security;
alter table public.auto_comment_candidates enable row level security;
alter table public.auto_comment_reviews enable row level security;

create policy auto_comment_divisions_owner_read on public.auto_comment_divisions
  for select to authenticated using (user_id = auth.uid());
create policy auto_comment_division_keywords_owner_read on public.auto_comment_division_keywords
  for select to authenticated using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_keywords.division_id
         and division.user_id = auth.uid()
    )
  );
create policy auto_comment_division_templates_owner_read on public.auto_comment_division_templates
  for select to authenticated using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_templates.division_id
         and division.user_id = auth.uid()
    )
  );
create policy auto_comment_channel_targets_owner_read on public.auto_comment_channel_targets
  for select to authenticated using (user_id = auth.uid());
create policy auto_comment_division_channels_owner_read on public.auto_comment_division_channels
  for select to authenticated using (
    exists (
      select 1 from public.auto_comment_divisions division
       where division.id = auto_comment_division_channels.division_id
         and division.user_id = auth.uid()
    )
  );
create policy auto_comment_candidates_owner_read on public.auto_comment_candidates
  for select to authenticated using (
    exists (
      select 1 from public.auto_comment_divisions division
     where division.id = auto_comment_candidates.division_id
       and division.user_id = auth.uid()
    )
  );
create policy auto_comment_reviews_owner_read on public.auto_comment_reviews
  for select to authenticated using (
    exists (
      select 1
        from public.auto_comment_candidates candidate
        join public.auto_comment_divisions division on division.id = candidate.division_id
       where candidate.id = auto_comment_reviews.candidate_id
         and division.user_id = auth.uid()
    )
  );

comment on table public.auto_comment_channel_targets is 'One monitored channel per userbot account; multiple divisions attach through auto_comment_division_channels.';
comment on table public.auto_comment_candidates is 'Immutable match snapshots; approval-default candidates do not become commands until a Tepat review exists.';
comment on table public.auto_comment_reviews is 'One immutable Tepat/OOT decision per approval-required candidate.';
