import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { inspect } from "node:util";
import test from "node:test";

import {
  TelegramMiniAppAuthError,
  TelegramMiniAppVerifier,
} from "../src/auth/telegram-mini-app.ts";

const BOT_TOKEN = "123456789:test_bot_token_abcdefghijklmnopqrstuvwxyz";
const NOW_SECONDS = 1_800_000_000;
const INDEPENDENT_VECTOR = "auth_date=1799999990&query_id=AAHdF6IQAAAAAN0X-test&user=%7B%22id%22%3A4503599627370495%2C%22first_name%22%3A%22Kertaaji%22%2C%22last_name%22%3A%22Owner%22%2C%22username%22%3A%22kertaaji_test%22%2C%22language_code%22%3A%22id%22%2C%22is_premium%22%3Atrue%2C%22allows_write_to_pm%22%3Atrue%7D&hash=f79c133e25913f3c47185d2f6457eb8026986dd5ca3311bfb3f81f3b10f89fa8";

function sign(fields: Readonly<Record<string, string>>, token = BOT_TOKEN): string {
  const dataCheck = Object.entries(fields)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheck).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

function valid(overrides: Readonly<Record<string, string>> = {}): string {
  return sign({
    auth_date: String(NOW_SECONDS - 10),
    query_id: "AAHdF6IQAAAAAN0X-test",
    user: JSON.stringify({
      id: 4_503_599_627_370_495,
      first_name: "Kertaaji",
      last_name: "Owner",
      username: "kertaaji_test",
      language_code: "id",
      is_premium: true,
      allows_write_to_pm: true,
    }),
    ...overrides,
  });
}

function verifier() {
  return new TelegramMiniAppVerifier({ botToken: BOT_TOKEN, maxAgeSeconds: 300, clockSkewSeconds: 30, now: () => NOW_SECONDS * 1_000 });
}

function code(error: unknown): string | undefined {
  return error instanceof TelegramMiniAppAuthError ? error.code : undefined;
}

test("verifies signed initData and preserves the Telegram user ID as a string", () => {
  const identity = verifier().verify(INDEPENDENT_VECTOR);
  assert.deepEqual(identity, {
    telegramUserId: "4503599627370495",
    authDateSeconds: NOW_SECONDS - 10,
    queryId: "AAHdF6IQAAAAAN0X-test",
    firstName: "Kertaaji",
    lastName: "Owner",
    username: "kertaaji_test",
    languageCode: "id",
    isPremium: true,
    allowsWriteToPm: true,
  });
});

test("accepts an unknown Telegram field when it is covered by the signature", () => {
  assert.equal(verifier().verify(valid({ future_telegram_field: "supported" })).telegramUserId, "4503599627370495");
});

test("rejects tampering and a hash made with another bot token", () => {
  const raw = valid();
  const tampered = raw.replace("kertaaji_test", "attacker_name");
  const otherToken = sign({ auth_date: String(NOW_SECONDS), user: JSON.stringify({ id: 1, first_name: "Other" }) }, "999999999:another_bot_token_abcdefghijklmnopqrstuvwxyz");
  assert.throws(() => verifier().verify(tampered), (error) => code(error) === "TELEGRAM_INIT_DATA_HASH_INVALID");
  assert.throws(() => verifier().verify(otherToken), (error) => code(error) === "TELEGRAM_INIT_DATA_HASH_INVALID");
});

test("rejects expired and unreasonably future auth dates after signature validation", () => {
  assert.throws(() => verifier().verify(valid({ auth_date: String(NOW_SECONDS - 301) })), (error) => code(error) === "TELEGRAM_INIT_DATA_EXPIRED");
  assert.throws(() => verifier().verify(valid({ auth_date: String(NOW_SECONDS + 31) })), (error) => code(error) === "TELEGRAM_INIT_DATA_FUTURE");
  assert.equal(verifier().verify(valid({ auth_date: String(NOW_SECONDS - 300) })).authDateSeconds, NOW_SECONDS - 300);
  assert.equal(verifier().verify(valid({ auth_date: String(NOW_SECONDS + 30) })).authDateSeconds, NOW_SECONDS + 30);
});

test("rejects duplicate fields and malformed percent encoding before authentication", () => {
  const raw = valid();
  assert.throws(() => verifier().verify(`${raw}&user=%7B%7D`), (error) => code(error) === "TELEGRAM_INIT_DATA_DUPLICATE_FIELD");
  assert.throws(() => verifier().verify(`${raw}%GG`), (error) => code(error) === "TELEGRAM_INIT_DATA_MALFORMED");
  assert.throws(() => verifier().verify(`?${raw}`), (error) => code(error) === "TELEGRAM_INIT_DATA_MALFORMED");
});

test("rejects missing or malformed required fields", () => {
  const missingUser = sign({ auth_date: String(NOW_SECONDS) });
  const invalidUser = valid({ user: JSON.stringify({ id: 0, first_name: "Nobody" }) });
  const invalidAuthDate = valid({ auth_date: "1800000000.5" });
  assert.throws(() => verifier().verify(missingUser), (error) => code(error) === "TELEGRAM_INIT_DATA_MALFORMED");
  assert.throws(() => verifier().verify(invalidUser), (error) => code(error) === "TELEGRAM_INIT_DATA_USER_INVALID");
  assert.throws(() => verifier().verify(invalidAuthDate), (error) => code(error) === "TELEGRAM_INIT_DATA_MALFORMED");
});

test("redacts bot token and raw initData from diagnostics", () => {
  const auth = verifier();
  const raw = valid();
  assert.deepEqual(JSON.parse(JSON.stringify(auth)), { redacted: true, maxAgeSeconds: 300, clockSkewSeconds: 30 });
  assert.equal(inspect(auth).includes(BOT_TOKEN), false);
  let caught: unknown;
  try { auth.verify(raw.replace(/hash=[^&]+/, `hash=${"0".repeat(64)}`)); } catch (error) { caught = error; }
  assert.equal(inspect(caught).includes(raw), false);
  assert.deepEqual(JSON.parse(JSON.stringify(caught)), { code: "TELEGRAM_INIT_DATA_HASH_INVALID" });
});

test("constructor rejects unsafe secret and time policies", () => {
  assert.throws(() => new TelegramMiniAppVerifier({ botToken: "contains space" }), /INVALID_TELEGRAM_BOT_TOKEN/);
  assert.throws(() => new TelegramMiniAppVerifier({ botToken: BOT_TOKEN, maxAgeSeconds: 0 }), /INVALID_TELEGRAM_INIT_DATA_MAX_AGE/);
  assert.throws(() => new TelegramMiniAppVerifier({ botToken: BOT_TOKEN, clockSkewSeconds: 301 }), /INVALID_TELEGRAM_INIT_DATA_CLOCK_SKEW/);
});
