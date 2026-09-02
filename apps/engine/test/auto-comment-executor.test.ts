import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramAdapterError,
  telegramDeliveryReceipt,
  type TelegramDeliveryAdapter,
  type TelegramDeliveryReceipt,
} from "../../../packages/telegram-contract/src/index.ts";
import type { AutoCommentExecutorRepository, AutoCommentFinishOutcome, ClaimedAutoCommentCommand } from "../src/auto-comment-executor/repository.ts";
import { executeNextAutoComment } from "../src/auto-comment-executor/service.ts";

const lease = { accountId: "account-1", leaseOwner: "runtime-1", fencingToken: 7n } as const;
function command(input: Partial<ClaimedAutoCommentCommand> = {}): ClaimedAutoCommentCommand {
  return Object.freeze({
    id: "command-1", operationId: "operation-1", accountId: lease.accountId,
    kind: "COMMENT_TEXT", targetRef: "@discussion", payload: { text: "gua ready kak pc aja" },
    attemptCount: 1, fencingToken: lease.fencingToken, leaseUntil: "2030-01-01T00:00:00.000Z",
    ...input,
  });
}

class FakeRepository implements AutoCommentExecutorRepository {
  claimed: ClaimedAutoCommentCommand | null = command();
  finishAllowed = true;
  claimInputs: unknown[] = [];
  finishes: Array<{ commandId: string; outcome: AutoCommentFinishOutcome }> = [];
  async claimNext(input: Parameters<AutoCommentExecutorRepository["claimNext"]>[0]) { this.claimInputs.push(input); return this.claimed; }
  async finish(input: Parameters<AutoCommentExecutorRepository["finish"]>[0]) { this.finishes.push({ commandId: input.commandId, outcome: input.outcome }); return this.finishAllowed; }
}

class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  textCalls: unknown[] = [];
  error: Error | null = null;
  receipt: TelegramDeliveryReceipt = telegramDeliveryReceipt(["501"], "2030-01-01T00:00:00.000Z");
  async connect() {}
  async disconnect() {}
  async resolveTarget(): Promise<never> { throw new Error("unused"); }
  async resolveLinkedDiscussion(): Promise<never> { throw new Error("unused"); }
  async joinPublicTarget(): Promise<never> { throw new Error("unused"); }
  async forwardNative(): Promise<never> { throw new Error("unused"); }
  async listNewChannelPosts() { return []; }
  async latestChannelPostId() { return null; }
  async sendText(input: Readonly<{ targetRef: string; text: string }>) { this.textCalls.push(input); if (this.error) throw this.error; return this.receipt; }
}

test("idle does not call Telegram or finish", async () => {
  const repository = new FakeRepository(); repository.claimed = null;
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), { status: "IDLE" });
  assert.equal(adapter.textCalls.length, 0);
  assert.equal(repository.finishes.length, 0);
});

test("sends the claimed reply immediately, with no interval, and persists the receipt", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter(); adapter.receipt = telegramDeliveryReceipt(["9001"], "2030-01-01T00:00:01.000Z");
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), { status: "SUCCEEDED", commandId: "command-1" });
  assert.deepEqual(adapter.textCalls, [{ targetRef: "@discussion", text: "gua ready kak pc aja" }]);
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "SUCCEEDED", receipt: adapter.receipt });
});

test("invalid payload fails final without a Telegram call", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ payload: { text: "" } });
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), { status: "FAILED_FINAL", commandId: "command-1", errorCode: "INVALID_AUTO_COMMENT_COMMAND_PAYLOAD" });
  assert.equal(adapter.textCalls.length, 0);
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "FAILED_FINAL", errorCode: "INVALID_AUTO_COMMENT_COMMAND_PAYLOAD" });
});

test("FloodWait uses provider seconds and is not exhausted by transient attempt limit", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ attemptCount: 99 });
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 47 });
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease, { maxTransientAttempts: 2 }), {
    status: "RETRY_SCHEDULED", commandId: "command-1", errorCode: "FLOOD_WAIT", retryAfterSeconds: 47,
  });
});

test("transient errors back off deterministically and eventually fail final", async () => {
  const repository = new FakeRepository(); repository.claimed = command({ attemptCount: 3 });
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "TELEGRAM_TRANSIENT", retryable: true });
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease, { maxTransientAttempts: 4, baseRetrySeconds: 5 }), {
    status: "RETRY_SCHEDULED", commandId: "command-1", errorCode: "TELEGRAM_TRANSIENT", retryAfterSeconds: 20,
  });
  repository.claimed = command({ attemptCount: 4 });
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease, { maxTransientAttempts: 4 }), {
    status: "FAILED_FINAL", commandId: "command-1", errorCode: "RETRY_ATTEMPTS_EXHAUSTED",
  });
});

test("unknown side effect never enters retry", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "TELEGRAM_TRANSIENT", retryable: true, sideEffectState: "UNKNOWN" });
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), {
    status: "SIDE_EFFECT_UNCERTAIN", commandId: "command-1", errorCode: "TELEGRAM_TRANSIENT",
  });
  assert.deepEqual(repository.finishes[0]?.outcome, { status: "SIDE_EFFECT_UNCERTAIN", errorCode: "TELEGRAM_TRANSIENT" });
});

test("fencing loss after Telegram success is surfaced and never resent locally", async () => {
  const repository = new FakeRepository(); repository.finishAllowed = false;
  const adapter = new FakeAdapter();
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), { status: "FENCED_OUT", commandId: "command-1" });
  assert.equal(adapter.textCalls.length, 1);
});

test("a chat-write-forbidden reply fails final immediately", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter(); adapter.error = new TelegramAdapterError({ code: "CHAT_WRITE_FORBIDDEN", retryable: false });
  assert.deepEqual(await executeNextAutoComment(adapter, repository, lease), {
    status: "FAILED_FINAL", commandId: "command-1", errorCode: "CHAT_WRITE_FORBIDDEN",
  });
});
