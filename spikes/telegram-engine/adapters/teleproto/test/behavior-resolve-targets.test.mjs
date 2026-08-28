import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapterError } from "../adapter.mjs";
import { runResolveTargets } from "../behavior-resolve-targets.mjs";

class FakeAdapter {
  constructor({ error = null } = {}) {
    this.error = error;
    this.connected = false;
    this.disconnected = false;
  }

  async connect() {
    this.connected = true;
  }

  async disconnect() {
    this.disconnected = true;
  }

  async resolveTarget() {
    if (this.error) throw this.error;
    return { entityType: "Channel" };
  }
}

test("success emits safe assertions without raw targets", async () => {
  const clocks = [0, 1, 2, 4, 7, 10];
  const adapter = new FakeAdapter();
  const result = await runResolveTargets({
    createAdapter: () => adapter,
    now: () => clocks.shift(),
    targets: {
      public_group: "@public",
      approval_group: "@approval",
      discussion_channel: "@discussion",
    },
  });

  assert.equal(result.passed, true);
  assert.equal(adapter.connected, true);
  assert.equal(adapter.disconnected, true);
  assert.equal(result.records[0].type, "metadata");
  assert.equal(result.records.at(-1).name, "all_targets_resolved");
  assert.equal(result.records.at(-1).passed, true);
  assert.deepEqual(
    result.records.filter((item) => item.type === "assertion" && item.targetRole).map((item) => item.name),
    ["public_group_resolved", "approval_group_resolved", "discussion_channel_resolved"],
  );
  assert.equal(JSON.stringify(result.records).includes("@public"), false);
});

test("failure is hard gate without raw error", async () => {
  const raw = new TelegramAdapterError("TARGET_NOT_FOUND", { retryable: false, message: "raw target detail" });
  const result = await runResolveTargets({
    createAdapter: () => new FakeAdapter({ error: raw }),
    now: () => 0,
    targets: {
      public_group: "@public",
      approval_group: "@approval",
      discussion_channel: "@discussion",
    },
  });

  assert.equal(result.passed, false);
  assert.equal(result.records.at(-1).code, "TARGET_NOT_FOUND");
  assert.equal(result.records.at(-1).hardGate, true);
  assert.equal(JSON.stringify(result.records).includes("raw target detail"), false);
});
