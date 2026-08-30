import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspect } from "node:util";
import test from "node:test";

import type {
  ApiSessionIssueInput,
  ApiSessionIssueResult,
  ApiSessionRepository,
} from "../src/auth/api-session-repository.ts";
import type { TelegramMiniAppIdentity } from "../src/auth/telegram-mini-app.ts";
import {
  TelegramSessionExchangeError,
  TelegramSessionIssuer,
} from "../src/auth/telegram-session-issuer.ts";

const NOW = 1_800_000_000_000;
const RAW_INIT_DATA = "auth_date=1800000000&user=signed&hash=secret-signature";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const identity: TelegramMiniAppIdentity = Object.freeze({
  telegramUserId: "900000003",
  authDateSeconds: 1_800_000_000,
  queryId: "query-id",
  firstName: "Kertaaji",
  lastName: null,
  username: "kertaaji",
  languageCode: "id",
  isPremium: false,
  allowsWriteToPm: true,
});

class FakeSessions implements ApiSessionRepository {
  readonly inputs: ApiSessionIssueInput[] = [];
  result: ApiSessionIssueResult;

  constructor(result: ApiSessionIssueResult) {
    this.result = result;
  }

  async issue(input: ApiSessionIssueInput) {
    this.inputs.push(input);
    return this.result;
  }

  async findActiveByTokenHash() { return null; }
}

function verifier() {
  return { verify(raw: string) { assert.equal(raw, RAW_INIT_DATA); return identity; } };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof TelegramSessionExchangeError ? error.code : undefined;
}

test("issues a 256-bit bearer token while persisting only independent SHA-256 hashes", async () => {
  const expiresAt = new Date(NOW + 43_200_000).toISOString();
  const sessions = new FakeSessions({ status: "CREATED", userId: USER_ID, sessionId: SESSION_ID, expiresAt });
  const entropy = Uint8Array.from({ length: 32 }, (_, index) => index);
  const issuer = new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => NOW, entropy: () => entropy });
  const issued = await issuer.exchange(RAW_INIT_DATA);

  const expectedToken = `jas_${Buffer.from(entropy).toString("base64url")}`;
  assert.deepEqual(issued, {
    accessToken: expectedToken,
    tokenType: "Bearer",
    userId: USER_ID,
    telegramUserId: identity.telegramUserId,
    expiresAt,
  });
  assert.equal(Object.isFrozen(issued), true);
  assert.equal(sessions.inputs.length, 1);
  assert.deepEqual(sessions.inputs[0].identity, identity);
  assert.equal(Buffer.from(sessions.inputs[0].tokenHash).equals(createHash("sha256").update(expectedToken).digest()), true);
  assert.equal(Buffer.from(sessions.inputs[0].initDataHash).equals(createHash("sha256").update(RAW_INIT_DATA).digest()), true);
  assert.equal(Buffer.from(sessions.inputs[0].tokenHash).includes(Buffer.from(expectedToken)), false);
  assert.equal(Buffer.from(sessions.inputs[0].initDataHash).includes(Buffer.from(RAW_INIT_DATA)), false);
  assert.deepEqual(JSON.parse(JSON.stringify(issuer)), { redacted: true, sessionTtlSeconds: 43_200 });
  assert.equal(inspect(issuer).includes(RAW_INIT_DATA), false);
});

test("rejects an already consumed initData hash without exposing the input", async () => {
  const sessions = new FakeSessions({ status: "REPLAY" });
  const issuer = new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => NOW, entropy: () => new Uint8Array(32) });
  let caught: unknown;
  try { await issuer.exchange(RAW_INIT_DATA); } catch (error) { caught = error; }
  assert.equal(errorCode(caught), "TELEGRAM_INIT_DATA_ALREADY_USED");
  assert.equal(inspect(caught).includes(RAW_INIT_DATA), false);
  assert.deepEqual(JSON.parse(JSON.stringify(caught)), { code: "TELEGRAM_INIT_DATA_ALREADY_USED" });
});

test("rejects a verified identity outside the active canary", async () => {
  const sessions = new FakeSessions({ status: "ACCESS_DENIED" });
  const issuer = new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => NOW, entropy: () => new Uint8Array(32) });
  await assert.rejects(
    issuer.exchange(RAW_INIT_DATA),
    (error) => errorCode(error) === "CANARY_ACCESS_REQUIRED",
  );
});

test("fails closed if persistence returns a different expiry boundary", async () => {
  const sessions = new FakeSessions({
    status: "CREATED",
    userId: USER_ID,
    sessionId: SESSION_ID,
    expiresAt: new Date(NOW + 43_201_000).toISOString(),
  });
  const issuer = new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => NOW, entropy: () => new Uint8Array(32) });
  await assert.rejects(issuer.exchange(RAW_INIT_DATA), /API_SESSION_EXPIRY_MISMATCH/);
});

test("fails closed for weak entropy, unsafe TTL, or invalid clock", async () => {
  const sessions = new FakeSessions({ status: "REPLAY" });
  assert.throws(() => new TelegramSessionIssuer({ verifier: verifier(), sessions, sessionTtlSeconds: 299 }), /INVALID_API_SESSION_TTL/);
  assert.throws(() => new TelegramSessionIssuer({ verifier: verifier(), sessions, sessionTtlSeconds: 604_801 }), /INVALID_API_SESSION_TTL/);
  await assert.rejects(
    new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => NOW, entropy: () => new Uint8Array(31) }).exchange(RAW_INIT_DATA),
    (error) => errorCode(error) === "API_SESSION_ENTROPY_INVALID",
  );
  await assert.rejects(
    new TelegramSessionIssuer({ verifier: verifier(), sessions, now: () => Number.NaN, entropy: () => new Uint8Array(32) }).exchange(RAW_INIT_DATA),
    /INVALID_CLOCK/,
  );
  assert.equal(sessions.inputs.length, 0);
});
