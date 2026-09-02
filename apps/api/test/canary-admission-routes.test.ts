import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import type { CanaryOperatorRepository } from "../src/operations/canary-operator.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function harness(admissions: CanaryOperatorRepository) {
  const empty = {} as never;
  const admin = createApi({
    packages: empty, broadcasts: empty, autoComments: empty, entitlements: empty, canaryAdmissions: admissions,
    authorizeUser: async () => ({ id: USER_ID }), authorizeAdmin: async () => ({ id: USER_ID }),
  });
  const normal = createApi({
    packages: empty, broadcasts: empty, autoComments: empty, entitlements: empty, canaryAdmissions: admissions,
    authorizeUser: async () => ({ id: USER_ID }), authorizeAdmin: async () => null,
  });
  return { admin, normal };
}

test("lists canary admissions for an admin only", async (t) => {
  const admissions: CanaryOperatorRepository = {
    async list() {
      return [{ telegramUserId: "123", slot: 1, admittedAt: "2026-09-02T00:00:00.000Z", revokedAt: null, appUserReady: true, adminActive: false }];
    },
    async setAdmission() { throw new Error("unused"); },
    async setAdmin() { throw new Error("unused"); },
  };
  const { admin, normal } = harness(admissions);
  t.after(async () => { await Promise.all([admin.close(), normal.close()]); });

  const listed = await admin.inject({ method: "GET", url: "/v1/admin/canary-admissions" });
  const denied = await normal.inject({ method: "GET", url: "/v1/admin/canary-admissions" });

  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().admissions[0], { telegramUserId: "123", slot: 1, admittedAt: "2026-09-02T00:00:00.000Z", revokedAt: null, appUserReady: true, adminActive: false });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), { code: "ADMIN_REQUIRED" });
});

test("admits a valid Telegram user id and rejects a malformed one", async (t) => {
  const calls: Array<{ telegramUserId: string; enabled: boolean }> = [];
  const admissions: CanaryOperatorRepository = {
    async list() { return []; },
    async setAdmission(telegramUserId, enabled) {
      calls.push({ telegramUserId, enabled });
      return { status: "ADMITTED", telegramUserId, slot: 3 };
    },
    async setAdmin() { throw new Error("unused"); },
  };
  const { admin, normal } = harness(admissions);
  t.after(async () => { await Promise.all([admin.close(), normal.close()]); });

  const admitted = await admin.inject({ method: "POST", url: "/v1/admin/canary-admissions", payload: { telegramUserId: "555" } });
  const invalid = await admin.inject({ method: "POST", url: "/v1/admin/canary-admissions", payload: { telegramUserId: "not-a-number" } });
  const denied = await normal.inject({ method: "POST", url: "/v1/admin/canary-admissions", payload: { telegramUserId: "555" } });

  assert.equal(admitted.statusCode, 200);
  assert.deepEqual(admitted.json(), { status: "ADMITTED", telegramUserId: "555", slot: 3 });
  assert.equal(invalid.statusCode, 422);
  assert.deepEqual(invalid.json(), { code: "INVALID_TELEGRAM_USER_ID" });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(calls, [{ telegramUserId: "555", enabled: true }]);
});

test("revokes a Telegram user id by path param", async (t) => {
  const calls: Array<{ telegramUserId: string; enabled: boolean }> = [];
  const admissions: CanaryOperatorRepository = {
    async list() { return []; },
    async setAdmission(telegramUserId, enabled) {
      calls.push({ telegramUserId, enabled });
      return { status: "REVOKED", telegramUserId, slot: null };
    },
    async setAdmin() { throw new Error("unused"); },
  };
  const { admin, normal } = harness(admissions);
  t.after(async () => { await Promise.all([admin.close(), normal.close()]); });

  const revoked = await admin.inject({ method: "DELETE", url: "/v1/admin/canary-admissions/555" });
  const denied = await normal.inject({ method: "DELETE", url: "/v1/admin/canary-admissions/555" });

  assert.equal(revoked.statusCode, 200);
  assert.deepEqual(revoked.json(), { status: "REVOKED", telegramUserId: "555", slot: null });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(calls, [{ telegramUserId: "555", enabled: false }]);
});
