-- Atomic user approval for an Auto Komen candidate.
-- An OOT decision never creates an outbox command. A Tepat decision creates exactly
-- one AUTO_COMMENT operation and one COMMENT_TEXT command under the same lock.

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
         candidate.discussion_target_ref_snapshot, candidate.template_text_snapshot
    into candidate_row
    from public.auto_comment_candidates candidate
    join public.auto_comment_divisions division on division.id = candidate.division_id
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
    jsonb_build_object('text', candidate_row.template_text_snapshot),
    p_candidate_id
  )
  returning id into created_command_id;

  return query select 'COMMENT_QUEUED'::text, p_candidate_id, created_operation_id, created_command_id;
end;
$$;

comment on function public.decide_auto_comment_candidate(uuid, uuid, text)
  is 'Locks a pending approval candidate then atomically records Tepat/OOT; Tepat creates exactly one AUTO_COMMENT outbox command.';

revoke all on function public.decide_auto_comment_candidate(uuid, uuid, text) from public;
