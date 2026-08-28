import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapterError } from "../adapter.mjs";
import { runConnectSamples } from "../benchmark-connect.mjs";

class FakeAdapter {
  constructor({ error = null } = {}) {
    this.error = error;
    this.connectCalls = 0;
    this.disconnectCalls = 0;
  }

  async connect() {
    this.connectCalls += 1;
    if (this.error) throw this.error;
  }

  async disconnect() {
    this.disconnectCalls += 1;
  }
}

test("success emits shared JSONL metadata, samples, and hard assertion", async () => {
  const clocks = [0, 1.5, 2, 5];
  const adapters = [];
  const result = await runConnectSamples({
    runs: 2,
    now: () => clocks.shift(),
    createAdapter: () => {
      const adapter = new FakeAdapter();
      adapters.push(adapter);
      return adapter;
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.records[0].type, "metadata");
  assert.equal(result.records[0].candidate, "teleproto");
  assert.deepEqual(result.records.filter((record) => record.type === "sample").map((record) => record.value), [1.5, 3]);
  assert.deepEqual(result.records.at(-1), {
    type: "assertion",
    candidate: "teleproto",
    scenario: "connect_authorized_disconnect",
    name: "all_iterations_passed",
    passed: true,
    hardGate: true,
  });
  assert.deepEqual(adapters.map((item) => [item.connectCalls, item.disconnectCalls]), [[1, 1], [1, 1]]);
});

test("failure becomes a hard assertion without raw detail", async () => {
  const raw = new TelegramAdapterError("FLOOD_WAIT", { retryable: true, message: "secret detail must not escape" });
  const result = await runConnectSamples({ runs: 1, now: () => 0, createAdapter: () => new FakeAdapter({ error: raw }) });

  assert.equal(result.passed, false);
  assert.equal(result.records.at(-1).code, "FLOOD_WAIT");
  assert.equal(result.records.at(-1).hardGate, true);
  assert.equal(JSON.stringify(result.records).includes("secret detail"), false);
});

test("invalid run count is rejected", async () => {
  await assert.rejects(runConnectSamples({ runs: 0, createAdapter: () => new FakeAdapter() }), /runs must be an integer/);
});

test("default clock works with Node performance binding", async () => {
  const result = await runConnectSamples({
    runs: 1,
    createAdapter: () => new FakeAdapter(),
  });

  assert.equal(result.passed, true);
  assert.equal(result.records.at(-1).passed, true);
});
