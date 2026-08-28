import assert from "node:assert/strict";
import test from "node:test";
import { TelegramAdapterError } from "../adapter.mjs";
import { runJoinPublic } from "../behavior-join-public.mjs";

class FakeAdapter {
  constructor({ state = "JOINED", error = null } = {}) {
    this.state = state;
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

  async joinPublicTarget() {
    if (this.error) throw this.error;
    return { state: this.state };
  }
}

test("join success emits safe state and disconnects", async () => {
  const adapter = new FakeAdapter();
  const result = await runJoinPublic({ createAdapter: () => adapter, target: "@public", now: () => 1 });

  assert.equal(result.passed, true);
  assert.equal(adapter.connected, true);
  assert.equal(adapter.disconnected, true);
  assert.equal(result.records.at(-1).name, "public_join_succeeded");
  assert.equal(result.records.at(-1).joinState, "JOINED");
  assert.equal(JSON.stringify(result.records).includes("@public"), false);
});

test("already-member response is a success", async () => {
  const result = await runJoinPublic({ createAdapter: () => new FakeAdapter({ state: "ALREADY_MEMBER" }), target: "@public", now: () => 0 });

  assert.equal(result.passed, true);
  assert.equal(result.records.at(-1).joinState, "ALREADY_MEMBER");
});

test("failure is a hard gate without raw error", async () => {
  const raw = new TelegramAdapterError("JOIN_APPROVAL_REQUIRED", { retryable: false, message: "raw target detail" });
  const result = await runJoinPublic({ createAdapter: () => new FakeAdapter({ error: raw }), target: "@public", now: () => 0 });

  assert.equal(result.passed, false);
  assert.equal(result.records.at(-1).code, "JOIN_APPROVAL_REQUIRED");
  assert.equal(result.records.at(-1).hardGate, true);
  assert.equal(JSON.stringify(result.records).includes("raw target detail"), false);
});
