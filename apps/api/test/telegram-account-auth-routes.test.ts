import assert from "node:assert/strict";
import test from "node:test";

import { createApi } from "../src/app.ts";
import { TelegramAuthorizationServiceError } from "../src/telegram-authorization/service.ts";
import type { TelegramAuthorizationUseCase } from "../src/http/telegram-account-auth-routes.ts";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLOW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

class EmptyRepository {
  async list() { return []; }
  async create() { throw new Error("unused"); }
  async update() { throw new Error("unused"); }
  async remove() { return false; }
  async getSettings() { return { materials: [], lpmTargets: [] }; }
  async grant() { throw new Error("unused"); }
  async extend() { return null; }
  async revoke() { return false; }
}

class FakeAuthorization implements TelegramAuthorizationUseCase {
  failure: TelegramAuthorizationServiceError | null = null;
  calls: unknown[][] = [];
  async start(...args: [string, unknown]) {
    this.calls.push(args);
    if (this.failure) throw this.failure;
    return { status: "CODE_REQUIRED" as const, flow: { id: FLOW, status: "CODE_REQUIRED" as const, version: 3, expiresAt: "2099-01-01T00:00:00.000Z", codeDelivery: "APP" as const } };
  }
  async submitCode(...args: [string, unknown, unknown, unknown]) {
    this.calls.push(args);
    if (this.failure) throw this.failure;
    return { status: "PASSWORD_REQUIRED" as const, flow: { id: FLOW, status: "PASSWORD_REQUIRED" as const, version: 5, expiresAt: "2099-01-01T00:00:00.000Z" } };
  }
  async submitPassword(...args: [string, unknown, unknown, unknown]) {
    this.calls.push(args);
    if (this.failure) throw this.failure;
    return { status: "CONNECTED" as const, account: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "@verified" } };
  }
  async cancel(...args: [string, unknown, unknown]) { this.calls.push(args); if (this.failure) throw this.failure; }
}

function api(authorization: FakeAuthorization, authenticated = true) {
  const empty = new EmptyRepository();
  return createApi({
    packages: empty as never,
    broadcasts: empty as never,
    autoComments: empty as never,
    entitlements: empty as never,
    telegramAuthorization: authorization,
    authorizeUser: async () => authenticated ? { id: USER } : null,
    authorizeAdmin: async () => null,
  });
}

test("user-only routes expose versioned OTP and 2FA flow without returning secrets", async (t) => {
  const authorization = new FakeAuthorization();
  const server = api(authorization);
  t.after(() => server.close());
  const started = await server.inject({ method: "POST", url: "/v1/userbot/telegram-auth-flows", payload: { phoneNumber: "+628123456789" } });
  const code = await server.inject({ method: "POST", url: `/v1/userbot/telegram-auth-flows/${FLOW}/code`, payload: { version: 3, code: "12345" } });
  const password = await server.inject({ method: "POST", url: `/v1/userbot/telegram-auth-flows/${FLOW}/password`, payload: { version: 5, password: "private-password" } });
  const cancelled = await server.inject({ method: "POST", url: `/v1/userbot/telegram-auth-flows/${FLOW}/cancel`, payload: { version: 5 } });
  assert.equal(started.statusCode, 201);
  assert.equal(code.statusCode, 200);
  assert.equal(password.statusCode, 200);
  assert.equal(cancelled.statusCode, 204);
  const rendered = [started.body, code.body, password.body].join("\n");
  assert.equal(rendered.includes("12345"), false);
  assert.equal(rendered.includes("private-password"), false);
  assert.match(started.headers["cache-control"] ?? "", /no-store/);
});

test("routes require a Mini App user and exact bounded request bodies", async (t) => {
  const authorization = new FakeAuthorization();
  const denied = api(authorization, false);
  const server = api(authorization);
  t.after(() => denied.close());
  t.after(() => server.close());
  const unauthorized = await denied.inject({ method: "POST", url: "/v1/userbot/telegram-auth-flows", payload: { phoneNumber: "+628123456789" } });
  const extra = await server.inject({ method: "POST", url: "/v1/userbot/telegram-auth-flows", payload: { phoneNumber: "+628123456789", adminUserId: USER } });
  const oversized = await server.inject({ method: "POST", url: "/v1/userbot/telegram-auth-flows", payload: { phoneNumber: "x".repeat(3_000) } });
  assert.deepEqual(unauthorized.json(), { code: "USER_REQUIRED" });
  assert.equal(extra.statusCode, 422);
  assert.equal(oversized.statusCode, 413);
  assert.equal(authorization.calls.length, 0);
});

test("stable service errors map to HTTP status and never expose provider/database details", async (t) => {
  const authorization = new FakeAuthorization();
  const server = api(authorization);
  t.after(() => server.close());
  authorization.failure = new TelegramAuthorizationServiceError("PHONE_CODE_INVALID", {
    id: FLOW, status: "CODE_REQUIRED", version: 6, expiresAt: "2099-01-01T00:00:00.000Z",
  });
  const wrong = await server.inject({ method: "POST", url: `/v1/userbot/telegram-auth-flows/${FLOW}/code`, payload: { version: 5, code: "99999" } });
  assert.equal(wrong.statusCode, 422);
  assert.deepEqual(wrong.json(), {
    code: "PHONE_CODE_INVALID",
    flow: { id: FLOW, status: "CODE_REQUIRED", version: 6, expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  authorization.failure = new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
  const unavailable = await server.inject({ method: "POST", url: "/v1/userbot/telegram-auth-flows", payload: { phoneNumber: "+628123456789" } });
  assert.equal(unavailable.statusCode, 503);
  assert.equal(unavailable.body.includes("database"), false);
  assert.equal(unavailable.body.includes("provider"), false);
});
