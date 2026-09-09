import type { Sql } from "postgres";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../account-runner/contracts.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";

export type PruneResult = Readonly<{
  monitorEventsDeleted: number;
  autoCommentReviewsDeleted: number;
  legacyCommentMatchesDeleted: number;
  broadcastTargetsDeleted: number;
  workflowOperationsDeleted: number;
  autoCommentCandidatesDeleted: number;
  incomingChannelPostsDeleted: number;
  apiSessionsDeleted: number;
  authFlowsDeleted: number;
}>;

export interface DataRetentionSource {
  prune(input: Readonly<{ broadcastHistoryRetentionSeconds: number; internalRetentionSeconds: number }>): Promise<PruneResult>;
}

type PruneRow = {
  broadcast_targets_deleted: string | number;
  workflow_operations_deleted: string | number;
  auto_comment_candidates_deleted: string | number;
  incoming_channel_posts_deleted: string | number;
  api_sessions_deleted: string | number;
  auth_flows_deleted: string | number;
};

type AutoCommentPruneRow = {
  monitor_events_deleted: string | number;
  auto_comment_reviews_deleted: string | number;
  auto_comment_candidates_deleted: string | number;
  legacy_comment_matches_deleted: string | number;
  incoming_channel_posts_deleted: string | number;
  workflow_operations_deleted: string | number;
};

export class PostgresDataRetentionSource implements DataRetentionSource {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async prune(input: Parameters<DataRetentionSource["prune"]>[0]): Promise<PruneResult> {
    const autoCommentRows = await this.sql<AutoCommentPruneRow[]>`
      select monitor_events_deleted, auto_comment_reviews_deleted,
             auto_comment_candidates_deleted, legacy_comment_matches_deleted,
             incoming_channel_posts_deleted, workflow_operations_deleted
        from public.prune_expired_auto_comment_data(
          make_interval(secs => ${input.internalRetentionSeconds}), 5000
        )
    `;
    const rows = await this.sql<PruneRow[]>`
      select broadcast_targets_deleted, workflow_operations_deleted, auto_comment_candidates_deleted,
             incoming_channel_posts_deleted, api_sessions_deleted, auth_flows_deleted
        from public.prune_expired_operational_data(
          make_interval(secs => ${input.broadcastHistoryRetentionSeconds}),
          make_interval(secs => ${input.internalRetentionSeconds})
        )
    `;
    const autoCommentRow = autoCommentRows[0];
    const row = rows[0];
    if (!autoCommentRow || !row) throw new Error("retention function did not return a result");
    return Object.freeze({
      monitorEventsDeleted: Number(autoCommentRow.monitor_events_deleted),
      autoCommentReviewsDeleted: Number(autoCommentRow.auto_comment_reviews_deleted),
      legacyCommentMatchesDeleted: Number(autoCommentRow.legacy_comment_matches_deleted),
      broadcastTargetsDeleted: Number(row.broadcast_targets_deleted),
      workflowOperationsDeleted: Number(row.workflow_operations_deleted) + Number(autoCommentRow.workflow_operations_deleted),
      autoCommentCandidatesDeleted: Number(row.auto_comment_candidates_deleted) + Number(autoCommentRow.auto_comment_candidates_deleted),
      incomingChannelPostsDeleted: Number(row.incoming_channel_posts_deleted) + Number(autoCommentRow.incoming_channel_posts_deleted),
      apiSessionsDeleted: Number(row.api_sessions_deleted),
      authFlowsDeleted: Number(row.auth_flows_deleted),
    });
  }
}

export type DataRetentionSchedulerHandle = Readonly<{ stop(): Promise<void> }>;

const DEFAULT_TICK_INTERVAL_MILLISECONDS = 60 * 60 * 1_000;
const DEFAULT_BROADCAST_HISTORY_RETENTION_SECONDS = 3 * 24 * 60 * 60;
const DEFAULT_INTERNAL_RETENTION_SECONDS = 3 * 24 * 60 * 60;

export function startDataRetentionScheduler(input: Readonly<{
  source: DataRetentionSource;
  onPruned?: (result: PruneResult) => void;
  onFailure?: (error: unknown) => void;
  scheduler?: RuntimeRepeatingTaskScheduler;
  tickIntervalMilliseconds?: number;
  broadcastHistoryRetentionSeconds?: number;
  internalRetentionSeconds?: number;
}>): DataRetentionSchedulerHandle {
  const scheduler = input.scheduler ?? new SerialRuntimeRepeatingTaskScheduler();
  const tickIntervalMilliseconds = input.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS;
  const broadcastHistoryRetentionSeconds = input.broadcastHistoryRetentionSeconds ?? DEFAULT_BROADCAST_HISTORY_RETENTION_SECONDS;
  const internalRetentionSeconds = input.internalRetentionSeconds ?? DEFAULT_INTERNAL_RETENTION_SECONDS;

  let running: RuntimeRepeatingTaskHandle | null = scheduler.start(tickIntervalMilliseconds, async () => {
    try {
      const result = await input.source.prune({ broadcastHistoryRetentionSeconds, internalRetentionSeconds });
      input.onPruned?.(result);
    } catch (error) {
      input.onFailure?.(error);
    }
    return "CONTINUE";
  });

  return Object.freeze({
    async stop(): Promise<void> {
      const handle = running;
      running = null;
      if (handle) await handle.stop();
    },
  });
}
