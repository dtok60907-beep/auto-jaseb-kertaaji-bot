import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import {
  TelegramSessionCryptoError,
  TelegramSessionKeyRing,
  type TelegramSessionContext,
} from "../../../packages/telegram-session-crypto/src/index.ts";

const ACCOUNT: TelegramSessionContext = Object.freeze({
  accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  accountType: "USERBOT",
});
const OTHER_ACCOUNT: TelegramSessionContext = Object.freeze({
  accountId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  accountType: "USERBOT",
});
const AUTH_FLOW = Object.freeze({ authFlowId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
const OTHER_AUTH_FLOW = Object.freeze({ authFlowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
const SESSION = "1A-test-string-session-value";
const AUTH_STATE = JSON.stringify({ phoneNumber: "+628123456789", phoneCodeHash: "sensitive-hash", session: "temporary-session" });
const KEY_ONE = "11".repeat(32);
const KEY_TWO = "22".repeat(32);

function ring(activeKeyVersion = 2): TelegramSessionKeyRing {
  return TelegramSessionKeyRing.fromHexKeys({
    activeKeyVersion,
    keys: { 1: KEY_ONE, 2: KEY_TWO },
  });
}

function code(error: unknown): string | undefined {
  return error instanceof TelegramSessionCryptoError ? error.code : undefined;
}

test("round-trip uses randomized format-1 envelopes and binds the account context", () => {
  const keyRing = ring();
  const first = keyRing.encrypt(ACCOUNT, SESSION);
  const second = keyRing.encrypt(ACCOUNT, SESSION);
  assert.equal(first.keyVersion, 2);
  assert.equal(first.ciphertext.subarray(0, 4).toString("ascii"), "JSE1");
  assert.equal(first.ciphertext.readUInt8(4), 1);
  assert.equal(first.ciphertext.readUInt8(6), 12);
  assert.equal(first.ciphertext.readUInt8(7), 16);
  assert.equal(first.ciphertext.readUInt32BE(8), 2);
  assert.equal(first.ciphertext.length, Buffer.byteLength(SESSION, "utf8") + 40);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.ciphertext.includes(Buffer.from(SESSION)), false);
  assert.equal(keyRing.decrypt(ACCOUNT, first), SESSION);
  assert.throws(() => keyRing.decrypt(OTHER_ACCOUNT, first), (error) => code(error) === "SESSION_AUTH_FAILED");
  assert.throws(
    () => keyRing.decrypt({ ...ACCOUNT, accountType: "JASEB_WORKER" }, first),
    (error) => code(error) === "SESSION_AUTH_FAILED",
  );
});

test("rotation encrypts with the active key and retains decrypt support for old versions", () => {
  const oldRing = ring(1);
  const oldCiphertext = oldRing.encrypt(ACCOUNT, SESSION);
  const rotatedRing = ring(2);
  const newCiphertext = rotatedRing.encrypt(ACCOUNT, SESSION);
  assert.equal(oldCiphertext.keyVersion, 1);
  assert.equal(newCiphertext.keyVersion, 2);
  assert.equal(rotatedRing.decrypt(ACCOUNT, oldCiphertext), SESSION);
  assert.equal(rotatedRing.decrypt(ACCOUNT, newCiphertext), SESSION);

  const withoutOldKey = TelegramSessionKeyRing.fromHexKeys({ activeKeyVersion: 2, keys: { 2: KEY_TWO } });
  assert.throws(() => withoutOldKey.decrypt(ACCOUNT, oldCiphertext), (error) => code(error) === "SESSION_KEY_NOT_FOUND");
});

test("auth-flow state has a separate envelope and cannot cross flow or session domains", () => {
  const keyRing = ring();
  const encrypted = keyRing.encryptAuthState(AUTH_FLOW, AUTH_STATE);
  assert.equal(encrypted.ciphertext.subarray(0, 4).toString("ascii"), "JAF1");
  assert.equal(encrypted.ciphertext.includes(Buffer.from("sensitive-hash")), false);
  assert.equal(keyRing.decryptAuthState(AUTH_FLOW, encrypted), AUTH_STATE);
  assert.throws(
    () => keyRing.decryptAuthState(OTHER_AUTH_FLOW, encrypted),
    (error) => code(error) === "AUTH_STATE_AUTH_FAILED",
  );
  assert.throws(
    () => keyRing.decrypt(ACCOUNT, encrypted),
    (error) => code(error) === "SESSION_ENVELOPE_INVALID",
  );
  const finalSession = keyRing.encrypt(ACCOUNT, SESSION);
  assert.throws(
    () => keyRing.decryptAuthState(AUTH_FLOW, finalSession),
    (error) => code(error) === "AUTH_STATE_ENVELOPE_INVALID",
  );
});

test("auth-flow state validates context, version, tampering, and database envelope limit", () => {
  const keyRing = ring();
  const encrypted = keyRing.encryptAuthState(AUTH_FLOW, AUTH_STATE);
  const tampered = Buffer.from(encrypted.ciphertext);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(
    () => keyRing.decryptAuthState(AUTH_FLOW, { ciphertext: tampered, keyVersion: encrypted.keyVersion }),
    (error) => code(error) === "AUTH_STATE_AUTH_FAILED",
  );
  assert.throws(
    () => keyRing.decryptAuthState(AUTH_FLOW, { ciphertext: encrypted.ciphertext, keyVersion: 1 }),
    (error) => code(error) === "AUTH_STATE_KEY_VERSION_MISMATCH",
  );
  assert.throws(
    () => keyRing.encryptAuthState({ authFlowId: "not-a-uuid" }, AUTH_STATE),
    (error) => code(error) === "AUTH_STATE_CONTEXT_INVALID",
  );
  assert.throws(
    () => keyRing.encryptAuthState(AUTH_FLOW, "x".repeat(131_033)),
    (error) => code(error) === "AUTH_STATE_VALUE_INVALID",
  );
  const maximum = keyRing.encryptAuthState(AUTH_FLOW, "x".repeat(131_032));
  assert.equal(maximum.ciphertext.length, 131_072);
  assert.equal(keyRing.decryptAuthState(AUTH_FLOW, maximum).length, 131_032);
});

test("tampering with IV, tag, ciphertext, or valid context is authentication failure", () => {
  const keyRing = ring();
  const encrypted = keyRing.encrypt(ACCOUNT, SESSION);
  for (const offset of [12, 24, encrypted.ciphertext.length - 1]) {
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[offset] ^= 1;
    assert.throws(
      () => keyRing.decrypt(ACCOUNT, { ciphertext: tampered, keyVersion: encrypted.keyVersion }),
      (error) => code(error) === "SESSION_AUTH_FAILED",
    );
  }
});

test("malformed, unsupported, mismatched, empty, and oversized values fail distinctly", () => {
  const keyRing = ring();
  const encrypted = keyRing.encrypt(ACCOUNT, SESSION);
  const badMagic = Buffer.from(encrypted.ciphertext);
  badMagic[0] ^= 1;
  assert.throws(() => keyRing.decrypt(ACCOUNT, { ciphertext: badMagic, keyVersion: 2 }), (error) => code(error) === "SESSION_ENVELOPE_INVALID");

  const unsupported = Buffer.from(encrypted.ciphertext);
  unsupported.writeUInt8(2, 4);
  assert.throws(() => keyRing.decrypt(ACCOUNT, { ciphertext: unsupported, keyVersion: 2 }), (error) => code(error) === "SESSION_ENVELOPE_UNSUPPORTED");
  const withTrailingByte = Buffer.concat([encrypted.ciphertext, Buffer.from([0])]);
  assert.throws(() => keyRing.decrypt(ACCOUNT, { ciphertext: withTrailingByte, keyVersion: 2 }), (error) => code(error) === "SESSION_AUTH_FAILED");
  assert.throws(() => keyRing.decrypt(ACCOUNT, { ciphertext: encrypted.ciphertext, keyVersion: 1 }), (error) => code(error) === "SESSION_KEY_VERSION_MISMATCH");
  assert.throws(() => keyRing.decrypt(ACCOUNT, { ciphertext: encrypted.ciphertext.subarray(0, 40), keyVersion: 2 }), (error) => code(error) === "SESSION_ENVELOPE_INVALID");
  assert.throws(() => keyRing.encrypt(ACCOUNT, ""), (error) => code(error) === "SESSION_VALUE_INVALID");
  assert.throws(() => keyRing.encrypt(ACCOUNT, "x".repeat(65_537)), (error) => code(error) === "SESSION_VALUE_INVALID");
  assert.throws(
    () => keyRing.decrypt(ACCOUNT, { ciphertext: Buffer.alloc(65_577), keyVersion: 2 }),
    (error) => code(error) === "SESSION_ENVELOPE_INVALID",
  );
});

test("environment parsing is strict and key material stays redacted", () => {
  const keyRing = TelegramSessionKeyRing.fromEnvironment({
    TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "2",
    TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: KEY_ONE, 2: KEY_TWO }),
  });
  assert.equal(keyRing.hasKeyVersion(1), true);
  assert.equal(keyRing.hasKeyVersion(3), false);
  assert.deepEqual(JSON.parse(JSON.stringify(keyRing)), { redacted: true, activeKeyVersion: 2 });
  assert.equal(inspect(keyRing).includes(KEY_ONE), false);
  assert.equal(inspect(keyRing).includes(KEY_TWO), false);
  assert.equal(keyRing.toString(), "TelegramSessionKeyRing(redacted, activeKeyVersion=2)");

  const invalidEnvironments = [
    {},
    { TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1", TELEGRAM_SESSION_KEYS: "not-json" },
    { TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "01", TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: KEY_ONE }) },
    { TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "2", TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: KEY_ONE }) },
    { TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1", TELEGRAM_SESSION_KEYS: JSON.stringify({ 1: "aa" }) },
    { TELEGRAM_SESSION_ACTIVE_KEY_VERSION: "1", TELEGRAM_SESSION_KEYS: " ".repeat(4_097) },
  ];
  for (const env of invalidEnvironments) {
    assert.throws(
      () => TelegramSessionKeyRing.fromEnvironment(env),
      (error) => code(error) === "SESSION_KEYRING_INVALID" && !String(error).includes(KEY_ONE),
    );
  }
});

test("invalid context and errors expose only stable public codes", () => {
  const keyRing = ring();
  assert.throws(
    () => keyRing.encrypt({ accountId: "not-a-uuid", accountType: "USERBOT" }, SESSION),
    (error) => {
      assert.equal(code(error), "SESSION_CONTEXT_INVALID");
      assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: "SESSION_CONTEXT_INVALID" });
      assert.equal(String(error).includes(SESSION), false);
      assert.equal(inspect(error).includes(KEY_ONE), false);
      return true;
    },
  );
});
