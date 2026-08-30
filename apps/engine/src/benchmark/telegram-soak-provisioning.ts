import { randomUUID } from "node:crypto";

import type { TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";

const RUN_ID = /^[a-z0-9-]{4,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_USER_ID = /^[1-9][0-9]{0,18}$/;
const MAX_PROVIDER_USER_ID = 9_223_372_036_854_775_807n;

export type TelegramSoakProvisioningErrorCode =
  | "PROVISIONING_INPUT_INVALID"
  | "PROVISIONING_SESSION_VERIFY_FAILED"
  | "PROVISIONING_PROVIDER_ID_DUPLICATE"
  | "PROVISIONING_PERSIST_FAILED"
  | "PROVISIONING_REVOKE_FAILED"
  | "PROVISIONING_CLEANUP_FAILED";

export class TelegramSoakProvisioningError extends Error {
  readonly code: TelegramSoakProvisioningErrorCode;
  readonly field: string | null;
  readonly accountIndex: number | null;

  constructor(code: TelegramSoakProvisioningErrorCode, input: Readonly<{ field?: string; accountIndex?: number }> = {}) {
    super(code);
    this.name = "TelegramSoakProvisioningError";
    this.code = code;
    this.field = input.field ?? null;
    this.accountIndex = input.accountIndex ?? null;
  }

  publicData(): Readonly<{ code: TelegramSoakProvisioningErrorCode; field: string | null; accountIndex: number | null }> {
    return Object.freeze({ code: this.code, field: this.field, accountIndex: this.accountIndex });
  }

  toJSON(): ReturnType<TelegramSoakProvisioningError["publicData"]> { return this.publicData(); }
}

function invalid(field: string): never {
  throw new TelegramSoakProvisioningError("PROVISIONING_INPUT_INVALID", { field });
}

function providerUserId(value: string, accountIndex: number): string {
  if (!PROVIDER_USER_ID.test(value)) {
    throw new TelegramSoakProvisioningError("PROVISIONING_SESSION_VERIFY_FAILED", { accountIndex });
  }
  try {
    if (BigInt(value) > MAX_PROVIDER_USER_ID) {
      throw new TelegramSoakProvisioningError("PROVISIONING_SESSION_VERIFY_FAILED", { accountIndex });
    }
  } catch (error) {
    if (error instanceof TelegramSoakProvisioningError) throw error;
    throw new TelegramSoakProvisioningError("PROVISIONING_SESSION_VERIFY_FAILED", { accountIndex });
  }
  return value;
}

export interface TelegramSoakSessionVerifier {
  verify(session: string): Promise<Readonly<{ providerUserId: string }>>;
}

export type TelegramSoakProvisionedAccount = Readonly<{
  accountIndex: number;
  accountId: string;
  userId: string;
  providerUserId: string;
  label: string;
  encryptedSession: Uint8Array;
  encryptionKeyVersion: number;
}>;

export interface TelegramSoakProvisioningStore {
  provisionBatch(input: Readonly<{
    runId: string;
    intervalSeconds: number;
    accounts: readonly TelegramSoakProvisionedAccount[];
  }>): Promise<void>;
  revokeAccount(input: Readonly<{ runId: string; accountId: string; firedAtIso: string }>): Promise<boolean>;
  cleanupRun(runId: string): Promise<TelegramSoakCleanupResult>;
}

export type TelegramSoakCleanupResult = Readonly<{
  deletedAccounts: number;
  deletedUsers: number;
  deletedOperations: number;
  remainingAccounts: number;
  remainingOperations: number;
  remainingLeases: number;
}>;

export type TelegramSoakProvisioningResult = Readonly<{
  runId: string;
  accounts: readonly Readonly<{ accountIndex: number; accountId: string; userId: string }>[];
}>;

export async function provisionTelegramSoakAccounts(input: Readonly<{
  runId: string;
  sessions: readonly string[];
  intervalSeconds: number;
  verifier: TelegramSoakSessionVerifier;
  store: TelegramSoakProvisioningStore;
  keyRing: Pick<TelegramSessionKeyRing, "encrypt">;
  createId?: () => string;
}>): Promise<TelegramSoakProvisioningResult> {
  if (typeof input.runId !== "string" || !RUN_ID.test(input.runId)) invalid("runId");
  if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 50) invalid("sessions");
  if (!Number.isSafeInteger(input.intervalSeconds) || input.intervalSeconds < 0 || input.intervalSeconds > 3_600) invalid("intervalSeconds");
  const sessions = input.sessions.map((session, index) => {
    if (typeof session !== "string" || !session.trim() || session.length > 65_536) invalid(`sessions.${index}`);
    return session.trim();
  });
  const createId = input.createId ?? randomUUID;
  const accounts: TelegramSoakProvisionedAccount[] = [];
  const providerIds = new Set<string>();

  try {
    for (let offset = 0; offset < sessions.length; offset += 1) {
      const accountIndex = offset + 1;
      let verified: Readonly<{ providerUserId: string }>;
      try { verified = await input.verifier.verify(sessions[offset]!); }
      catch { throw new TelegramSoakProvisioningError("PROVISIONING_SESSION_VERIFY_FAILED", { accountIndex }); }
      const verifiedProviderId = providerUserId(verified.providerUserId, accountIndex);
      if (providerIds.has(verifiedProviderId)) {
        throw new TelegramSoakProvisioningError("PROVISIONING_PROVIDER_ID_DUPLICATE", { accountIndex });
      }
      providerIds.add(verifiedProviderId);

      const userId = createId().toLowerCase();
      const accountId = createId().toLowerCase();
      if (!UUID.test(userId)) invalid("createId");
      if (!UUID.test(accountId)) invalid("createId");
      const encrypted = input.keyRing.encrypt({ accountId, accountType: "JASEB_WORKER" }, sessions[offset]!);
      accounts.push(Object.freeze({
        accountIndex,
        accountId,
        userId,
        providerUserId: verifiedProviderId,
        label: `F5.7c ${input.runId} #${accountIndex}`,
        encryptedSession: encrypted.ciphertext,
        encryptionKeyVersion: encrypted.keyVersion,
      }));
    }

    try {
      await input.store.provisionBatch(Object.freeze({
        runId: input.runId,
        intervalSeconds: input.intervalSeconds,
        accounts: Object.freeze(accounts),
      }));
    } catch {
      throw new TelegramSoakProvisioningError("PROVISIONING_PERSIST_FAILED");
    }

    return Object.freeze({
      runId: input.runId,
      accounts: Object.freeze(accounts.map((account) => Object.freeze({
        accountIndex: account.accountIndex,
        accountId: account.accountId,
        userId: account.userId,
      }))),
    });
  } finally {
    for (const account of accounts) account.encryptedSession.fill(0);
  }
}

export async function revokeTelegramSoakAccount(input: Readonly<{
  runId: string;
  accountId: string;
  firedAtIso: string;
  store: TelegramSoakProvisioningStore;
}>): Promise<void> {
  if (!RUN_ID.test(input.runId)) invalid("runId");
  if (!UUID.test(input.accountId)) invalid("accountId");
  if (!Number.isFinite(Date.parse(input.firedAtIso))) invalid("firedAtIso");
  let revoked = false;
  try {
    revoked = await input.store.revokeAccount({
      runId: input.runId,
      accountId: input.accountId.toLowerCase(),
      firedAtIso: input.firedAtIso,
    });
  } catch {
    throw new TelegramSoakProvisioningError("PROVISIONING_REVOKE_FAILED");
  }
  if (!revoked) throw new TelegramSoakProvisioningError("PROVISIONING_REVOKE_FAILED");
}

export async function cleanupTelegramSoakRun(input: Readonly<{
  runId: string;
  store: TelegramSoakProvisioningStore;
}>): Promise<TelegramSoakCleanupResult> {
  if (!RUN_ID.test(input.runId)) invalid("runId");
  let result: TelegramSoakCleanupResult;
  try { result = await input.store.cleanupRun(input.runId); }
  catch { throw new TelegramSoakProvisioningError("PROVISIONING_CLEANUP_FAILED"); }
  if (result.remainingAccounts !== 0 || result.remainingOperations !== 0 || result.remainingLeases !== 0) {
    throw new TelegramSoakProvisioningError("PROVISIONING_CLEANUP_FAILED");
  }
  return result;
}
