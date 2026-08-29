import assert from "node:assert/strict";
import test from "node:test";

import { TelegramAdapterError } from "../../../packages/telegram-contract/src/index.ts";
import { mapTeleprotoError } from "../src/teleproto-error.ts";

function namedError(name: string, fields: Readonly<Record<string, unknown>> = {}): Error {
  const ProviderError = class extends Error {};
  Object.defineProperty(ProviderError, "name", { value: name });
  return Object.assign(new ProviderError("provider detail must remain private"), fields);
}

test("maps FloodWait and group-limit errors into stable public data", () => {
  assert.deepEqual(
    mapTeleprotoError(namedError("FloodWaitError", { seconds: 17 }), "SEND_TEXT").publicData(),
    { code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: 17, sideEffectState: "NOT_SENT" },
  );
  assert.deepEqual(
    mapTeleprotoError(namedError("ChannelsTooMuchError"), "JOIN").publicData(),
    { code: "ACCOUNT_GROUP_LIMIT_REACHED", retryable: false, retryAfterSeconds: null, sideEffectState: "NOT_SENT" },
  );
});

test("distinguishes target failures from source failures", () => {
  assert.equal(mapTeleprotoError(namedError("UsernameNotOccupiedError"), "RESOLVE_TARGET").code, "TARGET_NOT_FOUND");
  assert.equal(mapTeleprotoError(namedError("UsernameNotOccupiedError"), "FORWARD").code, "SOURCE_NOT_FOUND");
  assert.equal(mapTeleprotoError(namedError("MessageIdInvalidError"), "FORWARD").code, "SOURCE_NOT_FOUND");
});

test("marks network failures after mutating calls as side-effect unknown", () => {
  const afterSend = mapTeleprotoError(namedError("TimeoutError"), "SEND_TEXT");
  assert.deepEqual(afterSend.publicData(), {
    code: "TELEGRAM_TRANSIENT",
    retryable: true,
    retryAfterSeconds: null,
    sideEffectState: "UNKNOWN",
  });
  assert.equal(mapTeleprotoError(namedError("TimeoutError"), "RESOLVE_TARGET").sideEffectState, "NOT_SENT");
  assert.equal(mapTeleprotoError(namedError("UnexpectedProviderError"), "FORWARD").sideEffectState, "UNKNOWN");
  assert.equal(mapTeleprotoError(namedError("UnexpectedProviderError"), "RESOLVE_SOURCE").sideEffectState, "NOT_SENT");
});

test("preserves an already-normalized error and keeps raw detail out of public data", () => {
  const normalized = new TelegramAdapterError({ code: "CHAT_WRITE_FORBIDDEN", retryable: false });
  assert.equal(mapTeleprotoError(normalized, "SEND_TEXT"), normalized);

  const mapped = mapTeleprotoError(namedError("AuthKeyDuplicatedError", { session: "secret-session" }), "CONNECT");
  assert.equal(mapped.code, "SESSION_CONFLICT");
  assert.equal(JSON.stringify(mapped.publicData()).includes("secret"), false);
});
