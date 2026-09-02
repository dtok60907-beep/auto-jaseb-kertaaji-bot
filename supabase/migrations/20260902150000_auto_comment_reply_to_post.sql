-- The comment executor sent every Auto Komen reply as a bare message into the
-- discussion group -- never threaded to the specific channel post that
-- matched, so it never showed up as an actual comment on that post. Fix at
-- the source: give the COMMENT_TEXT command's payload the source channel ref
-- and the matched post's provider id, so the engine can send it as a genuine
-- "comment to post" (via Telegram's comment-to-linked-discussion behavior)
-- instead of a plain message. Both creation paths (AUTO_SEND's immediate
-- queue, and a Tepat decision) already had this data available -- it just
-- wasn't being carried into the outbox payload.

create or replace function public.create_auto_comment_candidate(
  p_channel_target_id uuid,
  p_division_id uuid,
  p_account_id uuid,
  p_source_channel_ref text,
  p_provider_post_id text,
  p_post_content text,
  p_matched_keywords text[],
  p_selected_template_id uuid,
  p_template_text text,
  p_mode text,
  p_discussion_target_ref text
)
returns table (
  result_status text,
  candidate_id uuid,
  incoming_post_id uuid,
  operation_id uuid,
  command_id uuid
)
language plpgsql
set search_path = public
as $$
declare
  division_user_id uuid;
  post_id uuid;
  existing_candidate_id uuid;
  new_candidate_id uuid;
  created_operation_id uuid;
  created_command_id uuid;
begin
  if p_mode not in ('APPROVAL_REQUIRED', 'AUTO_SEND') then
    raise exception using errcode = '22023', message = 'mode must be APPROVAL_REQUIRED or AUTO_SEND';
  end if;

  select user_id into division_user_id
    from public.auto_comment_divisions
   where id = p_division_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'division not found';
  end if;

  insert into public.incoming_channel_posts (account_id, source_channel_ref, provider_post_id, content)
  values (p_account_id, p_source_channel_ref, p_provider_post_id, p_post_content)
  on conflict (account_id, source_channel_ref, provider_post_id) do update
     set received_at = incoming_channel_posts.received_at
  returning id into post_id;

  select candidate.id into existing_candidate_id
    from public.auto_comment_candidates candidate
   where candidate.division_id = p_division_id and candidate.incoming_post_id = post_id;
  if found then
    return query select 'ALREADY_EXISTS'::text, existing_candidate_id, post_id, null::uuid, null::uuid;
    return;
  end if;

  insert into public.auto_comment_candidates (
    division_id, channel_target_id, incoming_post_id, selected_template_id,
    template_text_snapshot, matched_keywords_snapshot, mode_snapshot,
    discussion_target_ref_snapshot, status
  )
  values (
    p_division_id, p_channel_target_id, post_id, p_selected_template_id,
    p_template_text, p_matched_keywords, p_mode, p_discussion_target_ref,
    case when p_mode = 'AUTO_SEND' then 'COMMENT_QUEUED' else 'PENDING_REVIEW' end
  )
  returning id into new_candidate_id;

  if p_mode <> 'AUTO_SEND' then
    return query select 'PENDING_REVIEW'::text, new_candidate_id, post_id, null::uuid, null::uuid;
    return;
  end if;

  insert into public.workflow_operations (
    user_id, account_id, operation_type, status, idempotency_key, payload
  )
  values (
    division_user_id, p_account_id, 'AUTO_COMMENT', 'QUEUED',
    'auto-comment:' || new_candidate_id::text,
    jsonb_build_object('candidateId', new_candidate_id::text)
  )
  returning id into created_operation_id;

  insert into public.workflow_commands (
    operation_id, account_id, kind, target_id, idempotency_key, payload,
    auto_comment_candidate_id
  )
  values (
    created_operation_id, p_account_id, 'COMMENT_TEXT', p_discussion_target_ref,
    'auto-comment-command:' || new_candidate_id::text,
    jsonb_build_object(
      'text', p_template_text,
      'sourceChannelRef', p_source_channel_ref,
      'channelPostId', p_provider_post_id
    ),
    new_candidate_id
  )
  returning id into created_command_id;

  return query select 'COMMENT_QUEUED'::text, new_candidate_id, post_id, created_operation_id, created_command_id;
end;
$$;

comment on function public.create_auto_comment_candidate(
  uuid, uuid, uuid, text, text, text, text[], uuid, text, text, text
) is 'Persists a keyword-matched post as a candidate; AUTO_SEND divisions additionally queue the AUTO_COMMENT command here (payload carries the source channel ref + post id so the engine can send it as a real comment-to-post), mirroring the Tepat branch of decide_auto_comment_candidate.';

revoke all on function public.create_auto_comment_candidate(
  uuid, uuid, uuid, text, text, text, text[], uuid, text, text, text
) from public;

create or replace function public.decide_auto_comment_candidate(
  p_candidate_id uuid,
  p_user_id uuid,
  p_decision text
)
returns table (
  result_status text,
  candidate_id uuid,
  operation_id uuid,
  command_id uuid
)
language plpgsql
set search_path = public
as $$
declare
  candidate_row record;
  created_operation_id uuid;
  created_command_id uuid;
begin
  if p_decision not in ('TEPAT', 'OOT') then
    raise exception using errcode = '22023', message = 'decision must be TEPAT or OOT';
  end if;

  select candidate.id, division.user_id, division.account_id,
         candidate.mode_snapshot, candidate.status,
         candidate.discussion_target_ref_snapshot, candidate.template_text_snapshot,
         post.source_channel_ref, post.provider_post_id
    into candidate_row
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
    join public.incoming_channel_posts post on post.id = candidate.incoming_post_id
   where candidate.id = p_candidate_id
   for update of candidate;

  if not found or candidate_row.user_id is distinct from p_user_id then
    return query select 'NOT_FOUND'::text, p_candidate_id, null::uuid, null::uuid;
    return;
  end if;

  if exists (select 1 from public.auto_comment_reviews where auto_comment_reviews.candidate_id = p_candidate_id) then
    return query select 'ALREADY_DECIDED'::text, p_candidate_id, null::uuid, null::uuid;
    return;
  end if;

  if candidate_row.mode_snapshot <> 'APPROVAL_REQUIRED'
     or candidate_row.status <> 'PENDING_REVIEW' then
    return query select 'NOT_AWAITING_REVIEW'::text, p_candidate_id, null::uuid, null::uuid;
    return;
  end if;

  if p_decision = 'OOT' then
    update public.auto_comment_candidates
       set status = 'OOT', updated_at = now()
     where id = p_candidate_id;

    insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
    values (p_candidate_id, p_user_id, 'OOT');

    return query select 'OOT'::text, p_candidate_id, null::uuid, null::uuid;
    return;
  end if;

  update public.auto_comment_candidates
     set status = 'COMMENT_QUEUED', updated_at = now()
   where id = p_candidate_id;

  insert into public.auto_comment_reviews (candidate_id, decided_by_user_id, decision)
  values (p_candidate_id, p_user_id, 'TEPAT');

  insert into public.workflow_operations (
    user_id, account_id, operation_type, status, idempotency_key, payload
  )
  values (
    p_user_id, candidate_row.account_id, 'AUTO_COMMENT', 'QUEUED',
    'auto-comment:' || p_candidate_id::text,
    jsonb_build_object('candidateId', p_candidate_id::text)
  )
  returning id into created_operation_id;

  insert into public.workflow_commands (
    operation_id, account_id, kind, target_id, idempotency_key, payload,
    auto_comment_candidate_id
  )
  values (
    created_operation_id, candidate_row.account_id, 'COMMENT_TEXT',
    candidate_row.discussion_target_ref_snapshot,
    'auto-comment-command:' || p_candidate_id::text,
    jsonb_build_object(
      'text', candidate_row.template_text_snapshot,
      'sourceChannelRef', candidate_row.source_channel_ref,
      'channelPostId', candidate_row.provider_post_id
    ),
    p_candidate_id
  )
  returning id into created_command_id;

  return query select 'COMMENT_QUEUED'::text, p_candidate_id, created_operation_id, created_command_id;
end;
$$;

comment on function public.decide_auto_comment_candidate(uuid, uuid, text)
  is 'Locks a pending approval candidate then atomically records Tepat/OOT; Tepat creates exactly one AUTO_COMMENT outbox command whose payload carries the source channel ref + post id so the engine can send it as a real comment-to-post.';

revoke all on function public.decide_auto_comment_candidate(uuid, uuid, text) from public;
