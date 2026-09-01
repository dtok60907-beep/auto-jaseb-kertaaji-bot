import assert from "node:assert/strict";
import test from "node:test";
import { createApi } from "../src/app.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastHistoryEntry, BroadcastHistoryRepository } from "../src/broadcast-history/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";

class EmptyPackages implements PackageRepository { async create(): Promise<never> { throw new Error("unused"); } async publish(): Promise<null> { return null; } async list(): Promise<readonly []> { return []; } }
class EmptyBroadcasts implements BroadcastSettingsRepository { async listMaterials(): Promise<readonly []> { return []; } async createMaterial(): Promise<never> { throw new Error("unused"); } async updateMaterial(): Promise<null> { return null; } async deleteMaterial(): Promise<boolean> { return false; } async listLpmTargets(): Promise<readonly []> { return []; } async createLpmTarget(): Promise<never> { throw new Error("unused"); } async updateLpmTarget(): Promise<null> { return null; } async deleteLpmTarget(): Promise<boolean> { return false; } }
class EmptyAutoComments implements AutoCommentSettingsRepository { async listSettings() { return { accounts: [], divisions: [], channelTargets: [] } as const; } async createDivision(): Promise<never> { throw new Error("unused"); } async updateDivision(): Promise<null> { return null; } async deleteDivision(): Promise<boolean> { return false; } async createKeyword(): Promise<null> { return null; } async deleteKeyword(): Promise<boolean> { return false; } async createTemplate(): Promise<null> { return null; } async updateTemplate(): Promise<null> { return null; } async deleteTemplate(): Promise<boolean> { return false; } async createChannelTarget(): Promise<never> { throw new Error("unused"); } async updateChannelTarget(): Promise<null> { return null; } async deleteChannelTarget(): Promise<boolean> { return false; } async attachChannel(): Promise<"NOT_FOUND"> { return "NOT_FOUND"; } async detachChannel(): Promise<boolean> { return false; } async decideCandidate(): Promise<never> { throw new Error("unused"); } }
class EmptyEntitlements implements EntitlementRepository { async grant(): Promise<never> { throw new Error("unused"); } async list(): Promise<readonly []> { return []; } async extend(): Promise<null> { return null; } async revoke(): Promise<boolean> { return false; } }

const entry: BroadcastHistoryEntry = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1",
  accountId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1",
  accountLabel: "@leaviatan",
  telegramTargetRef: "@lpmgroup",
  resolvedTitle: "Grup LPM Contoh",
  sentAt: "2026-09-01T12:00:00.000Z",
  bubbleLink: "https://t.me/lpmgroup/2",
};

class FakeHistory implements BroadcastHistoryRepository {
  seenBefore: (string | null)[] = [];
  async list(input: { userId: string; limit: number; before: string | null }) {
    this.seenBefore.push(input.before);
    if (input.before !== null) return { entries: [], nextCursor: null };
    return { entries: [entry], nextCursor: "2026-09-01T12:00:00.000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1" };
  }
}

function app(user: string | null = "user-1", history: BroadcastHistoryRepository = new FakeHistory()) {
  return createApi({
    packages: new EmptyPackages(), broadcasts: new EmptyBroadcasts(), autoComments: new EmptyAutoComments(),
    entitlements: new EmptyEntitlements(), broadcastHistory: history,
    authorizeAdmin: async () => null, authorizeUser: async () => (user ? { id: user } : null),
  });
}

test("history returns entries with a cursor and paginates on before", async (t) => {
  const history = new FakeHistory();
  const server = app("user-1", history);
  t.after(() => server.close());

  const first = await server.inject({ method: "GET", url: "/v1/broadcast/history" });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json().entries, [entry]);
  assert.equal(typeof first.json().nextCursor, "string");

  const second = await server.inject({ method: "GET", url: `/v1/broadcast/history?before=${encodeURIComponent(first.json().nextCursor)}` });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), { entries: [], nextCursor: null });
  assert.deepEqual(history.seenBefore, [null, first.json().nextCursor]);
});

test("history rejects an unauthenticated caller and an out-of-range limit", async (t) => {
  const server = app();
  const anonymous = app(null);
  t.after(() => server.close());
  t.after(() => anonymous.close());

  const denied = await anonymous.inject({ method: "GET", url: "/v1/broadcast/history" });
  assert.deepEqual(denied.json(), { code: "USER_REQUIRED" });
  assert.equal(denied.statusCode, 401);

  const invalid = await server.inject({ method: "GET", url: "/v1/broadcast/history?limit=999" });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(invalid.json(), { code: "INVALID_LIMIT" });
});
