export const TELEGRAM_ADAPTER_ERROR_CODES = [
  "ADAPTER_NOT_READY",
  "SESSION_REVOKED",
  "SESSION_CONFLICT",
  "FLOOD_WAIT",
  "TARGET_NOT_FOUND",
  "SOURCE_NOT_FOUND",
  "JOIN_APPROVAL_REQUIRED",
  "ACCOUNT_GROUP_LIMIT_REACHED",
  "CHAT_WRITE_FORBIDDEN",
  "FORWARD_FORBIDDEN",
  "SOURCE_ATTRIBUTION_UNSUPPORTED",
  "TELEGRAM_TRANSIENT",
  "TELEGRAM_UNKNOWN",
] as const;
export type TelegramAdapterErrorCode = (typeof TELEGRAM_ADAPTER_ERROR_CODES)[number];
export type TelegramSideEffectState = "NOT_SENT" | "UNKNOWN";

export class TelegramAdapterError extends Error {
  readonly code: TelegramAdapterErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;
  readonly sideEffectState: TelegramSideEffectState;
  constructor(input: Readonly<{ code: TelegramAdapterErrorCode; retryable: boolean; retryAfterSeconds?: number | null; sideEffectState?: TelegramSideEffectState; cause?: unknown }>) {
    super(input.code, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "TelegramAdapterError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
    this.sideEffectState = input.sideEffectState ?? "NOT_SENT";
  }
  publicData() { return Object.freeze({ code: this.code, retryable: this.retryable, retryAfterSeconds: this.retryAfterSeconds, sideEffectState: this.sideEffectState }); }
}

export type TelegramAdapterState = "NEW" | "CONNECTING" | "READY" | "DISCONNECTING" | "DISCONNECTED" | "FAILED";
export type TelegramTarget = Readonly<{
  canonicalRef: string;
  entityType: "GROUP" | "SUPERGROUP" | "CHANNEL";
  membership: "MEMBER" | "NOT_MEMBER" | "UNKNOWN";
  title: string | null;
}>;
export type TelegramJoinResult = Readonly<{
  state: "JOINED" | "ALREADY_MEMBER" | "APPROVAL_REQUESTED";
}>;
export type TelegramLinkedDiscussion = Readonly<{
  source: TelegramTarget;
  discussion: TelegramTarget | null;
}>;
export type TelegramDeliveryReceipt = Readonly<{ providerMessageIds: readonly string[]; sentAt: string }>;
export type NativeForwardRequest = Readonly<{
  targetRef: string;
  source: Readonly<{ channelUsername: string; messageId: number }>;
  sourceAttribution: "SHOW_SOURCE" | "HIDE_SOURCE";
}>;
export type IncomingChannelMessage = Readonly<{ channelPostId: string; text: string }>;

export interface TelegramDeliveryAdapter {
  readonly state: TelegramAdapterState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  resolveTarget(targetRef: string): Promise<TelegramTarget>;
  resolveLinkedDiscussion(sourceChannelRef: string): Promise<TelegramLinkedDiscussion>;
  joinPublicTarget(targetRef: string): Promise<TelegramJoinResult>;
  sendText(input: Readonly<{ targetRef: string; text: string }>): Promise<TelegramDeliveryReceipt>;
  /**
   * Resolves the source message and any grouped album siblings, then invokes
   * Telegram's native forward operation once with the full ordered message set.
   */
  forwardNative(input: NativeForwardRequest): Promise<TelegramDeliveryReceipt>;
  /**
   * Lists posts newer than afterMessageId in a channel/group, oldest first,
   * up to limit. A bounded, one-shot poll rather than a live subscription, so
   * it fits the engine's connect-drain-disconnect per-account cycle.
   */
  listNewChannelPosts(channelRef: string, input: Readonly<{ afterMessageId: number; limit: number }>): Promise<readonly IncomingChannelMessage[]>;
  /**
   * The id of the most recent post in a channel/group, or null if it has
   * none yet. Used once to seed a monitoring checkpoint without backfilling
   * a channel's entire history.
   */
  latestChannelPostId(channelRef: string): Promise<string | null>;
}

export function telegramDeliveryReceipt(providerMessageIds: readonly string[], sentAt: string): TelegramDeliveryReceipt {
  if (!Array.isArray(providerMessageIds) || providerMessageIds.length === 0 || providerMessageIds.some((id) => typeof id !== "string" || id.trim() === "") || new Set(providerMessageIds).size !== providerMessageIds.length) throw new TypeError("INVALID_PROVIDER_MESSAGE_IDS");
  if (typeof sentAt !== "string" || Number.isNaN(Date.parse(sentAt))) throw new TypeError("INVALID_PROVIDER_SENT_AT");
  return Object.freeze({ providerMessageIds: Object.freeze(providerMessageIds.slice()), sentAt });
}
