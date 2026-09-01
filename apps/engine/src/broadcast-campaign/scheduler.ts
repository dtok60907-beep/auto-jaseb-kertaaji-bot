import type { Sql } from "postgres";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../account-runner/contracts.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";

export type DueBroadcastCampaign = Readonly<{
  campaignId: string;
  userId: string;
  accountMode: "JASEB_WORKER" | "USERBOT";
  materialId: string;
  targetIds: readonly string[];
  cycledAt: string;
}>;

export interface BroadcastCampaignSource {
  due(limit: number): Promise<readonly DueBroadcastCampaign[]>;
  fail(campaignId: string, errorCode: string): Promise<void>;
}

type DueRow = {
  campaign_id: string;
  user_id: string;
  account_mode: "JASEB_WORKER" | "USERBOT";
  material_id: string;
  target_ids: string[];
  cycled_at: string;
};

export class PostgresBroadcastCampaignSource implements BroadcastCampaignSource {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async due(limit: number): Promise<readonly DueBroadcastCampaign[]> {
    const rows = await this.sql<DueRow[]>`
      select campaign_id::text, user_id::text, account_mode, material_id::text,
             target_ids::text[], cycled_at::text
        from public.due_broadcast_campaigns(${limit})
    `;
    return Object.freeze(rows.map((row): DueBroadcastCampaign => Object.freeze({
      campaignId: row.campaign_id,
      userId: row.user_id,
      accountMode: row.account_mode,
      materialId: row.material_id,
      targetIds: Object.freeze(row.target_ids),
      cycledAt: new Date(row.cycled_at).toISOString(),
    })));
  }

  async fail(campaignId: string, errorCode: string): Promise<void> {
    await this.sql`select public.fail_broadcast_campaign(${campaignId}::uuid, ${errorCode})`;
  }
}

export type BroadcastCampaignCycleRunner = (campaign: DueBroadcastCampaign) => Promise<void>;

export function createPostgresBroadcastCampaignCycleRunner(sql: Sql): BroadcastCampaignCycleRunner {
  return async (campaign) => {
    await sql`
      select public.create_broadcast_operation(
        ${campaign.userId}::uuid, ${campaign.accountMode}, ${campaign.materialId}::uuid,
        ${sql.array([...campaign.targetIds])}::uuid[],
        ${`campaign:${campaign.campaignId}:${campaign.cycledAt}`}
      )
    `;
  };
}

export type BroadcastCampaignSchedulerHandle = Readonly<{ stop(): Promise<void> }>;

const DEFAULT_TICK_INTERVAL_MILLISECONDS = 15_000;
const DEFAULT_BATCH_LIMIT = 20;

export function startBroadcastCampaignScheduler(input: Readonly<{
  source: BroadcastCampaignSource;
  runCycle: BroadcastCampaignCycleRunner;
  scheduler?: RuntimeRepeatingTaskScheduler;
  tickIntervalMilliseconds?: number;
  batchLimit?: number;
}>): BroadcastCampaignSchedulerHandle {
  const scheduler = input.scheduler ?? new SerialRuntimeRepeatingTaskScheduler();
  const tickIntervalMilliseconds = input.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;

  let running: RuntimeRepeatingTaskHandle | null = scheduler.start(tickIntervalMilliseconds, async () => {
    const due = await input.source.due(batchLimit).catch(() => Object.freeze([] as readonly DueBroadcastCampaign[]));
    for (const campaign of due) {
      try {
        await input.runCycle(campaign);
      } catch (error) {
        const errorCode = error instanceof Error && error.message ? error.message : "CAMPAIGN_CYCLE_FAILED";
        await input.source.fail(campaign.campaignId, errorCode).catch(() => undefined);
      }
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
