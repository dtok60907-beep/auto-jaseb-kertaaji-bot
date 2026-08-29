import assert from "node:assert/strict";
import test from "node:test";
import { prepareNextBroadcastTarget } from "../src/broadcast-preparation/service.ts";
import type { BroadcastPreparationRepository, BroadcastPreparationStatus } from "../src/broadcast-preparation/repository.ts";
import { TelegramAdapterError, telegramDeliveryReceipt, type TelegramDeliveryAdapter } from "../src/telegram/adapter.ts";

const lease = { accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", leaseOwner: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", accountFencingToken: 7n };
class FakeRepository implements BroadcastPreparationRepository {
  transitions: { expectedStatus: string; status: BroadcastPreparationStatus; errorCode?: string | null; retryAfterSeconds?: number | null }[] = [];
  allow = true;
  async claimNext() { return { targetId: "target-1", operationId: "operation-1", telegramTargetRef: "@lpm" }; }
  async transition(input: Parameters<BroadcastPreparationRepository["transition"]>[0]) { this.transitions.push({ expectedStatus: input.expectedStatus, status: input.status, errorCode: input.errorCode, retryAfterSeconds: input.retryAfterSeconds }); return this.allow; }
}
class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  membership: "MEMBER" | "NOT_MEMBER" | "UNKNOWN" = "MEMBER";
  entityType: "GROUP" | "SUPERGROUP" | "CHANNEL" = "SUPERGROUP";
  resolveError: unknown = null;
  joinError: unknown = null;
  joinCalls = 0;
  async connect() {}
  async disconnect() {}
  async resolveTarget(targetRef: string) { if (this.resolveError) throw this.resolveError; return { canonicalRef: targetRef, entityType: this.entityType, membership: this.membership }; }
  async joinPublicTarget() { this.joinCalls += 1; if (this.joinError) throw this.joinError; return { state: "JOINED" as const }; }
  async sendText() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
  async forwardNative() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
}

test("an existing public-group member becomes ready without joining", async () => { const repository = new FakeRepository(); const adapter = new FakeAdapter(); const result = await prepareNextBroadcastTarget(adapter, repository, lease); assert.equal(result.status, "READY"); assert.equal(adapter.joinCalls, 0); assert.deepEqual(repository.transitions, [{ expectedStatus: "CHECKING", status: "READY", errorCode: null, retryAfterSeconds: null }]); });
test("a visible public group joins immediately then becomes ready", async () => { const repository = new FakeRepository(); const adapter = new FakeAdapter(); adapter.membership = "NOT_MEMBER"; const result = await prepareNextBroadcastTarget(adapter, repository, lease); assert.equal(result.status, "READY"); assert.equal(adapter.joinCalls, 1); assert.deepEqual(repository.transitions.map((item) => item.status), ["JOINING", "READY"]); });
test("approval-required and channel targets fail with clear final states", async () => { const repository = new FakeRepository(); const adapter = new FakeAdapter(); adapter.membership = "NOT_MEMBER"; adapter.joinError = new TelegramAdapterError({ code: "JOIN_APPROVAL_REQUIRED", retryable: false }); const result = await prepareNextBroadcastTarget(adapter, repository, lease); assert.deepEqual(result, { status: "FAILED_FINAL", targetId: "target-1", errorCode: "JOIN_APPROVAL_REQUIRED", retryAfterSeconds: null }); const channelRepository = new FakeRepository(); const channelAdapter = new FakeAdapter(); channelAdapter.entityType = "CHANNEL"; assert.equal((await prepareNextBroadcastTarget(channelAdapter, channelRepository, lease)).status, "FAILED_FINAL"); assert.equal(channelRepository.transitions[0]?.errorCode, "LPM_TARGET_NOT_GROUP"); });
test("provider retry is persisted and a lost fencing token aborts preparation", async () => { const repository = new FakeRepository(); const adapter = new FakeAdapter(); adapter.resolveError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 30 }); const result = await prepareNextBroadcastTarget(adapter, repository, lease); assert.deepEqual(result, { status: "RETRYABLE", targetId: "target-1", errorCode: "FLOOD_WAIT", retryAfterSeconds: 30 }); repository.allow = false; assert.equal((await prepareNextBroadcastTarget(new FakeAdapter(), repository, lease)).status, "FENCED_OUT"); });
