import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../src/account-runner/contracts.ts";
import { startEntitlementExpiryScheduler, type EntitlementExpirySource } from "../src/entitlement-expiry/scheduler.ts";

class FakeScheduler implements RuntimeRepeatingTaskScheduler {
  intervalMilliseconds: number | null = null;
  task: (() => Promise<"CONTINUE" | "STOP">) | null = null;
  stopped = false;

  start(intervalMilliseconds: number, task: () => Promise<"CONTINUE" | "STOP">): RuntimeRepeatingTaskHandle {
    this.intervalMilliseconds = intervalMilliseconds;
    this.task = task;
    return Object.freeze({ stop: async () => { this.stopped = true; } });
  }

  async tick(): Promise<"CONTINUE" | "STOP"> {
    if (!this.task) throw new Error("scheduler never started");
    return this.task();
  }
}

class FakeSource implements EntitlementExpirySource {
  result = 0;
  error: unknown = null;
  calls = 0;

  async expireDue(): Promise<number> {
    this.calls += 1;
    if (this.error) throw this.error;
    return this.result;
  }
}

test("defaults to ticking every 15 minutes", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();

  startEntitlementExpiryScheduler({ source, scheduler });
  await scheduler.tick();

  assert.equal(scheduler.intervalMilliseconds, 15 * 60 * 1_000);
  assert.equal(source.calls, 1);
});

test("only reports when something actually expired", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  const expired: number[] = [];

  startEntitlementExpiryScheduler({ source, scheduler, onExpired: (count) => expired.push(count) });
  await scheduler.tick();
  assert.deepEqual(expired, []);

  source.result = 3;
  await scheduler.tick();
  assert.deepEqual(expired, [3]);
});

test("a failed sweep does not throw or stop the loop", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  source.error = new Error("connection reset");
  const failures: unknown[] = [];

  startEntitlementExpiryScheduler({ source, scheduler, onFailure: (error) => failures.push(error) });
  const decision = await scheduler.tick();

  assert.equal(decision, "CONTINUE");
  assert.equal(failures.length, 1);
});

test("stop halts the underlying repeating task", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  const handle = startEntitlementExpiryScheduler({ source, scheduler });

  assert.equal(scheduler.stopped, false);
  await handle.stop();
  assert.equal(scheduler.stopped, true);
});
