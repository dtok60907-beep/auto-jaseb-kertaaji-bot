import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import type {
  ActiveApiSession,
  ApiSessionIssueInput,
  ApiSessionIssueResult,
  ApiSessionRepository,
} from "../src/auth/api-session-repository.ts";
import { hashApiSessionToken } from "../src/auth/telegram-session-issuer.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";
import type { AdminAccessRepository } from "../src/auth/admin-access-repository.ts";

const TOKEN = `jas_${"A".repeat(43)}`;
const USER_ID = "11111111-1111-4111-8111-111111111111";

class FakeSessions implements ApiSessionRepository {
  readonly hashes: Buffer[] = [];
  result: ActiveApiSession | null = Object.freeze({
    sessionId: "22222222-2222-4222-8222-222222222222",
    userId: USER_ID,
    expiresAt: "2027-01-15T20:00:00.000Z",
  });
  failure: Error | null = null;

  async issue(_input: ApiSessionIssueInput): Promise<ApiSessionIssueResult> {
    throw new Error("not used");
  }

  async findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveApiSession | null> {
    this.hashes.push(Buffer.from(tokenHash));
    if (this.failure) throw this.failure;
    return this.result;
  }
}

function app(sessions: ApiSessionRepository, seenUsers: string[] = []) {
  const broadcasts = {
    async listMaterials(userId: string) { seenUsers.push(userId); return []; },
    async listLpmTargets(userId: string) { seenUsers.push(userId); return []; },
  } as unknown as BroadcastSettingsRepository;
  return createApi({
    packages: {} as PackageRepository,
    broadcasts,
    autoComments: {} as AutoCommentSettingsRepository,
    entitlements: {} as EntitlementRepository,
    apiSessions: sessions,
    adminAccess: { findActiveByTokenHash: async () => null } as AdminAccessRepository,
  });
}

test("uses only the SHA-256 bearer hash to resolve the canonical user", async (t) => {
  const sessions = new FakeSessions();
  const seenUsers: string[] = [];
  const server = app(sessions, seenUsers);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/broadcast/settings",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { materials: [], lpmTargets: [] });
  assert.deepEqual(seenUsers, [USER_ID, USER_ID]);
  assert.equal(sessions.hashes.length, 1);
  assert.deepEqual(sessions.hashes[0], hashApiSessionToken(TOKEN));
  assert.equal(sessions.hashes[0].toString("utf8").includes(TOKEN), false);
});

test("rejects malformed authorization without querying the session store", async (t) => {
  const sessions = new FakeSessions();
  const server = app(sessions);
  t.after(() => server.close());
  const headers = [
    undefined,
    "Basic abc",
    "Bearer",
    "Bearer ",
    `Bearer  ${TOKEN}`,
    `Bearer ${TOKEN} extra`,
    `Bearer ${TOKEN}, Bearer ${TOKEN}`,
    `Bearer jas_${"A".repeat(42)}`,
    `Bearer jas_${"!".repeat(43)}`,
  ];

  for (const authorization of headers) {
    const response = await server.inject({
      method: "GET",
      url: "/v1/broadcast/settings",
      headers: authorization === undefined ? {} : { authorization },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { code: "USER_REQUIRED" });
  }
  assert.equal(sessions.hashes.length, 0);
});

test("treats unknown, expired, or revoked session lookup as unauthenticated", async (t) => {
  const sessions = new FakeSessions();
  sessions.result = null;
  const server = app(sessions);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/broadcast/settings",
    headers: { authorization: `bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { code: "USER_REQUIRED" });
  assert.equal(sessions.hashes.length, 1);
});

test("maps session dependency failures to a safe retryable response", async (t) => {
  const sessions = new FakeSessions();
  sessions.failure = new Error("database-password raw-query-detail");
  const server = app(sessions);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/broadcast/settings",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: "AUTH_TEMPORARILY_UNAVAILABLE" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes(TOKEN), false);
  assert.equal(response.body.includes("database-password"), false);
  assert.equal(response.body.includes("raw-query-detail"), false);
});

test("keeps the injected authorizer available only for legacy and isolated tests", async (t) => {
  const seenUsers: string[] = [];
  const broadcasts = {
    async listMaterials(userId: string) { seenUsers.push(userId); return []; },
    async listLpmTargets(userId: string) { seenUsers.push(userId); return []; },
  } as unknown as BroadcastSettingsRepository;
  const server = createApi({
    packages: {} as PackageRepository,
    broadcasts,
    autoComments: {} as AutoCommentSettingsRepository,
    entitlements: {} as EntitlementRepository,
    authorizeAdmin: async () => null,
    authorizeUser: async () => ({ id: USER_ID }),
  });
  t.after(() => server.close());

  const response = await server.inject({ method: "GET", url: "/v1/broadcast/settings" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seenUsers, [USER_ID, USER_ID]);
});
