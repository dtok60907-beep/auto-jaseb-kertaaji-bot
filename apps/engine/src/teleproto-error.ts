import { TelegramAdapterError, type TelegramAdapterErrorCode, type TelegramSideEffectState } from "../../../packages/telegram-contract/src/index.ts";

export type TeleprotoOperation = "CONNECT" | "DISCONNECT" | "RESOLVE_TARGET" | "RESOLVE_SOURCE" | "JOIN" | "SEND_TEXT" | "FORWARD";

function errorNames(error: unknown): ReadonlySet<string> {
  const names = new Set<string>();
  let current: unknown = typeof error === "object" && error !== null ? (error as object).constructor : null;
  while (typeof current === "function" && current.name) {
    names.add(current.name);
    current = Object.getPrototypeOf(current);
  }
  return names;
}

function positiveSeconds(value: unknown): number | null {
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

function networkCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function mapped(input: Readonly<{
  code: TelegramAdapterErrorCode;
  retryable: boolean;
  retryAfterSeconds?: number | null;
  sideEffectState?: TelegramSideEffectState;
  cause: unknown;
}>): TelegramAdapterError {
  return new TelegramAdapterError(input);
}

export function mapTeleprotoError(error: unknown, operation: TeleprotoOperation): TelegramAdapterError {
  if (error instanceof TelegramAdapterError) return error;
  const names = errorNames(error);
  const isSource = operation === "RESOLVE_SOURCE" || operation === "FORWARD";
  const hasPossibleSideEffect = operation === "JOIN" || operation === "SEND_TEXT" || operation === "FORWARD";

  if (names.has("FloodWaitError") || names.has("SlowModeWaitError")) {
    return mapped({ code: "FLOOD_WAIT", retryable: true, retryAfterSeconds: positiveSeconds((error as { seconds?: unknown } | null)?.seconds), cause: error });
  }
  if (names.has("PeerFloodError")) return mapped({ code: "FLOOD_WAIT", retryable: false, cause: error });
  if (["AuthKeyUnregisteredError", "AuthKeyInvalidError", "SessionRevokedError", "SessionExpiredError", "UserDeactivatedError", "UserDeactivatedBanError"].some((name) => names.has(name))) {
    return mapped({ code: "SESSION_REVOKED", retryable: false, cause: error });
  }
  if (names.has("AuthKeyDuplicatedError")) return mapped({ code: "SESSION_CONFLICT", retryable: false, cause: error });
  if (["ChannelsTooMuchError", "UserChannelsTooMuchError"].some((name) => names.has(name))) {
    return mapped({ code: "ACCOUNT_GROUP_LIMIT_REACHED", retryable: false, cause: error });
  }
  if (names.has("InviteRequestSentError")) return mapped({ code: "JOIN_APPROVAL_REQUIRED", retryable: false, cause: error });
  if (["ChatForwardsRestrictedError", "MessageAuthorRequiredError"].some((name) => names.has(name))) {
    return mapped({ code: "FORWARD_FORBIDDEN", retryable: false, cause: error });
  }
  if ([
    "ChatWriteForbiddenError", "ChatGuestSendForbiddenError", "UserBannedInChannelError",
    "ChatSendPlainForbiddenError", "ChatSendMediaForbiddenError", "ChatSendPhotosForbiddenError",
    "ChatSendVideosForbiddenError", "ChatSendDocsForbiddenError", "ChatForbiddenError",
  ].some((name) => names.has(name))) {
    return mapped({ code: "CHAT_WRITE_FORBIDDEN", retryable: false, cause: error });
  }
  if (["MessageIdInvalidError", "MsgIdInvalidError", "MessageEmptyError"].some((name) => names.has(name)) && isSource) {
    return mapped({ code: "SOURCE_NOT_FOUND", retryable: false, cause: error });
  }
  if (["UsernameNotOccupiedError", "UsernameInvalidError", "ChannelInvalidError", "PeerIdInvalidError", "PublicChannelMissingError", "ChannelPrivateError"].some((name) => names.has(name))) {
    return mapped({ code: isSource ? "SOURCE_NOT_FOUND" : "TARGET_NOT_FOUND", retryable: false, cause: error });
  }

  const transientCodes = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN"]);
  if (names.has("TimeoutError") || names.has("AbortError") || transientCodes.has(networkCode(error) ?? "")) {
    return mapped({ code: "TELEGRAM_TRANSIENT", retryable: true, sideEffectState: hasPossibleSideEffect ? "UNKNOWN" : "NOT_SENT", cause: error });
  }
  return mapped({
    code: "TELEGRAM_UNKNOWN",
    retryable: false,
    sideEffectState: hasPossibleSideEffect ? "UNKNOWN" : "NOT_SENT",
    cause: error,
  });
}

export function isTeleprotoErrorNamed(error: unknown, name: string): boolean {
  return errorNames(error).has(name);
}
