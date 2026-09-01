import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramAdapterError,
  telegramDeliveryReceipt,
  type TelegramDeliveryAdapter,
} from "../../../packages/telegram-contract/src/index.ts";
import type {
  BroadcastPreparationRepository,
  BroadcastPreparationStatus,
} from "../src/broadcast-preparation/repository.ts";
import { prepareNextBroadcastTarget } from "../src/broadcast-preparation/service.ts";

const lease = {
  accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  leaseOwner: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  accountFencingToken: 7n,
} as const;

class FakeRepository implements BroadcastPreparationRepository {
  transitions: Array<{
    expectedStatus: string;
    status: BroadcastPreparationStatus;
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
    resolvedTitle?: string | null;
  }> = [];
  allow = true;
  previousStatus: "QUEUED" | "WAITING_APPROVAL" = "QUEUED";

  async claimNext() {
    return {
      targetId: "target-1",
      operationId: "operation-1",
      telegramTargetRef: "@lpm",
      previousStatus: this.previousStatus,
    };
  }

  async transition(input: Parameters<BroadcastPreparationRepository["transition"]>[0]) {
    this.transitions.push({
      expectedStatus: input.expectedStatus,
      status: input.status,
      errorCode: input.errorCode,
      retryAfterSeconds: input.retryAfterSeconds,
      resolvedTitle: input.resolvedTitle,
    });
    return this.allow;
  }
}

class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  membership: "MEMBER" | "NOT_MEMBER" | "UNKNOWN" = "MEMBER";
  entityType: "GROUP" | "SUPERGROUP" | "CHANNEL" = "SUPERGROUP";
  title: string | null = null;
  resolveError: unknown = null;
  joinError: unknown = null;
  joinState: "JOINED" | "ALREADY_MEMBER" | "APPROVAL_REQUESTED" = "JOINED";
  joinCalls = 0;

  async connect() {}
  async disconnect() {}
  async resolveTarget(targetRef: string) {
    if (this.resolveError) throw this.resolveError;
    return { canonicalRef: targetRef, entityType: this.entityType, membership: this.membership, title: this.title };
  }
  async resolveLinkedDiscussion(sourceChannelRef: string) {
    return {
      source: { canonicalRef: sourceChannelRef, entityType: "CHANNEL" as const, membership: "MEMBER" as const, title: null },
      discussion: { canonicalRef: "@discussion", entityType: "SUPERGROUP" as const, membership: "MEMBER" as const, title: null },
    };
  }
  async joinPublicTarget() {
    this.joinCalls += 1;
    if (this.joinError) throw this.joinError;
    return { state: this.joinState };
  }
  async sendText() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
  async forwardNative() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
  async onChannelMessage() { return () => {}; }
}

test("an existing public-group member becomes ready without joining", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.title = "Grup LPM Contoh";
  const result = await prepareNextBroadcastTarget(adapter, repository, lease);
  assert.equal(result.status, "READY");
  assert.equal(adapter.joinCalls, 0);
  assert.deepEqual(repository.transitions, [{
    expectedStatus: "CHECKING",
    status: "READY",
    errorCode: null,
    retryAfterSeconds: null,
    resolvedTitle: "Grup LPM Contoh",
  }]);
});

test("a visible public group joins immediately then becomes ready", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.membership = "NOT_MEMBER";
  const result = await prepareNextBroadcastTarget(adapter, repository, lease);
  assert.equal(result.status, "READY");
  assert.equal(adapter.joinCalls, 1);
  assert.deepEqual(repository.transitions.map((item) => item.status), ["JOINING", "READY"]);
});

test("approval-required target waits and polling never sends another join request", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.membership = "NOT_MEMBER";
  adapter.joinState = "APPROVAL_REQUESTED";
  assert.deepEqual(await prepareNextBroadcastTarget(adapter, repository, lease), {
    status: "WAITING_APPROVAL",
    targetId: "target-1",
    errorCode: "JOIN_APPROVAL_PENDING",
    retryAfterSeconds: 30,
  });
  assert.equal(adapter.joinCalls, 1);

  const pollRepository = new FakeRepository();
  pollRepository.previousStatus = "WAITING_APPROVAL";
  assert.equal((await prepareNextBroadcastTarget(adapter, pollRepository, lease)).status, "WAITING_APPROVAL");
  assert.equal(adapter.joinCalls, 1);
  assert.deepEqual(pollRepository.transitions, [{
    expectedStatus: "CHECKING",
    status: "WAITING_APPROVAL",
    errorCode: "JOIN_APPROVAL_PENDING",
    retryAfterSeconds: 30,
    resolvedTitle: null,
  }]);
});

test("an approved target becomes ready on the next membership check", async () => {
  const repository = new FakeRepository();
  repository.previousStatus = "WAITING_APPROVAL";
  const adapter = new FakeAdapter();
  adapter.membership = "MEMBER";
  const result = await prepareNextBroadcastTarget(adapter, repository, lease);
  assert.equal(result.status, "READY");
  assert.equal(adapter.joinCalls, 0);
});

test("legacy approval error maps to waiting while a channel target still fails clearly", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.membership = "NOT_MEMBER";
  adapter.joinError = new TelegramAdapterError({ code: "JOIN_APPROVAL_REQUIRED", retryable: false });
  assert.equal((await prepareNextBroadcastTarget(adapter, repository, lease)).status, "WAITING_APPROVAL");

  const channelRepository = new FakeRepository();
  const channelAdapter = new FakeAdapter();
  channelAdapter.entityType = "CHANNEL";
  assert.equal((await prepareNextBroadcastTarget(channelAdapter, channelRepository, lease)).status, "FAILED_FINAL");
  assert.equal(channelRepository.transitions[0]?.errorCode, "LPM_TARGET_NOT_GROUP");
});

test("provider retry is persisted and a lost fencing token aborts preparation", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.resolveError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 30 });
  assert.deepEqual(await prepareNextBroadcastTarget(adapter, repository, lease), {
    status: "RETRYABLE",
    targetId: "target-1",
    errorCode: "FLOOD_WAIT",
    retryAfterSeconds: 30,
  });
  repository.allow = false;
  assert.equal((await prepareNextBroadcastTarget(new FakeAdapter(), repository, lease)).status, "FENCED_OUT");
});

test("approval polling survives a transient provider error without re-enabling join", async () => {
  const repository = new FakeRepository();
  repository.previousStatus = "WAITING_APPROVAL";
  const adapter = new FakeAdapter();
  adapter.resolveError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 45 });
  const result = await prepareNextBroadcastTarget(adapter, repository, lease);
  assert.equal(result.status, "WAITING_APPROVAL");
  assert.equal(adapter.joinCalls, 0);
  assert.equal(repository.transitions[0]?.status, "WAITING_APPROVAL");
});
