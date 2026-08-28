-- Persist the two core workflows before any API or Telegram executor is added.

alter table public.workflow_operations
  drop constraint workflow_operations_status_check,
  add constraint workflow_operations_status_check
    check (status in (
      'QUEUED', 'CHECKING', 'JOINING', 'WAITING_APPROVAL', 'READY', 'SENDING',
      'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
    ));

alter table public.workflow_commands
  drop constraint workflow_commands_status_check,
  add constraint workflow_commands_status_check
    check (status in (
      'PENDING', 'CLAIMED', 'SENDING', 'SUCCEEDED', 'FAILED_RETRYABLE',
      'FAILED_FINAL', 'CANCELLED', 'SIDE_EFFECT_UNCERTAIN'
    )),
  add column provider_message_id text,
  add column provider_sent_at timestamptz,
  add column outcome_checked_at timestamptz,
  add column retry_after timestamptz;

create table public.broadcast_targets (
  id uuid primary key default extensions.gen_random_uuid(),
  operation_id uuid not null references public.workflow_operations(id) on delete cascade,
  telegram_target_ref text not null check (char_length(btrim(telegram_target_ref)) between 1 and 256),
  interval_seconds integer not null check (interval_seconds >= 0),
  preparation_status text not null default 'QUEUED'
    check (preparation_status in ('QUEUED', 'CHECKING', 'JOINING', 'READY', 'FAILED_FINAL')),
  delivery_status text not null default 'PENDING'
    check (delivery_status in ('PENDING', 'SENDING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SIDE_EFFECT_UNCERTAIN', 'CANCELLED')),
  next_eligible_at timestamptz,
  last_success_at timestamptz,
  last_provider_message_id text,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operation_id, telegram_target_ref)
);

create index broadcast_targets_operation_status_idx
  on public.broadcast_targets (operation_id, preparation_status, delivery_status);
create index broadcast_targets_eligible_idx
  on public.broadcast_targets (next_eligible_at)
  where delivery_status in ('PENDING', 'FAILED_RETRYABLE');

create table public.worker_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  operation_id uuid not null unique references public.workflow_operations(id) on delete cascade,
  worker_account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  status text not null default 'RESERVED'
    check (status in ('RESERVED', 'ACTIVE', 'RELEASED', 'FAILED')),
  assigned_at timestamptz not null default now(),
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('RELEASED', 'FAILED')) = (released_at is not null))
);

create unique index worker_assignments_one_active_worker_idx
  on public.worker_assignments (worker_account_id)
  where status in ('RESERVED', 'ACTIVE');

create table public.comment_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_id uuid not null references public.telegram_accounts(id) on delete restrict,
  source_channel_ref text not null check (char_length(btrim(source_channel_ref)) between 1 and 256),
  discussion_target_ref text not null check (char_length(btrim(discussion_target_ref)) between 1 and 256),
  regex_source text not null check (char_length(regex_source) between 1 and 256),
  regex_flags text not null default '' check (regex_flags ~ '^[imsu]*$'),
  comment_text text not null check (char_length(comment_text) between 1 and 4096),
  version integer not null default 1 check (version > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, source_channel_ref, discussion_target_ref, version)
);

create index comment_rules_account_channel_idx
  on public.comment_rules (account_id, source_channel_ref)
  where active;

create table public.incoming_channel_posts (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.telegram_accounts(id) on delete cascade,
  source_channel_ref text not null check (char_length(btrim(source_channel_ref)) between 1 and 256),
  provider_post_id text not null check (char_length(btrim(provider_post_id)) between 1 and 128),
  content text not null check (char_length(content) <= 4096),
  provider_posted_at timestamptz,
  received_at timestamptz not null default now(),
  unique (account_id, source_channel_ref, provider_post_id)
);

create index incoming_channel_posts_account_received_idx
  on public.incoming_channel_posts (account_id, received_at desc);

create table public.comment_matches (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_id uuid not null references public.comment_rules(id) on delete cascade,
  incoming_post_id uuid not null references public.incoming_channel_posts(id) on delete cascade,
  status text not null
    check (status in ('NO_MATCH', 'MATCHED', 'REJECTED', 'COMMENT_QUEUED', 'COMMENT_SENT', 'COMMENT_FAILED', 'SIDE_EFFECT_UNCERTAIN')),
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rule_id, incoming_post_id)
);

create index comment_matches_pending_idx
  on public.comment_matches (status, created_at)
  where status in ('MATCHED', 'COMMENT_QUEUED', 'SIDE_EFFECT_UNCERTAIN');

alter table public.workflow_commands
  add column broadcast_target_id uuid references public.broadcast_targets(id) on delete cascade,
  add column comment_match_id uuid references public.comment_matches(id) on delete cascade,
  add constraint workflow_commands_one_context_check
    check (num_nonnulls(broadcast_target_id, comment_match_id) = 1),
  add constraint workflow_commands_unique_comment_match unique (comment_match_id);

create or replace function public.validate_broadcast_target_operation()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  type_value text;
begin
  select operation_type into type_value from public.workflow_operations where id = new.operation_id;
  if not found or type_value <> 'BROADCAST' then
    raise exception using errcode = '23514', message = 'broadcast target requires a broadcast operation';
  end if;
  return new;
end;
$$;

create trigger broadcast_targets_validate_operation
before insert or update of operation_id on public.broadcast_targets
for each row execute function public.validate_broadcast_target_operation();

create or replace function public.validate_worker_assignment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  account_type_value text;
  operation_type_value text;
begin
  select account_type into account_type_value from public.telegram_accounts where id = new.worker_account_id;
  select operation_type into operation_type_value from public.workflow_operations where id = new.operation_id;
  if account_type_value is distinct from 'JASEB_WORKER' then
    raise exception using errcode = '23514', message = 'assignment requires a worker account';
  end if;
  if operation_type_value is distinct from 'BROADCAST' then
    raise exception using errcode = '23514', message = 'worker assignment requires a broadcast operation';
  end if;
  return new;
end;
$$;

create trigger worker_assignments_validate_refs
before insert or update of operation_id, worker_account_id on public.worker_assignments
for each row execute function public.validate_worker_assignment();

create or replace function public.validate_comment_rule_account()
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
    raise exception using errcode = '42501', message = 'comment rule requires the user-owned userbot account';
  end if;
  return new;
end;
$$;

create trigger comment_rules_validate_account
before insert or update of user_id, account_id on public.comment_rules
for each row execute function public.validate_comment_rule_account();

create or replace function public.validate_comment_match_context()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  rule_account_id uuid;
  rule_channel_ref text;
  post_account_id uuid;
  post_channel_ref text;
begin
  select account_id, source_channel_ref into rule_account_id, rule_channel_ref
    from public.comment_rules
   where id = new.rule_id;
  select account_id, source_channel_ref into post_account_id, post_channel_ref
    from public.incoming_channel_posts
   where id = new.incoming_post_id;
  if rule_account_id is distinct from post_account_id or rule_channel_ref is distinct from post_channel_ref then
    raise exception using errcode = '23514', message = 'comment match rule and incoming post mismatch';
  end if;
  return new;
end;
$$;

create trigger comment_matches_validate_context
before insert or update of rule_id, incoming_post_id on public.comment_matches
for each row execute function public.validate_comment_match_context();

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
begin
  if new.broadcast_target_id is not null then
    select operation_id, telegram_target_ref
      into expected_operation_id, expected_target_ref
      from public.broadcast_targets
     where id = new.broadcast_target_id;
    if expected_operation_id is distinct from new.operation_id or expected_target_ref is distinct from new.target_id then
      raise exception using errcode = '23514', message = 'broadcast command context mismatch';
    end if;
  else
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
  end if;
  return new;
end;
$$;

create trigger workflow_commands_validate_context
before insert or update of operation_id, account_id, target_id, broadcast_target_id, comment_match_id on public.workflow_commands
for each row execute function public.validate_workflow_command_context();

create trigger broadcast_targets_set_updated_at before update on public.broadcast_targets
for each row execute function public.set_updated_at();
create trigger worker_assignments_set_updated_at before update on public.worker_assignments
for each row execute function public.set_updated_at();
create trigger comment_rules_set_updated_at before update on public.comment_rules
for each row execute function public.set_updated_at();
create trigger comment_matches_set_updated_at before update on public.comment_matches
for each row execute function public.set_updated_at();

alter table public.broadcast_targets enable row level security;
alter table public.worker_assignments enable row level security;
alter table public.comment_rules enable row level security;
alter table public.incoming_channel_posts enable row level security;
alter table public.comment_matches enable row level security;

create policy broadcast_targets_owner_read on public.broadcast_targets
  for select to authenticated using (
    exists (
      select 1 from public.workflow_operations operation
      where operation.id = broadcast_targets.operation_id
        and operation.user_id = auth.uid()
    )
  );
create policy comment_rules_owner_read on public.comment_rules
  for select to authenticated using (user_id = auth.uid());
create policy comment_matches_owner_read on public.comment_matches
  for select to authenticated using (
    exists (
      select 1 from public.comment_rules rule
      where rule.id = comment_matches.rule_id
        and rule.user_id = auth.uid()
    )
  );

comment on column public.workflow_commands.status is 'SIDE_EFFECT_UNCERTAIN is not eligible for automatic retry.';
