import assert from "node:assert/strict";
import test from "node:test";

import {
  mapTelegramAuthorizationError,
  TeleprotoAuthorizationTransport,
} from "../src/telegram-authorization/teleproto-transport.ts";

function requestCodeClient(input: Readonly<{
  sent?: Readonly<{
    emailRequired?: boolean;
    emailCodeSent?: boolean;
    phoneCodeHash?: string;
    isCodeViaApp?: boolean;
  }>;
  error?: unknown;
}>) {
  const calls: string[] = [];
  const client = {
    session: { save: () => "durable-temporary-session" },
    async connect() { calls.push("connect"); },
    async disconnect() { calls.push("disconnect"); },
    async sendCode() {
      calls.push("sendCode");
      if (input.error) throw input.error;
      return input.sent ?? {
        phoneCodeHash: "provider-private-hash",
        isCodeViaApp: true,
      };
    },
    async invoke() { throw new Error("unused"); },
    async getMe() { throw new Error("unused"); },
  };
  return { client, calls };
}

test("provider errors map to stable authorization codes without raw messages", () => {
  const fixtures = [
    ["PHONE_NUMBER_INVALID", "PHONE_NUMBER_INVALID"],
    ["PHONE_CODE_INVALID", "PHONE_CODE_INVALID"],
    ["PHONE_CODE_EXPIRED", "PHONE_CODE_EXPIRED"],
    ["PASSWORD_HASH_INVALID", "PASSWORD_INVALID"],
    ["FLOOD_WAIT_120", "TELEGRAM_RATE_LIMITED"],
    ["database-password raw provider detail", "TELEGRAM_UNAVAILABLE"],
  ] as const;
  for (const [raw, expected] of fixtures) {
    const error = mapTelegramAuthorizationError({ errorMessage: raw });
    assert.equal(error.code, expected);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: expected });
    assert.equal(String(error).includes(raw), raw === expected);
  }
});

test("transport configuration validates credentials and redacts API hash", () => {
  const hash = "ab".repeat(16);
  const transport = new TeleprotoAuthorizationTransport({ apiId: 12345, apiHash: hash });
  assert.deepEqual(JSON.parse(JSON.stringify(transport)), { redacted: true, apiId: 12345 });
  assert.equal(JSON.stringify(transport).includes(hash), false);
  assert.throws(() => new TeleprotoAuthorizationTransport({ apiId: 0, apiHash: hash }), /INVALID_TELEGRAM_API_ID/);
  assert.throws(() => new TeleprotoAuthorizationTransport({ apiId: 1, apiHash: "bad" }), /INVALID_TELEGRAM_API_HASH/);
});

test("requestCode returns bounded authorization state and disconnects the temporary client", async () => {
  const fixture = requestCodeClient({});
  const transport = new TeleprotoAuthorizationTransport({
    apiId: 12345,
    apiHash: "ab".repeat(16),
    createClient: () => fixture.client as never,
  });

  const result = await transport.requestCode("+628123456789");

  assert.deepEqual(result, {
    phoneNumber: "+628123456789",
    phoneCodeHash: "provider-private-hash",
    session: "durable-temporary-session",
    codeDelivery: "APP",
  });
  assert.deepEqual(fixture.calls, ["connect", "sendCode", "disconnect"]);
});

test("requestCode maps provider failure and still disconnects the temporary client", async () => {
  const fixture = requestCodeClient({ error: { errorMessage: "FLOOD_WAIT_90" } });
  const transport = new TeleprotoAuthorizationTransport({
    apiId: 12345,
    apiHash: "ab".repeat(16),
    createClient: () => fixture.client as never,
  });

  await assert.rejects(
    transport.requestCode("+628123456789"),
    (error: unknown) => typeof error === "object" && error !== null
      && "code" in error && error.code === "TELEGRAM_RATE_LIMITED",
  );
  assert.deepEqual(fixture.calls, ["connect", "sendCode", "disconnect"]);
});
