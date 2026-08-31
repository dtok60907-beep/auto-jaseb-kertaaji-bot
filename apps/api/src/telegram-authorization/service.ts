import { randomUUID } from "node:crypto";

import type { TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";
import { resolveEntitlementAccess } from "../entitlements/access.ts";
import type { EntitlementRepository } from "../entitlements/repository.ts";
import type {
  TelegramAccountAuthFlowResult,
  TelegramAccountLifecycleRepository,
} from "../telegram-accounts/repository.ts";
import {
  parseTelegramAuthorizationState,
  serializeTelegramAuthorizationState,
} from "./state.ts";
import {
  TelegramAuthorizationTransportError,
  type TelegramAuthorizationTransport,
  type TelegramAuthorizationTransportErrorCode,
  type TelegramPendingAuthorization,
  type TelegramVerifiedAuthorization,
} from "./transport.ts";

const DEFAULT_FLOW_TTL_SECONDS = 600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type TelegramAuthorizationFlowView = Readonly<{
  id: string;
  status: "CODE_REQUIRED" | "PASSWORD_REQUIRED";
  version: number;
  expiresAt: string;
  codeDelivery?: "APP" | "SMS";
}>;

export type TelegramAuthorizationResult =
  | Readonly<{ status: "CODE_REQUIRED"; flow: TelegramAuthorizationFlowView }>
  | Readonly<{ status: "PASSWORD_REQUIRED"; flow: TelegramAuthorizationFlowView }>
  | Readonly<{ status: "CONNECTED"; account: Readonly<{ id: string; label: string }> }>;

export type TelegramAuthorizationServiceErrorCode =
  | "INVALID_PHONE_NUMBER"
  | "INVALID_AUTH_FLOW_ID"
  | "INVALID_AUTH_FLOW_VERSION"
  | "INVALID_TELEGRAM_CODE"
  | "INVALID_TELEGRAM_PASSWORD"
  | "SUBSCRIPTION_REQUIRED"
  | "SUBSCRIPTION_EXPIRED"
  | "AUTH_FLOW_ACTIVE"
  | "AUTH_FLOW_NOT_FOUND"
  | "AUTH_FLOW_EXPIRED"
  | "AUTH_FLOW_CONFLICT"
  | "AUTH_FLOW_STATE_INVALID"
  | "ACCOUNT_ALREADY_CONNECTED"
  | TelegramAuthorizationTransportErrorCode
  | "AUTH_TEMPORARILY_UNAVAILABLE";

export class TelegramAuthorizationServiceError extends Error {
  readonly code: TelegramAuthorizationServiceErrorCode;
  readonly flow: TelegramAuthorizationFlowView | null;

  constructor(code: TelegramAuthorizationServiceErrorCode, flow: TelegramAuthorizationFlowView | null = null) {
    super(code);
    this.name = "TelegramAuthorizationServiceError";
    this.code = code;
    this.flow = flow;
  }

  toJSON(): Readonly<{ code: TelegramAuthorizationServiceErrorCode }> {
    return Object.freeze({ code: this.code });
  }
}

type KeyRing = Pick<TelegramSessionKeyRing, "encrypt" | "encryptAuthState" | "decryptAuthState">;

function publicVersion(value: bigint | null): number {
  if (value === null || value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
  }
  return Number(value);
}

function flowView(
  result: TelegramAccountAuthFlowResult,
  delivery?: "APP" | "SMS",
): TelegramAuthorizationFlowView | null {
  if (
    !result.id || !result.expiresAt
    || (result.status !== "CODE_REQUIRED" && result.status !== "PASSWORD_REQUIRED")
  ) return null;
  return Object.freeze({
    id: result.id,
    status: result.status,
    version: publicVersion(result.version),
    expiresAt: result.expiresAt,
    ...(delivery ? { codeDelivery: delivery } : {}),
  });
}

export function normalizeTelegramPhoneNumber(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\s()-]/g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

function codeValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\s-]/g, "");
  return /^[0-9]{4,8}$/.test(normalized) ? normalized : null;
}

function passwordValue(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 512) return null;
  return /[\0\r\n]/.test(value) ? null : value;
}

function retryableUserError(code: TelegramAuthorizationTransportErrorCode): boolean {
  return code === "PHONE_CODE_INVALID"
    || code === "PASSWORD_INVALID"
    || code === "TELEGRAM_RATE_LIMITED"
    || code === "TELEGRAM_UNAVAILABLE";
}

export class TelegramAuthorizationService {
  readonly #accounts: TelegramAccountLifecycleRepository;
  readonly #entitlements: EntitlementRepository;
  readonly #transport: TelegramAuthorizationTransport;
  readonly #keyRing: KeyRing;
  readonly #flowTtlSeconds: number;
  readonly #newAccountId: () => string;

  constructor(input: Readonly<{
    accounts: TelegramAccountLifecycleRepository;
    entitlements: EntitlementRepository;
    transport: TelegramAuthorizationTransport;
    keyRing: KeyRing;
    flowTtlSeconds?: number;
    newAccountId?: () => string;
  }>) {
    const ttl = input.flowTtlSeconds ?? DEFAULT_FLOW_TTL_SECONDS;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 900) throw new TypeError("INVALID_AUTH_FLOW_TTL");
    this.#accounts = input.accounts;
    this.#entitlements = input.entitlements;
    this.#transport = input.transport;
    this.#keyRing = input.keyRing;
    this.#flowTtlSeconds = ttl;
    this.#newAccountId = input.newAccountId ?? randomUUID;
  }

  async #requireSubscription(userId: string): Promise<void> {
    const access = resolveEntitlementAccess(await this.#entitlements.list(userId), "AUTO_COMMENT_MF");
    if (!access.ok) throw new TelegramAuthorizationServiceError(access.code);
  }

  #encryptPending(authFlowId: string, pending: TelegramPendingAuthorization) {
    return this.#keyRing.encryptAuthState(
      { authFlowId },
      serializeTelegramAuthorizationState(pending),
    );
  }

  async #transitionFailure(input: Readonly<{
    userId: string;
    authFlowId: string;
    version: bigint;
    code: string;
  }>): Promise<void> {
    await this.#accounts.transitionAuthFlow({
      userId: input.userId,
      authFlowId: input.authFlowId,
      expectedVersion: input.version,
      nextStatus: "FAILED",
      errorCode: input.code,
    });
  }

  async start(userId: string, rawPhoneNumber: unknown): Promise<TelegramAuthorizationResult> {
    const phoneNumber = normalizeTelegramPhoneNumber(rawPhoneNumber);
    if (!phoneNumber) throw new TelegramAuthorizationServiceError("INVALID_PHONE_NUMBER");
    await this.#requireSubscription(userId);
    const begun = await this.#accounts.beginAuthFlow(userId, this.#flowTtlSeconds);
    if (begun.result === "ACTIVE_FLOW_EXISTS") {
      throw new TelegramAuthorizationServiceError("AUTH_FLOW_ACTIVE", flowView(begun));
    }
    if (begun.result !== "CREATED" || !begun.id || begun.version === null) {
      throw new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
    }

    const starting = this.#keyRing.encryptAuthState(
      { authFlowId: begun.id },
      JSON.stringify({ version: 1, starting: { phoneNumber } }),
    );
    let claimed: TelegramAccountAuthFlowResult;
    try {
      claimed = await this.#accounts.transitionAuthFlow({
        userId,
        authFlowId: begun.id,
        expectedVersion: begun.version,
        nextStatus: "VERIFYING",
        encryptedState: starting.ciphertext,
        encryptionKeyVersion: starting.keyVersion,
      });
    } finally {
      starting.ciphertext.fill(0);
    }
    if (claimed.result !== "UPDATED" || claimed.version === null) {
      throw new TelegramAuthorizationServiceError("AUTH_FLOW_CONFLICT");
    }

    let pending: TelegramPendingAuthorization;
    try {
      pending = await this.#transport.requestCode(phoneNumber);
    } catch (error) {
      const code = error instanceof TelegramAuthorizationTransportError
        ? error.code
        : "TELEGRAM_UNAVAILABLE";
      await this.#transitionFailure({ userId, authFlowId: begun.id, version: claimed.version, code });
      throw new TelegramAuthorizationServiceError(code);
    }

    const encrypted = this.#encryptPending(begun.id, pending);
    let ready: TelegramAccountAuthFlowResult;
    try {
      ready = await this.#accounts.transitionAuthFlow({
        userId,
        authFlowId: begun.id,
        expectedVersion: claimed.version,
        nextStatus: "CODE_REQUIRED",
        encryptedState: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      });
    } finally {
      encrypted.ciphertext.fill(0);
    }
    if (ready.result !== "UPDATED") throw new TelegramAuthorizationServiceError(
      ready.result === "FLOW_EXPIRED" ? "AUTH_FLOW_EXPIRED" : "AUTH_FLOW_CONFLICT",
    );
    const view = flowView(ready, pending.codeDelivery);
    if (!view) throw new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
    return Object.freeze({ status: "CODE_REQUIRED", flow: view });
  }

  async #cancelForMissingSubscription(
    userId: string,
    authFlowId: string,
    expectedVersion: bigint,
    error: unknown,
  ): Promise<never> {
    if (error instanceof TelegramAuthorizationServiceError) {
      await this.#accounts.transitionAuthFlow({
        userId, authFlowId, expectedVersion, nextStatus: "CANCELLED",
      }).catch(() => undefined);
      throw error;
    }
    throw new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
  }

  async #claim(
    userId: string,
    authFlowId: string,
    version: bigint,
    expectedStatus: "CODE_REQUIRED" | "PASSWORD_REQUIRED",
  ): Promise<Readonly<{ pending: TelegramPendingAuthorization; version: bigint }>> {
    const claim = await this.#accounts.claimAuthFlowStep({
      userId, authFlowId, expectedVersion: version, expectedStatus,
    });
    if (claim.result !== "CLAIMED") {
      const code = claim.result === "NOT_FOUND" ? "AUTH_FLOW_NOT_FOUND"
        : claim.result === "FLOW_EXPIRED" ? "AUTH_FLOW_EXPIRED"
          : "AUTH_FLOW_CONFLICT";
      throw new TelegramAuthorizationServiceError(code);
    }
    if (claim.version === null || claim.encryptedState === null || claim.encryptionKeyVersion === null) {
      throw new TelegramAuthorizationServiceError("AUTH_FLOW_STATE_INVALID");
    }
    try {
      const serialized = this.#keyRing.decryptAuthState(
        { authFlowId },
        { ciphertext: claim.encryptedState, keyVersion: claim.encryptionKeyVersion },
      );
      return Object.freeze({ pending: parseTelegramAuthorizationState(serialized), version: claim.version });
    } catch {
      await this.#transitionFailure({
        userId, authFlowId, version: claim.version, code: "AUTH_FLOW_STATE_INVALID",
      });
      throw new TelegramAuthorizationServiceError("AUTH_FLOW_STATE_INVALID");
    } finally {
      claim.encryptedState.fill(0);
    }
  }

  async #restoreAfterError(input: Readonly<{
    userId: string;
    authFlowId: string;
    version: bigint;
    status: "CODE_REQUIRED" | "PASSWORD_REQUIRED";
    pending: TelegramPendingAuthorization;
    error: TelegramAuthorizationTransportError;
  }>): Promise<never> {
    if (!retryableUserError(input.error.code)) {
      await this.#transitionFailure({
        userId: input.userId,
        authFlowId: input.authFlowId,
        version: input.version,
        code: input.error.code,
      });
      throw new TelegramAuthorizationServiceError(input.error.code);
    }
    const encrypted = this.#encryptPending(input.authFlowId, input.pending);
    let restored: TelegramAccountAuthFlowResult;
    try {
      restored = await this.#accounts.transitionAuthFlow({
        userId: input.userId,
        authFlowId: input.authFlowId,
        expectedVersion: input.version,
        nextStatus: input.status,
        encryptedState: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      });
    } finally {
      encrypted.ciphertext.fill(0);
    }
    throw new TelegramAuthorizationServiceError(input.error.code, flowView(restored));
  }

  async #complete(
    userId: string,
    authFlowId: string,
    version: bigint,
    verified: TelegramVerifiedAuthorization,
  ): Promise<TelegramAuthorizationResult> {
    const proposedAccountId = this.#newAccountId();
    if (!UUID.test(proposedAccountId)) throw new TelegramAuthorizationServiceError("AUTH_TEMPORARILY_UNAVAILABLE");
    const resolved = await this.#accounts.resolveCompletionAccountId({
      userId,
      providerUserId: verified.providerUserId,
      proposedAccountId,
    });
    if (resolved.result === "ACCOUNT_ALREADY_CONNECTED" || !resolved.accountId) {
      await this.#transitionFailure({
        userId, authFlowId, version, code: "ACCOUNT_ALREADY_CONNECTED",
      });
      throw new TelegramAuthorizationServiceError("ACCOUNT_ALREADY_CONNECTED");
    }

    let accountId = resolved.accountId;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const encrypted = this.#keyRing.encrypt(
        { accountId, accountType: "USERBOT" },
        verified.session,
      );
      let completion;
      try {
        completion = await this.#accounts.completeAuthFlow({
          userId,
          authFlowId,
          expectedVersion: version,
          accountId,
          providerUserId: verified.providerUserId,
          label: verified.label,
          encryptedSession: encrypted.ciphertext,
          encryptionKeyVersion: encrypted.keyVersion,
        });
      } finally {
        encrypted.ciphertext.fill(0);
      }
      if (completion.result === "CONNECTED" && completion.accountId && completion.label) {
        return Object.freeze({
          status: "CONNECTED",
          account: Object.freeze({ id: completion.accountId, label: completion.label }),
        });
      }
      if (completion.result === "ACCOUNT_ID_MISMATCH" && completion.accountId && attempt === 0) {
        accountId = completion.accountId;
        continue;
      }
      if (completion.result === "ACCOUNT_ALREADY_CONNECTED") {
        await this.#transitionFailure({ userId, authFlowId, version, code: "ACCOUNT_ALREADY_CONNECTED" });
        throw new TelegramAuthorizationServiceError("ACCOUNT_ALREADY_CONNECTED");
      }
      const code = completion.result === "FLOW_EXPIRED" ? "AUTH_FLOW_EXPIRED"
        : completion.result === "NOT_FOUND" ? "AUTH_FLOW_NOT_FOUND"
          : "AUTH_FLOW_CONFLICT";
      throw new TelegramAuthorizationServiceError(code);
    }
    throw new TelegramAuthorizationServiceError("AUTH_FLOW_CONFLICT");
  }

  async submitCode(
    userId: string,
    authFlowId: unknown,
    rawVersion: unknown,
    rawCode: unknown,
  ): Promise<TelegramAuthorizationResult> {
    if (typeof authFlowId !== "string" || !UUID.test(authFlowId)) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_ID");
    }
    if (typeof rawVersion !== "number" || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_VERSION");
    }
    const code = codeValue(rawCode);
    if (!code) throw new TelegramAuthorizationServiceError("INVALID_TELEGRAM_CODE");
    const version = BigInt(rawVersion);
    try { await this.#requireSubscription(userId); }
    catch (error) { return this.#cancelForMissingSubscription(userId, authFlowId, version, error); }
    const claimed = await this.#claim(userId, authFlowId, version, "CODE_REQUIRED");
    let result;
    try {
      result = await this.#transport.submitCode(claimed.pending, code);
    } catch (error) {
      const mapped = error instanceof TelegramAuthorizationTransportError
        ? error
        : new TelegramAuthorizationTransportError("TELEGRAM_UNAVAILABLE");
      return this.#restoreAfterError({
        userId, authFlowId, version: claimed.version, status: "CODE_REQUIRED",
        pending: claimed.pending, error: mapped,
      });
    }
    if (result.status === "AUTHORIZED") {
      return this.#complete(userId, authFlowId, claimed.version, result.verified);
    }
    const encrypted = this.#encryptPending(authFlowId, result.pending);
    let advanced: TelegramAccountAuthFlowResult;
    try {
      advanced = await this.#accounts.transitionAuthFlow({
        userId,
        authFlowId,
        expectedVersion: claimed.version,
        nextStatus: "PASSWORD_REQUIRED",
        encryptedState: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      });
    } finally {
      encrypted.ciphertext.fill(0);
    }
    const view = flowView(advanced);
    if (!view) throw new TelegramAuthorizationServiceError("AUTH_FLOW_CONFLICT");
    return Object.freeze({ status: "PASSWORD_REQUIRED", flow: view });
  }

  async submitPassword(
    userId: string,
    authFlowId: unknown,
    rawVersion: unknown,
    rawPassword: unknown,
  ): Promise<TelegramAuthorizationResult> {
    if (typeof authFlowId !== "string" || !UUID.test(authFlowId)) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_ID");
    }
    if (typeof rawVersion !== "number" || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_VERSION");
    }
    const password = passwordValue(rawPassword);
    if (!password) throw new TelegramAuthorizationServiceError("INVALID_TELEGRAM_PASSWORD");
    const version = BigInt(rawVersion);
    try { await this.#requireSubscription(userId); }
    catch (error) { return this.#cancelForMissingSubscription(userId, authFlowId, version, error); }
    const claimed = await this.#claim(userId, authFlowId, version, "PASSWORD_REQUIRED");
    let verified;
    try {
      verified = await this.#transport.submitPassword(claimed.pending, password);
    } catch (error) {
      const mapped = error instanceof TelegramAuthorizationTransportError
        ? error
        : new TelegramAuthorizationTransportError("TELEGRAM_UNAVAILABLE");
      return this.#restoreAfterError({
        userId, authFlowId, version: claimed.version, status: "PASSWORD_REQUIRED",
        pending: claimed.pending, error: mapped,
      });
    }
    return this.#complete(userId, authFlowId, claimed.version, verified);
  }

  async cancel(userId: string, authFlowId: unknown, rawVersion: unknown): Promise<void> {
    if (typeof authFlowId !== "string" || !UUID.test(authFlowId)) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_ID");
    }
    if (typeof rawVersion !== "number" || !Number.isSafeInteger(rawVersion) || rawVersion < 1) {
      throw new TelegramAuthorizationServiceError("INVALID_AUTH_FLOW_VERSION");
    }
    const result = await this.#accounts.transitionAuthFlow({
      userId,
      authFlowId,
      expectedVersion: BigInt(rawVersion),
      nextStatus: "CANCELLED",
    });
    if (result.result === "UPDATED") return;
    if (result.result === "NOT_FOUND") throw new TelegramAuthorizationServiceError("AUTH_FLOW_NOT_FOUND");
    if (result.result === "FLOW_EXPIRED") throw new TelegramAuthorizationServiceError("AUTH_FLOW_EXPIRED");
    throw new TelegramAuthorizationServiceError("AUTH_FLOW_CONFLICT");
  }
}
