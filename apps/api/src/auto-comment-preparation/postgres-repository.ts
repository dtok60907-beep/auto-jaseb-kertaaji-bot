import type { Sql } from "postgres";
import type { AutoCommentPreparationRepository, ClaimedAutoCommentPreparation } from "./repository.ts";

type ClaimRow = {
  channel_target_id: string;
  source_channel_ref: string;
  discussion_target_ref: string | null;
  previous_status: "QUEUED" | "NEEDS_REVALIDATION" | "WAITING_APPROVAL";
};

export class PostgresAutoCommentPreparationRepository implements AutoCommentPreparationRepository {
  constructor(readonly sql: Sql) {}
  async claimNext(input: Parameters<AutoCommentPreparationRepository["claimNext"]>[0]): Promise<ClaimedAutoCommentPreparation | null> {
    const rows = await this.sql<ClaimRow[]>`
      select channel_target_id::text, source_channel_ref, discussion_target_ref, previous_status
        from public.claim_next_auto_comment_preparation(
          ${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.accountFencingToken.toString()}::bigint
        )
    `;
    const row = rows[0];
    return row ? Object.freeze({ channelTargetId: row.channel_target_id, sourceChannelRef: row.source_channel_ref, discussionTargetRef: row.discussion_target_ref, previousStatus: row.previous_status }) : null;
  }
  async transition(input: Parameters<AutoCommentPreparationRepository["transition"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ transitioned: boolean }[]>`
      select public.transition_auto_comment_preparation(
        ${input.channelTargetId}::uuid, ${input.accountId}::uuid, ${input.leaseOwner}::uuid,
        ${input.accountFencingToken.toString()}::bigint, ${input.expectedStatus}, ${input.status},
        ${input.discussionTargetRef ?? null}, ${input.errorCode ?? null}, ${input.retryAfterSeconds ?? null}
      ) transitioned
    `;
    return rows[0]?.transitioned ?? false;
  }
}
