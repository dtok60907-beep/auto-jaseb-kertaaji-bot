import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramAdapterError,
  type IncomingChannelMessage,
  type TelegramDeliveryAdapter,
} from "../../../packages/telegram-contract/src/index.ts";
import { checkNextAutoCommentChannel } from "../src/auto-comment-matcher/service.ts";
import type {
  AutoCommentMatcherRepository,
  ClaimedAutoCommentMonitoringTarget,
  CreateCandidateResult,
  DivisionMatchConfig,
} from "../src/auto-comment-matcher/repository.ts";

const lease = {
  accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  leaseOwner: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  accountFencingToken: 7n,
} as const;

function division(overrides: Partial<DivisionMatchConfig> = {}): DivisionMatchConfig {
  return Object.freeze({
    divisionId: "division-1",
    accountId: lease.accountId,
    name: "Divisi promo",
    mode: "AUTO_SEND",
    keywords: Object.freeze(["promo"]),
    templates: Object.freeze([Object.freeze({ templateId: "template-1", text: "Komentar promo otomatis" })]),
    ...overrides,
  });
}

class FakeRepository implements AutoCommentMatcherRepository {
  claim: ClaimedAutoCommentMonitoringTarget | null = Object.freeze({
    channelTargetId: "channel-target-1",
    sourceChannelRef: "@menfess",
    discussionTargetRef: "@menfess_discussion",
    monitoringLastPostId: 100,
  });
  divisions: readonly DivisionMatchConfig[] = Object.freeze([division()]);
  createResult: CreateCandidateResult = Object.freeze({ status: "COMMENT_QUEUED", candidateId: "candidate-1" });
  advanceResult = true;

  claimCalls = 0;
  divisionsCalls: string[] = [];
  createCalls: Array<Parameters<AutoCommentMatcherRepository["createCandidate"]>[0]> = [];
  advanceCalls: Array<Parameters<AutoCommentMatcherRepository["advanceCheckpoint"]>[0]> = [];

  async claimNext() {
    this.claimCalls += 1;
    return this.claim;
  }
  async divisionsFor(channelTargetId: string) {
    this.divisionsCalls.push(channelTargetId);
    return this.divisions;
  }
  async createCandidate(input: Parameters<AutoCommentMatcherRepository["createCandidate"]>[0]) {
    this.createCalls.push(input);
    return this.createResult;
  }
  async advanceCheckpoint(input: Parameters<AutoCommentMatcherRepository["advanceCheckpoint"]>[0]) {
    this.advanceCalls.push(input);
    return this.advanceResult;
  }
}

class FakeAdapter implements TelegramDeliveryAdapter {
  readonly state = "READY" as const;
  posts: readonly IncomingChannelMessage[] = [];
  latest: string | null = "500";
  postsError: unknown = null;
  latestError: unknown = null;
  listCalls: Array<Readonly<{ channelRef: string; afterMessageId: number; limit: number }>> = [];
  latestCalls: string[] = [];

  async connect() {}
  async disconnect() {}
  async resolveTarget(): Promise<never> { throw new Error("unused"); }
  async resolveLinkedDiscussion(): Promise<never> { throw new Error("unused"); }
  async joinPublicTarget(): Promise<never> { throw new Error("unused"); }
  async sendText(): Promise<never> { throw new Error("unused"); }
  async forwardNative(): Promise<never> { throw new Error("unused"); }
  async listNewChannelPosts(channelRef: string, input: Readonly<{ afterMessageId: number; limit: number }>) {
    this.listCalls.push({ channelRef, ...input });
    if (this.postsError) throw this.postsError;
    return this.posts;
  }
  async latestChannelPostId(channelRef: string) {
    this.latestCalls.push(channelRef);
    if (this.latestError) throw this.latestError;
    return this.latest;
  }
}

function post(channelPostId: string, text: string): IncomingChannelMessage {
  return Object.freeze({ channelPostId, text });
}

test("no due target is a no-op", async () => {
  const repository = new FakeRepository();
  repository.claim = null;
  const adapter = new FakeAdapter();
  assert.deepEqual(await checkNextAutoCommentChannel(adapter, repository, lease), { status: "NO_TARGET" });
  assert.equal(adapter.listCalls.length, 0);
});

test("a fresh target seeds its checkpoint at the current latest post without scanning history", async () => {
  const repository = new FakeRepository();
  repository.claim = Object.freeze({ ...repository.claim!, monitoringLastPostId: null });
  const adapter = new FakeAdapter();
  adapter.latest = "777";

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.deepEqual(outcome, { status: "CHECKED", channelTargetId: "channel-target-1", errorCode: null, retryAfterSeconds: null, postsScanned: 0, candidatesCreated: 0 });
  assert.deepEqual(adapter.latestCalls, ["@menfess"]);
  assert.equal(adapter.listCalls.length, 0);
  assert.deepEqual(repository.advanceCalls, [{ ...lease, channelTargetId: "channel-target-1", lastPostId: 777 }]);
});

test("seeding an empty channel leaves the checkpoint untouched", async () => {
  const repository = new FakeRepository();
  repository.claim = Object.freeze({ ...repository.claim!, monitoringLastPostId: null });
  const adapter = new FakeAdapter();
  adapter.latest = null;

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.equal(outcome.status, "CHECKED");
  assert.equal(repository.advanceCalls.length, 0);
});

test("no new posts is a checked action that never queries divisions", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.posts = [];

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.deepEqual(outcome, { status: "CHECKED", channelTargetId: "channel-target-1", errorCode: null, retryAfterSeconds: null, postsScanned: 0, candidatesCreated: 0 });
  assert.deepEqual(adapter.listCalls, [{ channelRef: "@menfess", afterMessageId: 100, limit: 20 }]);
  assert.equal(repository.divisionsCalls.length, 0);
  assert.equal(repository.advanceCalls.length, 0);
});

test("a matched keyword queues a candidate and advances the checkpoint to the newest post", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.posts = [post("101", "cari admin promo dong"), post("102", "obrolan biasa")];

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.deepEqual(outcome, { status: "CHECKED", channelTargetId: "channel-target-1", errorCode: null, retryAfterSeconds: null, postsScanned: 2, candidatesCreated: 1 });
  assert.equal(repository.createCalls.length, 1);
  assert.deepEqual(repository.createCalls[0], {
    channelTargetId: "channel-target-1",
    divisionId: "division-1",
    accountId: lease.accountId,
    sourceChannelRef: "@menfess",
    providerPostId: "101",
    postContent: "cari admin promo dong",
    matchedKeywords: ["promo"],
    selectedTemplateId: "template-1",
    templateText: "Komentar promo otomatis",
    mode: "AUTO_SEND",
    discussionTargetRef: "@menfess_discussion",
  });
  assert.deepEqual(repository.advanceCalls, [{ ...lease, channelTargetId: "channel-target-1", lastPostId: 102 }]);
});

test("a re-observed post is idempotent: it does not count as a newly created candidate", async () => {
  const repository = new FakeRepository();
  repository.createResult = Object.freeze({ status: "ALREADY_EXISTS", candidateId: "candidate-1" });
  const adapter = new FakeAdapter();
  adapter.posts = [post("101", "cari admin promo dong")];

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);
  assert.equal(outcome.status, "CHECKED");
  if (outcome.status === "CHECKED") assert.equal(outcome.candidatesCreated, 0);
  assert.equal(repository.createCalls.length, 1);
});

test("posts that match no division keyword and empty posts still advance the checkpoint without creating candidates", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.posts = [post("101", "obrolan biasa"), post("102", "")];

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.equal(outcome.status, "CHECKED");
  if (outcome.status === "CHECKED") assert.equal(outcome.candidatesCreated, 0);
  assert.equal(repository.createCalls.length, 0);
  assert.deepEqual(repository.advanceCalls, [{ ...lease, channelTargetId: "channel-target-1", lastPostId: 102 }]);
});

test("a division with no active template never creates a candidate even on a keyword match", async () => {
  const repository = new FakeRepository();
  repository.divisions = Object.freeze([division({ templates: Object.freeze([]) })]);
  const adapter = new FakeAdapter();
  adapter.posts = [post("101", "cari admin promo dong")];

  const outcome = await checkNextAutoCommentChannel(adapter, repository, lease);

  assert.equal(outcome.status, "CHECKED");
  assert.equal(repository.createCalls.length, 0);
});

test("checkpoint advance rejection surfaces as fenced out", async () => {
  const repository = new FakeRepository();
  repository.advanceResult = false;
  const adapter = new FakeAdapter();
  adapter.posts = [post("101", "obrolan biasa")];

  assert.deepEqual(await checkNextAutoCommentChannel(adapter, repository, lease), {
    status: "FENCED_OUT", channelTargetId: "channel-target-1", errorCode: "MONITORING_FENCED", retryAfterSeconds: null, postsScanned: 1, candidatesCreated: 0,
  });
});

test("a transient provider error is retryable and a revoked session is not", async () => {
  const repository = new FakeRepository();
  const adapter = new FakeAdapter();
  adapter.postsError = new TelegramAdapterError({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 42 });
  assert.deepEqual(await checkNextAutoCommentChannel(adapter, repository, lease), {
    status: "RETRYABLE", channelTargetId: "channel-target-1", errorCode: "FLOOD_WAIT", retryAfterSeconds: 42, postsScanned: 0, candidatesCreated: 0,
  });

  const revokedRepository = new FakeRepository();
  const revokedAdapter = new FakeAdapter();
  revokedAdapter.postsError = new TelegramAdapterError({ code: "SESSION_REVOKED", retryable: false });
  assert.deepEqual(await checkNextAutoCommentChannel(revokedAdapter, revokedRepository, lease), {
    status: "FAILED", channelTargetId: "channel-target-1", errorCode: "SESSION_REVOKED", retryAfterSeconds: null, postsScanned: 0, candidatesCreated: 0,
  });
});
