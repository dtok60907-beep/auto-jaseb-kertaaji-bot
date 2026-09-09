import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeAccountLeaseRepository } from "../src/runtime-leases/repository.ts";
import type { CentralMonitorRepository, CentralMonitorSource } from "../src/central-monitor/repository.ts";
import { startCentralAutoCommentMonitor } from "../src/central-monitor/service.ts";
import type { CentralMonitorPost, CentralMonitorTelegramClient } from "../src/central-monitor/telegram-client.ts";

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SOURCE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() - started > 2_000) { clearInterval(timer); reject(new Error("TEST_TIMEOUT")); }
    }, 5);
  });
}

class FakeClient implements CentralMonitorTelegramClient {
  listener: ((post: CentralMonitorPost) => void) | null = null;
  connected = false;
  disconnected = false;
  latestPostId: number | null = 10;
  history: CentralMonitorPost[] = [];
  onPost(listener: (post: CentralMonitorPost) => void) { this.listener = listener; }
  async connect() { this.connected = true; }
  async disconnect() { this.disconnected = true; }
  async catchUp() {}
  async prepareSource() { return { providerPeerId: "-10042", latestPostId: this.latestPostId }; }
  async listNewPosts(_source: string, afterPostId: number, limit: number) {
    return this.history.filter((item) => item.providerPostId > afterPostId).slice(0, limit);
  }
  emit(content: string, providerPostId: number) {
    this.listener?.({ providerPeerId: "-10042", providerPostId, content, providerPostedAt: "2026-09-10T00:00:00.000Z" });
  }
}

class FakeRepository implements CentralMonitorRepository {
  source: CentralMonitorSource = Object.freeze({
    sourceId: SOURCE,
    sourceChannelRef: "@menfess",
    providerPeerId: null,
    lastPostId: null,
    divisions: Object.freeze([
      Object.freeze({
        divisionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        accountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        telegramUserId: 101,
        mode: "AUTO_SEND" as const,
        keywords: Object.freeze(["butuh desain"]),
        template: Object.freeze({ templateId: "ffffffff-ffff-4fff-8fff-ffffffffffff", text: "Kami siap membantu" }),
        channelTargetId: "11111111-1111-4111-8111-111111111111",
        discussionTargetRef: "@diskusi",
        startAfterPostId: null,
      }),
      Object.freeze({
        divisionId: "22222222-2222-4222-8222-222222222222",
        accountId: "33333333-3333-4333-8333-333333333333",
        telegramUserId: 202,
        mode: "AUTO_SEND" as const,
        keywords: Object.freeze(["lowongan kerja"]),
        template: Object.freeze({ templateId: "44444444-4444-4444-8444-444444444444", text: "Kami sedang merekrut" }),
        channelTargetId: "55555555-5555-4555-8555-555555555555",
        discussionTargetRef: "@diskusi",
        startAfterPostId: null,
      }),
    ]),
  });
  candidates: Array<{ accountId: string; keywords: readonly string[] }> = [];
  checkpoints: number[] = [];
  listener: (() => void) | null = null;

  async findActiveAccount() { return { accountId: ACCOUNT }; }
  async loadAccountSession() { return { accountId: ACCOUNT, encryptedSession: Uint8Array.from([1]), encryptionKeyVersion: 1 }; }
  async loadSources() { return [this.source]; }
  async markSourceReady(input: Parameters<CentralMonitorRepository["markSourceReady"]>[0]) {
    this.source = Object.freeze({ ...this.source, providerPeerId: input.providerPeerId });
  }
  async markSourceFailure() {}
  async advanceCheckpoint(input: Parameters<CentralMonitorRepository["advanceCheckpoint"]>[0]) { this.checkpoints.push(input.providerPostId); }
  async enqueueEvent(input: Parameters<CentralMonitorRepository["enqueueEvent"]>[0]) {
    return {
      eventId: `${input.providerPostId}`.padStart(8, "0") + "-0000-4000-8000-000000000000",
      sourceId: input.sourceId,
      sourceChannelRef: "@menfess",
      providerPostId: input.providerPostId,
      content: input.content,
      providerPostedAt: input.providerPostedAt,
    };
  }
  async listPendingEvents() { return []; }
  async finishEvent() {}
  async completeEvent(input: Parameters<CentralMonitorRepository["completeEvent"]>[0]) { this.checkpoints.push(input.providerPostId); }
  async createCandidate(input: Parameters<CentralMonitorRepository["createCandidate"]>[0]) {
    this.candidates.push({ accountId: input.division.accountId, keywords: input.matchedKeywords });
    return { status: "COMMENT_QUEUED" as const, candidateId: "66666666-6666-4666-8666-666666666666" };
  }
  async recordNotification() {}
  async recordAccountResult() { return true; }
  async subscribeChanges(listener: () => void) {
    this.listener = listener;
    return { close: async () => { this.listener = null; } };
  }
}

test("one monitor reads a channel once and routes a post only to matching buyer rules", async () => {
  const repository = new FakeRepository();
  const client = new FakeClient();
  const leases: RuntimeAccountLeaseRepository = {
    acquire: async () => ({ status: "ACQUIRED", lease: { accountId: ACCOUNT, leaseOwner: OWNER, fencingToken: 1n, leaseUntil: "2099-01-01T00:00:00.000Z" } }),
    renew: async () => ({ accountId: ACCOUNT, leaseOwner: OWNER, fencingToken: 1n, leaseUntil: "2099-01-01T00:00:00.000Z" }),
    release: async () => true,
  };
  const handle = await startCentralAutoCommentMonitor({
    repository,
    accountLeases: leases,
    sessionKeyRing: { decrypt: () => "telegram-session" },
    clientFactory: { create: () => client },
  }, { instanceId: OWNER });

  await waitFor(() => client.connected && repository.checkpoints.includes(10));
  client.emit("Halo, saya butuh desain logo hari ini", 11);
  await waitFor(() => repository.candidates.length === 1);

  assert.deepEqual(repository.candidates, [{
    accountId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    keywords: ["butuh desain"],
  }]);
  assert.ok(repository.checkpoints.includes(11));
  await handle.stop();
  assert.equal(client.disconnected, true);
});

test("shared source recovery respects each buyer target baseline", async () => {
  const repository = new FakeRepository();
  repository.source = Object.freeze({
    ...repository.source,
    lastPostId: 10,
    divisions: Object.freeze(repository.source.divisions.map((division, index) => Object.freeze({
      ...division,
      keywords: Object.freeze(["match"]),
      startAfterPostId: index === 0 ? 10 : 15,
    }))),
  });
  const client = new FakeClient();
  client.latestPostId = 16;
  client.history = [11, 16].map((providerPostId) => Object.freeze({
    providerPeerId: "-10042",
    providerPostId,
    content: "match",
    providerPostedAt: "2026-09-10T00:00:00.000Z",
  }));
  const leases: RuntimeAccountLeaseRepository = {
    acquire: async () => ({ status: "ACQUIRED", lease: { accountId: ACCOUNT, leaseOwner: OWNER, fencingToken: 1n, leaseUntil: "2099-01-01T00:00:00.000Z" } }),
    renew: async () => ({ accountId: ACCOUNT, leaseOwner: OWNER, fencingToken: 1n, leaseUntil: "2099-01-01T00:00:00.000Z" }),
    release: async () => true,
  };
  const handle = await startCentralAutoCommentMonitor({
    repository,
    accountLeases: leases,
    sessionKeyRing: { decrypt: () => "telegram-session" },
    clientFactory: { create: () => client },
  }, { instanceId: OWNER });

  await waitFor(() => repository.candidates.length === 3);
  assert.deepEqual(repository.candidates.map((candidate) => candidate.accountId), [
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "33333333-3333-4333-8333-333333333333",
  ]);
  await handle.stop();
});
