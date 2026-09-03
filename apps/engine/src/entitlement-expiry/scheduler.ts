import type { Sql } from "postgres";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../account-runner/contracts.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";

export interface EntitlementExpirySource {
  expireDue(): Promise<number>;
}

export class PostgresEntitlementExpirySource implements EntitlementExpirySource {
  readonly sql: Sql;
  constructor(sql: Sql) { this.sql = sql; }

  async expireDue(): Promise<number> {
    const rows = await this.sql<{ count: string | number }[]>`select public.expire_due_entitlements() as count`;
    return Number(rows[0]?.count ?? 0);
  }
}

export type EntitlementExpirySchedulerHandle = Readonly<{ stop(): Promise<void> }>;

// Expiry is checked in whole-day units (durationDays), so being up to this
// far behind a lapse before the cascade (disconnect + cancel queued work)
// runs is an acceptable, cheap default -- see the "why 15 minutes, not
// tied to each entitlement's own expires_at" discussion this was chosen
// from: a single sweep query costs the same either way, since it always
// covers every user in one pass rather than one query per account.
const DEFAULT_TICK_INTERVAL_MILLISECONDS = 15 * 60 * 1_000;

export function startEntitlementExpiryScheduler(input: Readonly<{
  source: EntitlementExpirySource;
  onExpired?: (count: number) => void;
  onFailure?: (error: unknown) => void;
  scheduler?: RuntimeRepeatingTaskScheduler;
  tickIntervalMilliseconds?: number;
}>): EntitlementExpirySchedulerHandle {
  const scheduler = input.scheduler ?? new SerialRuntimeRepeatingTaskScheduler();
  const tickIntervalMilliseconds = input.tickIntervalMilliseconds ?? DEFAULT_TICK_INTERVAL_MILLISECONDS;

  let running: RuntimeRepeatingTaskHandle | null = scheduler.start(tickIntervalMilliseconds, async () => {
    try {
      const count = await input.source.expireDue();
      if (count > 0) input.onExpired?.(count);
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
