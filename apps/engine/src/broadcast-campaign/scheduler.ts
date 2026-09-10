import type { Sql } from "postgres";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../account-runner/contracts.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";
import type { RuntimeWakeupSubscription } from "../runtime-accounts/repository.ts";

const CAMPAIGN_WAKEUP_CHANNEL = "jaseb_broadcast_campaigns";

export type DueBroadcastCampaign = Readonly<{
  campaignId: string;
  userId: string;
  accountMode: "JASEB_WORKER" | "USERBOT";
  materialId: string;
  targetIds: readonly string[];
  cycledAt: string;
}>;

export type CampaignReconciliation = Readonly<{
  campaignId: string;
  stopped: boolean;
  consecutiveFailures: number;
}>;

export interface BroadcastCampaignSource {
  due(limit: number): Promise<readonly DueBroadcastCampaign[]>;
  fail(campaignId: string, errorCode: string): Promise<void>;
  reconcile(limit: number, failureThreshold: number): Promise<readonly CampaignReconciliation[]>;
  nextDueAt?(): Promise<string | null>;
  subscribeWakeups?(listener: () => void): Promise<RuntimeWakeupSubscription>;
}

type DueRow = {
  campaign_id: string;
  user_id: string;
  account_mode: "JASEB_WORKER" | "USERBOT";
  material_id: string;
  target_ids: string[];
  cycled_at: string;
};

type ReconcileRow = {
  out_campaign_id: string;
  out_stopped: boolean;
  out_consecutive_failures: number;
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

  async reconcile(limit: number, failureThreshold: number): Promise<readonly CampaignReconciliation[]> {
    const rows = await this.sql<ReconcileRow[]>`
      select out_campaign_id::text, out_stopped, out_consecutive_failures
        from public.reconcile_broadcast_campaigns(${limit}, ${failureThreshold})
    `;
    return Object.freeze(rows.map((row): CampaignReconciliation => Object.freeze({
      campaignId: row.out_campaign_id,
      stopped: row.out_stopped,
      consecutiveFailures: row.out_consecutive_failures,
    })));
  }

  async nextDueAt(): Promise<string | null> {
    const rows = await this.sql<{ next_due_at: Date | string | null }[]>`
      select public.next_broadcast_campaign_due_at() next_due_at
    `;
    const value = rows[0]?.next_due_at;
    if (value === null || value === undefined) return null;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error("INVALID_CAMPAIGN_DUE_AT");
    return parsed.toISOString();
  }

  async subscribeWakeups(listener: () => void): Promise<RuntimeWakeupSubscription> {
    const handle = await this.sql.listen(CAMPAIGN_WAKEUP_CHANNEL, () => listener());
    return Object.freeze({ close: () => handle.unlisten() });
  }
}

export type BroadcastCampaignCycleRunner = (campaign: DueBroadcastCampaign) => Promise<void>;

export function createPostgresBroadcastCampaignCycleRunner(sql: Sql): BroadcastCampaignCycleRunner {
  return async (campaign) => {
    await sql`
      select public.create_broadcast_campaign_cycle(
        ${campaign.campaignId}::uuid,
        ${campaign.cycledAt}::timestamptz
      )
    `;
  };
}

export type BroadcastCampaignSchedulerHandle = Readonly<{ stop(): Promise<void> }>;

const DEFAULT_TICK_INTERVAL_MILLISECONDS = 15_000;
const DEFAULT_RECONCILIATION_INTERVAL_MILLISECONDS = 300_000;
const DEFAULT_SUBSCRIPTION_RETRY_MILLISECONDS = 5_000;
const DEFAULT_BATCH_LIMIT = 20;
const DEFAULT_FAILURE_THRESHOLD = 3;

class CoalescingSignal {
  #pending = false;
  #waiter: (() => void) | null = null;

  notify(): void {
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = null;
      waiter();
    } else {
      this.#pending = true;
    }
  }

  async wait(milliseconds: number): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.#waiter === finish) this.#waiter = null;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, milliseconds));
      this.#waiter = finish;
      if (this.#pending) {
        this.#pending = false;
        finish();
      }
    });
  }
}

async function processCampaigns(
  source: BroadcastCampaignSource,
  runCycle: BroadcastCampaignCycleRunner,
  batchLimit: number,
  failureThreshold: number,
): Promise<void> {
  await source.reconcile(batchLimit, failureThreshold)
    .catch(() => Object.freeze([] as readonly CampaignReconciliation[]));

  const due = await source.due(batchLimit)
    .catch(() => Object.freeze([] as readonly DueBroadcastCampaign[]));
  for (const campaign of due) {
    try {
      await runCycle(campaign);
    } catch (error) {
      const errorCode = error instanceof Error && error.message
        ? error.message
        : "CAMPAIGN_CYCLE_FAILED";
      await source.fail(campaign.campaignId, errorCode).catch(() => undefined);
    }
  }
}

function startEventDrivenBroadcastCampaignScheduler(input: Readonly<{
  source: BroadcastCampaignSource & Required<Pick<BroadcastCampaignSource, "nextDueAt" | "subscribeWakeups">>;
  runCycle: BroadcastCampaignCycleRunner;
  batchLimit: number;
  failureThreshold: number;
  reconciliationIntervalMilliseconds: number;
  subscriptionRetryMilliseconds: number;
}>): BroadcastCampaignSchedulerHandle {
  const signal = new CoalescingSignal();
  let running = true;
  let subscription: RuntimeWakeupSubscription | null = null;
  let nextSubscriptionAttemptAt = 0;

  const ensureSubscription = async (): Promise<void> => {
    if (!running || subscription || Date.now() < nextSubscriptionAttemptAt) return;
    try {
      const connected = await input.source.subscribeWakeups(() => signal.notify());
      if (!running) {
        await connected.close().catch(() => undefined);
        return;
      }
      subscription = connected;
    } catch {
      nextSubscriptionAttemptAt = Date.now() + input.subscriptionRetryMilliseconds;
    }
  };

  const loopPromise = (async () => {
    while (running) {
      await ensureSubscription();
      await processCampaigns(input.source, input.runCycle, input.batchLimit, input.failureThreshold);
      if (!running) break;

      let delay = input.reconciliationIntervalMilliseconds;
      try {
        const dueAt = await input.source.nextDueAt();
        if (dueAt !== null) {
          delay = Math.max(1, Math.min(delay, Date.parse(dueAt) - Date.now()));
        }
      } catch {
        // Durable reconciliation remains the fallback if deadline lookup fails.
      }
      if (!subscription) {
        delay = Math.max(1, Math.min(delay, nextSubscriptionAttemptAt - Date.now()));
      }
      await signal.wait(delay);
    }
  })();

  return Object.freeze({
    async stop(): Promise<void> {
      if (!running) return loopPromise;
      running = false;
      signal.notify();
      if (subscription) await subscription.close().catch(() => undefined);
      subscription = null;
      await loopPromise;
    },
  });
}

export function startBroadcastCampaignScheduler(input: Readonly<{
  source: BroadcastCampaignSource;
  runCycle: BroadcastCampaignCycleRunner;
  scheduler?: RuntimeRepeatingTaskScheduler;
  tickIntervalMilliseconds?: number;
  reconciliationIntervalMilliseconds?: number;
  subscriptionRetryMilliseconds?: number;
  batchLimit?: number;
  failureThreshold?: number;
}>): BroadcastCampaignSchedulerHandle {
  const scheduler = input.scheduler ?? new SerialRuntimeRepeatingTaskScheduler();
  const tickIntervalMilliseconds = input.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS;
  const batchLimit = input.batchLimit ?? DEFAULT_BATCH_LIMIT;
  const failureThreshold = input.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

  if (input.source.nextDueAt && input.source.subscribeWakeups) {
    return startEventDrivenBroadcastCampaignScheduler({
      source: input.source as BroadcastCampaignSource & Required<Pick<BroadcastCampaignSource, "nextDueAt" | "subscribeWakeups">>,
      runCycle: input.runCycle,
      batchLimit,
      failureThreshold,
      reconciliationIntervalMilliseconds: input.reconciliationIntervalMilliseconds
        ?? DEFAULT_RECONCILIATION_INTERVAL_MILLISECONDS,
      subscriptionRetryMilliseconds: input.subscriptionRetryMilliseconds
        ?? DEFAULT_SUBSCRIPTION_RETRY_MILLISECONDS,
    });
  }

  let running: RuntimeRepeatingTaskHandle | null = scheduler.start(tickIntervalMilliseconds, async () => {
    await processCampaigns(input.source, input.runCycle, batchLimit, failureThreshold);
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
