-- Persist a freshly keyword-matched channel post as an Auto Komen candidate.
-- Mirrors decide_auto_comment_candidate's transactional shape: only an AUTO_SEND
-- division creates a queued AUTO_COMMENT operation + COMMENT_TEXT command here;
-- an APPROVAL_REQUIRED candidate waits for a Tepat review to do the same.

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
    jsonb_build_object('text', p_template_text),
    new_candidate_id
  )
  returning id into created_command_id;

  return query select 'COMMENT_QUEUED'::text, new_candidate_id, post_id, created_operation_id, created_command_id;
end;
$$;

comment on function public.create_auto_comment_candidate(
  uuid, uuid, uuid, text, text, text, text[], uuid, text, text, text
) is 'Persists a keyword-matched post as a candidate; AUTO_SEND divisions additionally queue the AUTO_COMMENT command here, mirroring the Tepat branch of decide_auto_comment_candidate.';

revoke all on function public.create_auto_comment_candidate(
  uuid, uuid, uuid, text, text, text, text[], uuid, text, text, text
) from public;
