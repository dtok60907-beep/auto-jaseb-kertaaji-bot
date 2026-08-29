import assert from "node:assert/strict";
import test from "node:test";
import { prepareNextAutoCommentDiscussion } from "../src/auto-comment-preparation/service.ts";
import type { AutoCommentPreparationRepository, AutoCommentResolutionStatus } from "../src/auto-comment-preparation/repository.ts";
import { TelegramAdapterError, telegramDeliveryReceipt, type TelegramDeliveryAdapter } from "../src/telegram/adapter.ts";

const lease = { accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", leaseOwner: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", accountFencingToken: 9n };
class FakeRepository implements AutoCommentPreparationRepository {
  previousStatus: "QUEUED" | "NEEDS_REVALIDATION" | "WAITING_APPROVAL" = "QUEUED";
  discussionTargetRef: string | null = null;
  empty = false;
  allow = true;
  transitions: { expectedStatus: string; status: AutoCommentResolutionStatus; discussionTargetRef?: string | null; errorCode?: string | null; retryAfterSeconds?: number | null }[] = [];
  async claimNext() { return this.empty ? null : { channelTargetId: "channel-target-1", sourceChannelRef: "@menfess", discussionTargetRef: this.discussionTargetRef, previousStatus: this.previousStatus }; }
  async transition(input: Parameters<AutoCommentPreparationRepository["transition"]>[0]) { this.transitions.push({ expectedStatus: input.expectedStatus, status: input.status, discussionTargetRef: input.discussionTargetRef, errorCode: input.errorCode, retryAfterSeconds: input.retryAfterSeconds }); return this.allow; }
}
class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  sourceType: "GROUP" | "SUPERGROUP" | "CHANNEL" = "CHANNEL";
  discussionType: "GROUP" | "SUPERGROUP" | "CHANNEL" = "SUPERGROUP";
  membership: "MEMBER" | "NOT_MEMBER" | "UNKNOWN" = "MEMBER";
  linked = true;
  resolveError: unknown = null;
  joinError: unknown = null;
  joinState: "JOINED" | "ALREADY_MEMBER" | "APPROVAL_REQUESTED" = "JOINED";
  joinCalls = 0;
  linkedCalls = 0;
  async connect() {}
  async disconnect() {}
  async resolveTarget(targetRef: string) { if (this.resolveError) throw this.resolveError; return { canonicalRef: targetRef, entityType: this.discussionType, membership: this.membership }; }
  async resolveLinkedDiscussion(sourceChannelRef: string) { this.linkedCalls += 1; if (this.resolveError) throw this.resolveError; return { source: { canonicalRef: sourceChannelRef, entityType: this.sourceType, membership: "MEMBER" as const }, discussion: this.linked ? { canonicalRef: "@menfess_discussion", entityType: this.discussionType, membership: this.membership } : null }; }
  async joinPublicTarget() { this.joinCalls += 1; if (this.joinError) throw this.joinError; return { state: this.joinState }; }
  async sendText() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
  async forwardNative() { return telegramDeliveryReceipt(["1"], new Date().toISOString()); }
}

test("linked discussion already joined becomes ready without a join call", async () => { const repository = new FakeRepository(); const adapter = new FakeAdapter(); const result = await prepareNextAutoCommentDiscussion(adapter, repository, lease); assert.deepEqual(result, { status: "READY", channelTargetId: "channel-target-1", discussionTargetRef: "@menfess_discussion", errorCode: null, retryAfterSeconds: null }); assert.equal(adapter.joinCalls, 0); });
test("discussion join approval is persisted, polled without a second join, then becomes ready", async () => {
  const repository = new FakeRepository(); const adapter = new FakeAdapter(); adapter.membership = "NOT_MEMBER"; adapter.joinState = "APPROVAL_REQUESTED";
  assert.equal((await prepareNextAutoCommentDiscussion(adapter, repository, lease)).status, "WAITING_APPROVAL");
  assert.equal(adapter.joinCalls, 1);
  const poll = new FakeRepository(); poll.previousStatus = "WAITING_APPROVAL"; poll.discussionTargetRef = "@menfess_discussion";
  assert.equal((await prepareNextAutoCommentDiscussion(adapter, poll, lease)).status, "WAITING_APPROVAL");
  assert.equal(adapter.joinCalls, 1); assert.equal(adapter.linkedCalls, 1);
  adapter.membership = "MEMBER";
  assert.equal((await prepareNextAutoCommentDiscussion(adapter, poll, lease)).status, "READY");
  assert.equal(adapter.joinCalls, 1);
});
test("source and linked-discussion shape errors have distinct final codes", async () => {
  const sourceRepository = new FakeRepository(); const sourceAdapter = new FakeAdapter(); sourceAdapter.sourceType = "SUPERGROUP";
  assert.deepEqual(await prepareNextAutoCommentDiscussion(sourceAdapter, sourceRepository, lease), { status: "FAILED_FINAL", channelTargetId: "channel-target-1", discussionTargetRef: null, errorCode: "AUTO_COMMENT_SOURCE_NOT_CHANNEL", retryAfterSeconds: null });
  const missingRepository = new FakeRepository(); const missingAdapter = new FakeAdapter(); missingAdapter.linked = false;
  assert.deepEqual(await prepareNextAutoCommentDiscussion(missingAdapter, missingRepository, lease), { status: "FAILED_FINAL", channelTargetId: "channel-target-1", discussionTargetRef: null, errorCode: "DISCUSSION_NOT_LINKED", retryAfterSeconds: null });
  const invalidRepository = new FakeRepository(); const invalidAdapter = new FakeAdapter(); invalidAdapter.discussionType = "CHANNEL";
  assert.deepEqual(await prepareNextAutoCommentDiscussion(invalidAdapter, invalidRepository, lease), { status: "FAILED_FINAL", channelTargetId: "channel-target-1", discussionTargetRef: "@menfess_discussion", errorCode: "DISCUSSION_TARGET_NOT_GROUP", retryAfterSeconds: null });
});
test("approval polling keeps its state on FloodWait and fencing loss aborts persistence", async () => {
  const repository = new FakeRepository(); repository.previousStatus = "WAITING_APPROVAL"; repository.discussionTargetRef = "@menfess_discussion";
  const adapter = new FakeAdapter(); adapter.resolveError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 45 });
  const result = await prepareNextAutoCommentDiscussion(adapter, repository, lease);
  assert.equal(result.status, "WAITING_APPROVAL"); assert.equal(result.retryAfterSeconds, 45); assert.equal(repository.transitions[0]?.status, "WAITING_APPROVAL");
  const fenced = new FakeRepository(); fenced.allow = false;
  assert.equal((await prepareNextAutoCommentDiscussion(new FakeAdapter(), fenced, lease)).status, "FENCED_OUT");
});
test("no eligible channel target performs no provider operation", async () => { const repository = new FakeRepository(); repository.empty = true; const adapter = new FakeAdapter(); assert.deepEqual(await prepareNextAutoCommentDiscussion(adapter, repository, lease), { status: "NO_TARGET" }); assert.equal(adapter.linkedCalls, 0); });
