import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";

import type { ApiSessionRepository } from "./api-session-repository.ts";
import type { TelegramMiniAppIdentity } from "./telegram-mini-app.ts";

const INSPECT = inspect.custom;
const TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_SECONDS = 43_200;
const MIN_SESSION_TTL_SECONDS = 300;
const MAX_SESSION_TTL_SECONDS = 604_800;

export type TelegramMiniAppIdentityVerifier = Readonly<{
  verify(rawInitData: string): TelegramMiniAppIdentity;
}>;

export type TelegramSessionExchangeErrorCode =
  | "TELEGRAM_INIT_DATA_ALREADY_USED"
  | "API_SESSION_ENTROPY_INVALID";

export class TelegramSessionExchangeError extends Error {
  readonly code: TelegramSessionExchangeErrorCode;

  constructor(code: TelegramSessionExchangeErrorCode) {
    super(code);
    this.name = "TelegramSessionExchangeError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: TelegramSessionExchangeErrorCode }> {
    return Object.freeze({ code: this.code });
  }
}

export type IssuedTelegramSession = Readonly<{
  accessToken: string;
  tokenType: "Bearer";
  userId: string;
  telegramUserId: string;
  expiresAt: string;
}>;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hashApiSessionToken(token: string): Buffer {
  return sha256(token);
}

export class TelegramSessionIssuer {
  readonly sessionTtlSeconds: number;
  readonly #verifier: TelegramMiniAppIdentityVerifier;
  readonly #sessions: ApiSessionRepository;
  readonly #now: () => number;
  readonly #entropy: () => Uint8Array;

  constructor(input: Readonly<{
    verifier: TelegramMiniAppIdentityVerifier;
    sessions: ApiSessionRepository;
    sessionTtlSeconds?: number;
    now?: () => number;
    entropy?: () => Uint8Array;
  }>) {
    const ttl = input.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < MIN_SESSION_TTL_SECONDS || ttl > MAX_SESSION_TTL_SECONDS) {
      throw new TypeError("INVALID_API_SESSION_TTL");
    }
    if (!input.verifier || typeof input.verifier.verify !== "function") throw new TypeError("INVALID_TELEGRAM_VERIFIER");
    if (!input.sessions || typeof input.sessions.issue !== "function") throw new TypeError("INVALID_API_SESSION_REPOSITORY");
    if (input.now !== undefined && typeof input.now !== "function") throw new TypeError("INVALID_CLOCK");
    if (input.entropy !== undefined && typeof input.entropy !== "function") throw new TypeError("INVALID_ENTROPY_SOURCE");
    this.sessionTtlSeconds = ttl;
    this.#verifier = input.verifier;
    this.#sessions = input.sessions;
    this.#now = input.now ?? Date.now;
    this.#entropy = input.entropy ?? (() => randomBytes(TOKEN_BYTES));
  }

  async exchange(rawInitData: string): Promise<IssuedTelegramSession> {
    const identity = this.#verifier.verify(rawInitData);
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now <= 0) throw new TypeError("INVALID_CLOCK");
    const entropy = this.#entropy();
    if (!(entropy instanceof Uint8Array) || entropy.byteLength !== TOKEN_BYTES) {
      throw new TelegramSessionExchangeError("API_SESSION_ENTROPY_INVALID");
    }
    const accessToken = `jas_${Buffer.from(entropy).toString("base64url")}`;
    const expiresAt = new Date(now + this.sessionTtlSeconds * 1_000).toISOString();
    const result = await this.#sessions.issue({
      identity,
      tokenHash: hashApiSessionToken(accessToken),
      initDataHash: sha256(rawInitData),
      expiresAt,
    });
    if (result.status === "REPLAY") {
      throw new TelegramSessionExchangeError("TELEGRAM_INIT_DATA_ALREADY_USED");
    }
    if (Date.parse(result.expiresAt) !== Date.parse(expiresAt)) {
      throw new Error("API_SESSION_EXPIRY_MISMATCH");
    }
    return Object.freeze({
      accessToken,
      tokenType: "Bearer",
      userId: result.userId,
      telegramUserId: identity.telegramUserId,
      expiresAt,
    });
  }

  toJSON(): Readonly<{ redacted: true; sessionTtlSeconds: number }> {
    return Object.freeze({ redacted: true, sessionTtlSeconds: this.sessionTtlSeconds });
  }

  [INSPECT](): ReturnType<TelegramSessionIssuer["toJSON"]> {
    return this.toJSON();
  }
}
