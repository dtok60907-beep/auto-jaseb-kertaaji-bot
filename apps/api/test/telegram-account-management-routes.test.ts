import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import { registerTelegramAccountManagementRoutes } from "../src/http/telegram-account-management-routes.ts";
import { UserbotProfileAccountError } from "../src/userbot-profiles/repository.ts";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fixture(input: Readonly<{
  authenticated?: boolean;
  attachError?: "ACCOUNT_NOT_FOUND" | "ACCOUNT_NOT_READY";
  revokeResult?: "REVOKED" | "ALREADY_REVOKED" | "NOT_FOUND";
  unavailable?: boolean;
}> = {}) {
  const calls: Array<Readonly<{ operation: string; userId: string; accountId?: string }>> = [];
  const app = Fastify({ logger: false });
  registerTelegramAccountManagementRoutes(app, {
    authorizeUser: async () => input.authenticated === false ? null : { id: USER },
    accounts: {
      async listOwnedAccounts(userId) {
        calls.push({ operation: "list", userId });
        if (input.unavailable) throw new Error("private database detail");
        return [{
          id: ACCOUNT,
          label: "@safe_account",
          status: "READY",
          active: true,
          sessionPresent: true,
          authenticatedAt: "2026-08-31T00:00:00.000Z",
          revokedAt: null,
          lastErrorCode: null,
        }];
      },
      async revokeSession(userId, accountId) {
        calls.push({ operation: "logout", userId, accountId });
        if (input.unavailable) throw new Error("private provider detail");
        return input.revokeResult ?? "REVOKED";
      },
    },
    profiles: {
      async attach(userId, accountId) {
        calls.push({ operation: "switch", userId, accountId });
        if (input.attachError) throw new UserbotProfileAccountError(input.attachError);
        if (input.unavailable) throw new Error("private database detail");
        return {
          id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          status: "CONNECTED",
          broadcastIntervalSeconds: 17,
          activeAccount: { id: accountId, label: "@safe_account", status: "READY" },
        };
      },
      async detach(userId) {
        calls.push({ operation: "detach", userId });
        if (input.unavailable) throw new Error("private database detail");
        return false;
      },
    },
  });
  return { app, calls };
}

test("account management lists safe metadata and performs switch, detach, and idempotent logout", async (t) => {
  const { app, calls } = fixture({ revokeResult: "ALREADY_REVOKED" });
  t.after(() => app.close());

  const listed = await app.inject({ method: "GET", url: "/v1/userbot/telegram-accounts" });
  const switched = await app.inject({ method: "POST", url: `/v1/userbot/telegram-accounts/${ACCOUNT}/switch` });
  const detached = await app.inject({ method: "POST", url: "/v1/userbot/telegram-accounts/detach" });
  const loggedOut = await app.inject({ method: "DELETE", url: `/v1/userbot/telegram-accounts/${ACCOUNT}/session` });

  assert.equal(listed.statusCode, 200);
  assert.equal(listed.headers["cache-control"], "no-store");
  assert.equal(JSON.stringify(listed.json()).includes("encrypted"), false);
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().profile.broadcastIntervalSeconds, 17);
  assert.equal(detached.statusCode, 204);
  assert.equal(loggedOut.statusCode, 204);
  assert.deepEqual(calls, [
    { operation: "list", userId: USER },
    { operation: "switch", userId: USER, accountId: ACCOUNT },
    { operation: "detach", userId: USER },
    { operation: "logout", userId: USER, accountId: ACCOUNT },
  ]);
});

test("account management is user-only and rejects invalid IDs or request bodies before mutation", async (t) => {
  const denied = fixture({ authenticated: false });
  const allowed = fixture();
  t.after(() => denied.app.close());
  t.after(() => allowed.app.close());

  const unauthorized = await denied.app.inject({ method: "GET", url: "/v1/userbot/telegram-accounts" });
  const invalid = await allowed.app.inject({ method: "POST", url: "/v1/userbot/telegram-accounts/not-a-uuid/switch" });
  const body = await allowed.app.inject({
    method: "DELETE",
    url: `/v1/userbot/telegram-accounts/${ACCOUNT}/session`,
    payload: { unexpected: true },
  });

  assert.deepEqual(unauthorized.json(), { code: "USER_REQUIRED" });
  assert.deepEqual(invalid.json(), { code: "INVALID_ACCOUNT_ID" });
  assert.deepEqual(body.json(), { code: "ACCOUNT_OPERATION_BODY_NOT_ALLOWED" });
  assert.deepEqual(denied.calls, []);
  assert.deepEqual(allowed.calls, []);
});

test("account management maps ownership, readiness, and dependency failures without raw detail", async (t) => {
  const missing = fixture({ attachError: "ACCOUNT_NOT_FOUND", revokeResult: "NOT_FOUND" });
  const notReady = fixture({ attachError: "ACCOUNT_NOT_READY" });
  const unavailable = fixture({ unavailable: true });
  t.after(() => missing.app.close());
  t.after(() => notReady.app.close());
  t.after(() => unavailable.app.close());

  const missingSwitch = await missing.app.inject({ method: "POST", url: `/v1/userbot/telegram-accounts/${ACCOUNT}/switch` });
  const missingLogout = await missing.app.inject({ method: "DELETE", url: `/v1/userbot/telegram-accounts/${ACCOUNT}/session` });
  const blockedSwitch = await notReady.app.inject({ method: "POST", url: `/v1/userbot/telegram-accounts/${ACCOUNT}/switch` });
  const failedList = await unavailable.app.inject({ method: "GET", url: "/v1/userbot/telegram-accounts" });

  assert.equal(missingSwitch.statusCode, 404);
  assert.deepEqual(missingSwitch.json(), { code: "ACCOUNT_NOT_FOUND" });
  assert.equal(missingLogout.statusCode, 404);
  assert.deepEqual(missingLogout.json(), { code: "ACCOUNT_NOT_FOUND" });
  assert.equal(blockedSwitch.statusCode, 409);
  assert.deepEqual(blockedSwitch.json(), { code: "ACCOUNT_NOT_READY" });
  assert.equal(failedList.statusCode, 503);
  assert.deepEqual(failedList.json(), { code: "ACCOUNT_OPERATION_UNAVAILABLE" });
  assert.equal(failedList.body.includes("private database detail"), false);
});
