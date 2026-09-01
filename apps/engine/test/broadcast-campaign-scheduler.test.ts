import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeRepeatingTaskHandle, RuntimeRepeatingTaskScheduler } from "../src/account-runner/contracts.ts";
import {
  startBroadcastCampaignScheduler,
  type BroadcastCampaignSource,
  type DueBroadcastCampaign,
} from "../src/broadcast-campaign/scheduler.ts";

class FakeScheduler implements RuntimeRepeatingTaskScheduler {
  intervalMilliseconds: number | null = null;
  task: (() => Promise<"CONTINUE" | "STOP">) | null = null;
  stopped = false;

  start(intervalMilliseconds: number, task: () => Promise<"CONTINUE" | "STOP">): RuntimeRepeatingTaskHandle {
    this.intervalMilliseconds = intervalMilliseconds;
    this.task = task;
    return Object.freeze({
      stop: async () => { this.stopped = true; },
    });
  }

  async tick(): Promise<"CONTINUE" | "STOP"> {
    if (!this.task) throw new Error("scheduler never started");
    return this.task();
  }
}

function campaign(overrides: Partial<DueBroadcastCampaign> = {}): DueBroadcastCampaign {
  return Object.freeze({
    campaignId: "campaign-1",
    userId: "user-1",
    accountMode: "USERBOT",
    materialId: "material-1",
    targetIds: Object.freeze(["target-1"]),
    cycledAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  });
}

class FakeSource implements BroadcastCampaignSource {
  dueQueue: DueBroadcastCampaign[][] = [];
  dueError: unknown = null;
  failed: Array<{ campaignId: string; errorCode: string }> = [];

  async due(): Promise<readonly DueBroadcastCampaign[]> {
    if (this.dueError) throw this.dueError;
    return Object.freeze(this.dueQueue.shift() ?? []);
  }

  async fail(campaignId: string, errorCode: string): Promise<void> {
    this.failed.push({ campaignId, errorCode });
  }
}

test("each tick runs a cycle for every due campaign", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  source.dueQueue.push([campaign({ campaignId: "a" }), campaign({ campaignId: "b" })]);
  const ran: string[] = [];

  startBroadcastCampaignScheduler({
    source,
    runCycle: async (due) => { ran.push(due.campaignId); },
    scheduler,
  });

  const decision = await scheduler.tick();
  assert.equal(decision, "CONTINUE");
  assert.deepEqual(ran, ["a", "b"]);
  assert.equal(source.failed.length, 0);
});

test("a failed cycle marks only that campaign failed and does not stop other campaigns or the loop", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  source.dueQueue.push([campaign({ campaignId: "will-fail" }), campaign({ campaignId: "will-succeed" })]);
  const ran: string[] = [];

  startBroadcastCampaignScheduler({
    source,
    runCycle: async (due) => {
      if (due.campaignId === "will-fail") throw new Error("USERBOT_NOT_CONNECTED");
      ran.push(due.campaignId);
    },
    scheduler,
  });

  const decision = await scheduler.tick();
  assert.equal(decision, "CONTINUE");
  assert.deepEqual(ran, ["will-succeed"]);
  assert.deepEqual(source.failed, [{ campaignId: "will-fail", errorCode: "USERBOT_NOT_CONNECTED" }]);
});

test("a due-lookup failure does not throw and the loop keeps going", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  source.dueError = new Error("connection reset");
  let runCalls = 0;

  startBroadcastCampaignScheduler({
    source,
    runCycle: async () => { runCalls += 1; },
    scheduler,
  });

  const decision = await scheduler.tick();
  assert.equal(decision, "CONTINUE");
  assert.equal(runCalls, 0);
});

test("stop halts the underlying repeating task", async () => {
  const scheduler = new FakeScheduler();
  const source = new FakeSource();
  const handle = startBroadcastCampaignScheduler({ source, runCycle: async () => {}, scheduler });

  assert.equal(scheduler.stopped, false);
  await handle.stop();
  assert.equal(scheduler.stopped, true);
});
