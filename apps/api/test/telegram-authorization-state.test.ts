import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTelegramAuthorizationState,
  serializeTelegramAuthorizationState,
  TelegramAuthorizationStateError,
} from "../src/telegram-authorization/state.ts";

const pending = Object.freeze({
  phoneNumber: "+628123456789",
  phoneCodeHash: "secret-code-hash",
  session: "temporary-string-session",
  codeDelivery: "APP" as const,
});

test("authorization state round-trips only the exact versioned schema", () => {
  const serialized = serializeTelegramAuthorizationState(pending);
  assert.deepEqual(parseTelegramAuthorizationState(serialized), pending);
  assert.throws(
    () => parseTelegramAuthorizationState(JSON.stringify({ version: 1, pending: { ...pending, otp: "12345" } })),
    (error) => error instanceof TelegramAuthorizationStateError,
  );
  assert.throws(
    () => parseTelegramAuthorizationState(JSON.stringify({ version: 2, pending })),
    (error) => error instanceof TelegramAuthorizationStateError,
  );
});

test("authorization state rejects malformed phone, empty session/hash, and oversized values", () => {
  for (const invalid of [
    { ...pending, phoneNumber: "081234" },
    { ...pending, phoneCodeHash: "" },
    { ...pending, session: "" },
    { ...pending, phoneCodeHash: "x".repeat(1_025) },
    { ...pending, session: "x".repeat(65_537) },
    { ...pending, codeDelivery: "EMAIL" },
  ]) {
    assert.throws(
      () => serializeTelegramAuthorizationState(invalid as typeof pending),
      (error) => error instanceof TelegramAuthorizationStateError,
    );
  }
});
