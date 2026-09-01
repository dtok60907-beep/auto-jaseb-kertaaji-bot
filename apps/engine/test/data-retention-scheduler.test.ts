import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../src/account-runner/contracts.ts";
import { startDataRetentionScheduler, type DataRetentionSource, type PruneResult } from "../src/data-retention/scheduler.ts";

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

function pruneResult(overrides: Partial<PruneResult> = {}): PruneResult {
  return Object.freeze({
    broadcastTargetsDeleted: 0,
    workflowOperationsDeleted: 0,
    autoCommentCandidatesDeleted: 0,
    incomingChannelPostsDeleted: 0,
    apiSessionsDeleted: 0,
    authFlowsDeleted: 0,
    ...overrides,
  });
}

class FakeSource implements DataRetentionSource {
  result: PruneResult = pruneResult();
  error: unknown = null;
  calls: Array<Parameters<DataRetentionSource["prune"]>[0]> = [];

  async prune(input: Parameters<DataRetentionSource["prune"]>[0]): Promise<PruneResult> {
    this.calls.push(input);
    if (this.error) throw this.error;
    return this.result;
  }
}

test("each tick prunes using the configured retention windows", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();

  startDataRetentionScheduler({
    source,
    scheduler,
    broadcastHistoryRetentionSeconds: 3 * 24 * 60 * 60,
    internalRetentionSeconds: 2 * 24 * 60 * 60,
  });

  const decision = await scheduler.tick();
  assert.equal(decision, "CONTINUE");
  assert.deepEqual(source.calls, [{ broadcastHistoryRetentionSeconds: 259_200, internalRetentionSeconds: 172_800 }]);
});

test("defaults to a 3-day broadcast history window and a 2-day internal window, ticking hourly", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();

  startDataRetentionScheduler({ source, scheduler });
  await scheduler.tick();

  assert.equal(scheduler.intervalMilliseconds, 60 * 60 * 1_000);
  assert.deepEqual(source.calls, [{ broadcastHistoryRetentionSeconds: 3 * 24 * 60 * 60, internalRetentionSeconds: 2 * 24 * 60 * 60 }]);
});

test("a successful prune reports its result and a failed prune does not throw or stop the loop", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  source.result = pruneResult({ broadcastTargetsDeleted: 5, autoCommentCandidatesDeleted: 2 });
  const pruned: PruneResult[] = [];

  startDataRetentionScheduler({ source, scheduler, onPruned: (result) => pruned.push(result) });
  const decision = await scheduler.tick();

  assert.equal(decision, "CONTINUE");
  assert.deepEqual(pruned, [source.result]);

  source.error = new Error("connection reset");
  const failures: unknown[] = [];
  const secondScheduler = new FakeScheduler();
  startDataRetentionScheduler({ source, scheduler: secondScheduler, onFailure: (error) => failures.push(error) });
  const secondDecision = await secondScheduler.tick();

  assert.equal(secondDecision, "CONTINUE");
  assert.equal(failures.length, 1);
});

test("stop halts the underlying repeating task", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  const handle = startDataRetentionScheduler({ source, scheduler });

  assert.equal(scheduler.stopped, false);
  await handle.stop();
  assert.equal(scheduler.stopped, true);
});
