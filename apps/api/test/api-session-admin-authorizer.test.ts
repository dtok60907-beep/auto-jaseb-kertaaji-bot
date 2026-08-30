import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import type { ActiveAdminSession, AdminAccessRepository } from "../src/auth/admin-access-repository.ts";
import type { ApiSessionRepository } from "../src/auth/api-session-repository.ts";
import { hashApiSessionToken } from "../src/auth/telegram-session-issuer.ts";
import type { AutoCommentSettingsRepository } from "../src/auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "../src/broadcast/repository.ts";
import type { EntitlementRepository } from "../src/entitlements/repository.ts";
import type { PackageRepository } from "../src/packages/repository.ts";

const TOKEN = `jas_${"B".repeat(43)}`;
const ADMIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeAdminAccess implements AdminAccessRepository {
  readonly hashes: Buffer[] = [];
  result: ActiveAdminSession | null = Object.freeze({
    sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    userId: ADMIN_ID,
    expiresAt: "2027-01-15T20:00:00.000Z",
  });
  failure: Error | null = null;

  async findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveAdminSession | null> {
    this.hashes.push(Buffer.from(tokenHash));
    if (this.failure) throw this.failure;
    return this.result;
  }
}

function app(adminAccess: AdminAccessRepository, packageReads: boolean[] = []) {
  const packages = {
    async list(input: { includeInactive: boolean }) {
      packageReads.push(input.includeInactive);
      return [];
    },
  } as unknown as PackageRepository;
  const apiSessions = {
    async issue() { throw new Error("not used"); },
    async findActiveByTokenHash() { return null; },
  } as ApiSessionRepository;
  return createApi({
    packages,
    broadcasts: {} as BroadcastSettingsRepository,
    autoComments: {} as AutoCommentSettingsRepository,
    entitlements: {} as EntitlementRepository,
    apiSessions,
    adminAccess,
  });
}

test("authorizes an active admin session with one exact hash lookup", async (t) => {
  const adminAccess = new FakeAdminAccess();
  const packageReads: boolean[] = [];
  const server = app(adminAccess, packageReads);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/admin/packages",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { packages: [] });
  assert.deepEqual(packageReads, [true]);
  assert.equal(adminAccess.hashes.length, 1);
  assert.deepEqual(adminAccess.hashes[0], hashApiSessionToken(TOKEN));
});

test("denies a normal user, revoked admin, or inactive session before business access", async (t) => {
  const adminAccess = new FakeAdminAccess();
  adminAccess.result = null;
  const packageReads: boolean[] = [];
  const server = app(adminAccess, packageReads);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/admin/packages",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { code: "ADMIN_REQUIRED" });
  assert.deepEqual(packageReads, []);
  assert.equal(adminAccess.hashes.length, 1);
});

test("rejects malformed bearer input without querying admin access", async (t) => {
  const adminAccess = new FakeAdminAccess();
  const server = app(adminAccess);
  t.after(() => server.close());
  const inputs = [undefined, "Basic abc", "Bearer jas_short", `Bearer  ${TOKEN}`, `${TOKEN}`];

  for (const authorization of inputs) {
    const response = await server.inject({
      method: "GET",
      url: "/v1/admin/packages",
      headers: authorization === undefined ? {} : { authorization },
    });
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.json(), { code: "ADMIN_REQUIRED" });
  }
  assert.equal(adminAccess.hashes.length, 0);
});

test("maps admin repository outage to a safe retryable response", async (t) => {
  const adminAccess = new FakeAdminAccess();
  adminAccess.failure = new Error("database-password admin-query-detail");
  const server = app(adminAccess);
  t.after(() => server.close());

  const response = await server.inject({
    method: "GET",
    url: "/v1/admin/packages",
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), { code: "AUTH_TEMPORARILY_UNAVAILABLE" });
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.body.includes(TOKEN), false);
  assert.equal(response.body.includes("database-password"), false);
  assert.equal(response.body.includes("admin-query-detail"), false);
});
