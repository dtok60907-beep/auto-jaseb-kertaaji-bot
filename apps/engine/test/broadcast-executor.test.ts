import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramAdapterError,
  telegramDeliveryReceipt,
  type NativeForwardRequest,
  type TelegramDeliveryAdapter,
  type TelegramDeliveryReceipt,
} from "../../../packages/telegram-contract/src/index.ts";
import type { BroadcastExecutorRepository, BroadcastFinishOutcome, ClaimedBroadcastCommand } from "../src/broadcast-executor/repository.ts";
import { executeNextBroadcast } from "../src/broadcast-executor/service.ts";

const lease = { accountId: "account-1", leaseOwner: "runtime-1", fencingToken: 7n } as const;
function command(input: Partial<ClaimedBroadcastCommand> = {}): ClaimedBroadcastCommand {
  return Object.freeze({
    id: "command-1", operationId: "operation-1", accountId: lease.accountId,
    kind: "SEND_TEXT", targetRef: "@lpm", payload: { material: { kind: "TEXT", text: "promo" } },
    attemptCount: 1, fencingToken: lease.fencingToken, leaseUntil: "2030-01-01T00:00:00.000Z",
    ...input,
  });
}

class FakeRepository implements BroadcastExecutorRepository {
  claimed: ClaimedBroadcastCommand | null = command();
  finishAllowed = true;
  claimInputs: unknown[] = [];
  finishes: Array<{ commandId: string; outcome: BroadcastFinishOutcome }> = [];
  async claimNext(input: Parameters<BroadcastExecutorRepository["claimNext"]>[0]) { this.claimInputs.push(input); return this.claimed; }
  async finish(input: Parameters<BroadcastExecutorRepository["finish"]>[0]) { this.finishes.push({ commandId: input.commandId, outcome: input.outcome }); return this.finishAllowed; }
}

class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  textCalls: unknown[] = [];
  forwardCalls: NativeForwardRequest[] = [];
  error: Error | null = null;
  receipt: TelegramDeliveryReceipt = telegramDeliveryReceipt(["501"], "2030-01-01T00:00:00.000Z");
  async connect() {}
  async disconnect() {}
  async resolveTarget(): Promise<never> { throw new Error("unused"); }
  async resolveLinkedDiscussion(): Promise<never> { throw new Error("unused"); }
  async joinPublicTarget(): Promise<never> { throw new Error("unused"); }
  async sendText(input: Readonly<{ targetRef: string; text: string }>) { this.textCalls.push(input); if (this.error) throw this.error; return this.receipt; }
  async forwardNative(input: NativeForwardRequest) { this.forwardCalls.push(input); if (this.error) throw this.error; return this.receipt; }
  async listNewChannelPosts() { return []; }
  async latestChannelPostId() { return null; }
}

test("idle does not call Telegram or finish", async () => {
  const repository = new FakeRepository(); repository.claimed = null;
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease), { status: "IDLE" });
  assert.equal(adapter.textCalls.length, 0);
  assert.equal(repository.finishes.length, 0);
});

test("sends snapshotted text and persists the complete receipt", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter(); adapter.receipt = telegramDeliveryReceipt(["501", "502"], "2030-01-01T00:00:01.000Z");
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease), { status: "SUCCEEDED", commandId: "command-1" });
  assert.deepEqual(adapter.textCalls, [{ targetRef: "@lpm", text: "promo" }]);
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "SUCCEEDED", receipt: adapter.receipt });
});

test("native forward preserves source and attribution in one adapter call", async () => {
  const repository = new FakeRepository();
  repository.claimed = command({
    kind: "FORWARD_MESSAGE",
    payload: { material: { kind: "FORWARD", source: { channelUsername: "VadeMecums", messageId: 204 }, sourceAttribution: "HIDE_SOURCE" } },
  });
  const adapter = new FakeAdapter();
  await executeNextBroadcast(adapter, repository, lease);
  assert.deepEqual(adapter.forwardCalls, [{ targetRef: "@lpm", source: { channelUsername: "VadeMecums", messageId: 204 }, sourceAttribution: "HIDE_SOURCE" }]);
  assert.equal(adapter.textCalls.length, 0);
});

test("invalid payload fails final without a Telegram call", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ payload: { material: { kind: "TEXT", text: "" } } });
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease), { status: "FAILED_FINAL", commandId: "command-1", errorCode: "INVALID_BROADCAST_COMMAND_PAYLOAD" });
  assert.equal(adapter.textCalls.length, 0);
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "FAILED_FINAL", errorCode: "INVALID_BROADCAST_COMMAND_PAYLOAD" });
});

test("FloodWait uses provider seconds and is not exhausted by transient attempt limit", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ attemptCount: 99 });
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 47 });
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease, { maxTransientAttempts: 2 }), {
    status: "RETRY_SCHEDULED", commandId: "command-1", errorCode: "FLOOD_WAIT", retryAfterSeconds: 47,
  });
  adapter.error = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: -1 });
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease, { maxTransientAttempts: 2, baseRetrySeconds: 5 }), {
    status: "RETRY_SCHEDULED", commandId: "command-1", errorCode: "FLOOD_WAIT", retryAfterSeconds: 300,
  });
});

test("transient errors back off deterministically and eventually fail final", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ attemptCount: 3 });
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "TELEGRAM_TRANSIENT", retryable: true });
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease, { maxTransientAttempts: 4, baseRetrySeconds: 5 }), {
    status: "RETRY_SCHEDULED", commandId: "command-1", errorCode: "TELEGRAM_TRANSIENT", retryAfterSeconds: 20,
  });
  repository.claimed = command({ attemptCount: 4 });
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease, { maxTransientAttempts: 4 }), {
    status: "FAILED_FINAL", commandId: "command-1", errorCode: "RETRY_ATTEMPTS_EXHAUSTED",
  });
});

test("unknown side effect never enters retry", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "TELEGRAM_TRANSIENT", retryable: true, sideEffectState: "UNKNOWN" });
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease), {
    status: "SIDE_EFFECT_UNCERTAIN", commandId: "command-1", errorCode: "TELEGRAM_TRANSIENT",
  });
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "SIDE_EFFECT_UNCERTAIN", errorCode: "TELEGRAM_TRANSIENT" });
});

test("fencing loss after Telegram success is surfaced and never resent locally", async () => {
  const repository = new FakeRepository(); repository.finishAllowed = false;
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextBroadcast(adapter, repository, lease), { status: "FENCED_OUT", commandId: "command-1" });
  assert.equal(adapter.textCalls.length, 1);
});
