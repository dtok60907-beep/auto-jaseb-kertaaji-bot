import type { TelegramPendingAuthorization } from "./transport.ts";

const MAX_PHONE_BYTES = 32;
const MAX_HASH_BYTES = 1_024;
const MAX_SESSION_BYTES = 65_536;

type StoredAuthorizationState = Readonly<{
  version: 1;
  pending: TelegramPendingAuthorization;
}>;

export class TelegramAuthorizationStateError extends Error {
  readonly code = "AUTH_STATE_INVALID";

  constructor() {
    super("AUTH_STATE_INVALID");
    this.name = "TelegramAuthorizationStateError";
  }
}

function validText(value: unknown, maximumBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maximumBytes
    && !/[\0\r\n]/.test(value);
}

export function serializeTelegramAuthorizationState(
  pending: TelegramPendingAuthorization,
): string {
  if (
    !validText(pending?.phoneNumber, MAX_PHONE_BYTES)
    || !/^\+[1-9][0-9]{7,14}$/.test(pending.phoneNumber)
    || !validText(pending.phoneCodeHash, MAX_HASH_BYTES)
    || !validText(pending.session, MAX_SESSION_BYTES)
    || (pending.codeDelivery !== "APP" && pending.codeDelivery !== "SMS")
  ) throw new TelegramAuthorizationStateError();
  return JSON.stringify({ version: 1, pending } satisfies StoredAuthorizationState);
}

export function parseTelegramAuthorizationState(serialized: string): TelegramPendingAuthorization {
  if (typeof serialized !== "string" || !serialized) throw new TelegramAuthorizationStateError();
  let value: unknown;
  try { value = JSON.parse(serialized); }
  catch { throw new TelegramAuthorizationStateError(); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TelegramAuthorizationStateError();
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(",") !== "pending,version" || root.version !== 1) {
    throw new TelegramAuthorizationStateError();
  }
  const pending = root.pending;
  if (typeof pending !== "object" || pending === null || Array.isArray(pending)) {
    throw new TelegramAuthorizationStateError();
  }
  const record = pending as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "codeDelivery,phoneCodeHash,phoneNumber,session") {
    throw new TelegramAuthorizationStateError();
  }
  const candidate = Object.freeze({
    phoneNumber: record.phoneNumber,
    phoneCodeHash: record.phoneCodeHash,
    session: record.session,
    codeDelivery: record.codeDelivery,
  }) as TelegramPendingAuthorization;
  serializeTelegramAuthorizationState(candidate);
  return candidate;
}
