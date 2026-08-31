import { createHmac, timingSafeEqual } from "node:crypto";
import { inspect } from "node:util";

const INSPECT = inspect.custom;
const HASH = /^[0-9a-f]{64}$/i;
const UNSAFE_PERCENT_ESCAPE = /%(?![0-9a-f]{2})/i;
const MAX_INIT_DATA_BYTES = 16_384;
const MAX_BOT_TOKEN_BYTES = 512;
const DEFAULT_MAX_AGE_SECONDS = 300;
const DEFAULT_CLOCK_SKEW_SECONDS = 30;

export type TelegramMiniAppAuthErrorCode =
  | "TELEGRAM_INIT_DATA_MALFORMED"
  | "TELEGRAM_INIT_DATA_DUPLICATE_FIELD"
  | "TELEGRAM_INIT_DATA_HASH_INVALID"
  | "TELEGRAM_INIT_DATA_EXPIRED"
  | "TELEGRAM_INIT_DATA_FUTURE"
  | "TELEGRAM_INIT_DATA_USER_INVALID";

export class TelegramMiniAppAuthError extends Error {
  readonly code: TelegramMiniAppAuthErrorCode;

  constructor(code: TelegramMiniAppAuthErrorCode) {
    super(code);
    this.name = "TelegramMiniAppAuthError";
    this.code = code;
  }

  publicData(): Readonly<{ code: TelegramMiniAppAuthErrorCode }> {
    return Object.freeze({ code: this.code });
  }

  toJSON(): ReturnType<TelegramMiniAppAuthError["publicData"]> {
    return this.publicData();
  }
}

export type TelegramMiniAppIdentity = Readonly<{
  telegramUserId: string;
  authDateSeconds: number;
  queryId: string | null;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  isPremium: boolean;
  allowsWriteToPm: boolean;
}>;

type TelegramUser = Readonly<{
  id: number;
  first_name: string;
  last_name?: unknown;
  username?: unknown;
  language_code?: unknown;
  is_premium?: unknown;
  allows_write_to_pm?: unknown;
}>;

function fail(code: TelegramMiniAppAuthErrorCode): never {
  throw new TelegramMiniAppAuthError(code);
}

function optionalText(value: unknown, maximumLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\0\r\n]/.test(normalized)) return null;
  return normalized;
}

function optionalBoolean(value: unknown): boolean {
  return value === true;
}

function parseUser(serialized: string): TelegramUser {
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { fail("TELEGRAM_INIT_DATA_USER_INVALID"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("TELEGRAM_INIT_DATA_USER_INVALID");
  const user = value as Record<string, unknown>;
  if (!Number.isSafeInteger(user.id) || Number(user.id) <= 0) fail("TELEGRAM_INIT_DATA_USER_INVALID");
  if (typeof user.first_name !== "string" || !user.first_name.trim() || user.first_name.length > 256 || /[\0\r\n]/.test(user.first_name)) {
    fail("TELEGRAM_INIT_DATA_USER_INVALID");
  }
  return user as TelegramUser;
}

function parseFields(rawInitData: string): ReadonlyMap<string, string> {
  if (
    typeof rawInitData !== "string"
    || !rawInitData
    || rawInitData.startsWith("?")
    || /[\0\r\n]/.test(rawInitData)
    || Buffer.byteLength(rawInitData, "utf8") > MAX_INIT_DATA_BYTES
    || UNSAFE_PERCENT_ESCAPE.test(rawInitData)
  ) fail("TELEGRAM_INIT_DATA_MALFORMED");

  const fields = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(rawInitData)) {
    if (!key || fields.has(key)) fail("TELEGRAM_INIT_DATA_DUPLICATE_FIELD");
    fields.set(key, value);
  }
  if (fields.size === 0) fail("TELEGRAM_INIT_DATA_MALFORMED");
  return fields;
}

function required(fields: ReadonlyMap<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value === "") fail("TELEGRAM_INIT_DATA_MALFORMED");
  return value;
}

function dataCheckString(fields: ReadonlyMap<string, string>): string {
  return [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export class TelegramMiniAppVerifier {
  readonly maxAgeSeconds: number;
  readonly clockSkewSeconds: number;
  readonly #botToken: string;
  readonly #now: () => number;

  constructor(input: Readonly<{
    botToken: string;
    maxAgeSeconds?: number;
    clockSkewSeconds?: number;
    now?: () => number;
  }>) {
    const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    const clockSkewSeconds = input.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (
      typeof input.botToken !== "string"
      || !input.botToken.trim()
      || Buffer.byteLength(input.botToken, "utf8") > MAX_BOT_TOKEN_BYTES
      || /[\0\r\n\s]/.test(input.botToken)
    ) throw new TypeError("INVALID_TELEGRAM_BOT_TOKEN");
    if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 86_400) {
      throw new TypeError("INVALID_TELEGRAM_INIT_DATA_MAX_AGE");
    }
    if (!Number.isInteger(clockSkewSeconds) || clockSkewSeconds < 0 || clockSkewSeconds > 300) {
      throw new TypeError("INVALID_TELEGRAM_INIT_DATA_CLOCK_SKEW");
    }
    if (input.now !== undefined && typeof input.now !== "function") throw new TypeError("INVALID_CLOCK");
    this.maxAgeSeconds = maxAgeSeconds;
    this.clockSkewSeconds = clockSkewSeconds;
    this.#botToken = input.botToken;
    this.#now = input.now ?? Date.now;
    Object.freeze(this);
  }

  verify(rawInitData: string): TelegramMiniAppIdentity {
    const fields = parseFields(rawInitData);
    const suppliedHash = required(fields, "hash");
    if (!HASH.test(suppliedHash)) fail("TELEGRAM_INIT_DATA_HASH_INVALID");

    const secretKey = createHmac("sha256", "WebAppData").update(this.#botToken).digest();
    const calculatedHash = createHmac("sha256", secretKey).update(dataCheckString(fields)).digest();
    const suppliedHashBytes = Buffer.from(suppliedHash, "hex");
    if (suppliedHashBytes.length !== calculatedHash.length || !timingSafeEqual(suppliedHashBytes, calculatedHash)) {
      fail("TELEGRAM_INIT_DATA_HASH_INVALID");
    }

    const serializedAuthDate = required(fields, "auth_date");
    if (!/^(0|[1-9][0-9]*)$/.test(serializedAuthDate)) fail("TELEGRAM_INIT_DATA_MALFORMED");
    const authDateSeconds = Number(serializedAuthDate);
    if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) fail("TELEGRAM_INIT_DATA_MALFORMED");
    const nowSeconds = Math.floor(this.#now() / 1_000);
    if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0) throw new TypeError("INVALID_CLOCK");
    if (authDateSeconds > nowSeconds + this.clockSkewSeconds) fail("TELEGRAM_INIT_DATA_FUTURE");
    if (nowSeconds - authDateSeconds > this.maxAgeSeconds) fail("TELEGRAM_INIT_DATA_EXPIRED");

    const user = parseUser(required(fields, "user"));
    const queryId = fields.get("query_id");
    if (queryId !== undefined && (!queryId || queryId.length > 256 || /[\0\r\n]/.test(queryId))) {
      fail("TELEGRAM_INIT_DATA_MALFORMED");
    }
    return Object.freeze({
      telegramUserId: String(user.id),
      authDateSeconds,
      queryId: queryId ?? null,
      firstName: user.first_name,
      lastName: optionalText(user.last_name, 256),
      username: optionalText(user.username, 64),
      languageCode: optionalText(user.language_code, 35),
      isPremium: optionalBoolean(user.is_premium),
      allowsWriteToPm: optionalBoolean(user.allows_write_to_pm),
    });
  }

  toJSON(): Readonly<{ redacted: true; maxAgeSeconds: number; clockSkewSeconds: number }> {
    return Object.freeze({ redacted: true, maxAgeSeconds: this.maxAgeSeconds, clockSkewSeconds: this.clockSkewSeconds });
  }

  toString(): string {
    return `TelegramMiniAppVerifier(redacted, maxAgeSeconds=${this.maxAgeSeconds}, clockSkewSeconds=${this.clockSkewSeconds})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}
