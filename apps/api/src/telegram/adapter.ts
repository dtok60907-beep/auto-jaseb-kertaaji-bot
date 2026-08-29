import type { BroadcastMaterial } from "../domain/broadcast-material.ts";

export const TELEGRAM_ADAPTER_ERROR_CODES = [
  "ADAPTER_NOT_READY",
  "SESSION_REVOKED",
  "SESSION_CONFLICT",
  "FLOOD_WAIT",
  "TARGET_NOT_FOUND",
  "SOURCE_NOT_FOUND",
  "JOIN_APPROVAL_REQUIRED",
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
}>;
export type TelegramDeliveryReceipt = Readonly<{ providerMessageIds: readonly string[]; sentAt: string }>;
export type NativeForwardRequest = Readonly<{
  targetRef: string;
  source: Readonly<{ channelUsername: string; messageId: number }>;
  sourceAttribution: "SHOW_SOURCE" | "HIDE_SOURCE";
}>;

export interface TelegramDeliveryAdapter {
  readonly state: TelegramAdapterState;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  resolveTarget(targetRef: string): Promise<TelegramTarget>;
  joinPublicTarget(targetRef: string): Promise<Readonly<{ state: "JOINED" | "ALREADY_MEMBER" }>>;
  sendText(input: Readonly<{ targetRef: string; text: string }>): Promise<TelegramDeliveryReceipt>;
  /**
   * Resolves the source message and any grouped album siblings, then invokes
   * Telegram's native forward operation once with the full ordered message set.
   */
  forwardNative(input: NativeForwardRequest): Promise<TelegramDeliveryReceipt>;
}

export function telegramDeliveryReceipt(providerMessageIds: readonly string[], sentAt: string): TelegramDeliveryReceipt {
  if (!Array.isArray(providerMessageIds) || providerMessageIds.length === 0 || providerMessageIds.some((id) => typeof id !== "string" || id.trim() === "") || new Set(providerMessageIds).size !== providerMessageIds.length) throw new TypeError("INVALID_PROVIDER_MESSAGE_IDS");
  if (typeof sentAt !== "string" || Number.isNaN(Date.parse(sentAt))) throw new TypeError("INVALID_PROVIDER_SENT_AT");
  return Object.freeze({ providerMessageIds: Object.freeze(providerMessageIds.slice()), sentAt });
}

export async function deliverBroadcastMaterial(adapter: TelegramDeliveryAdapter, targetRef: string, material: BroadcastMaterial): Promise<TelegramDeliveryReceipt> {
  if (material.kind === "TEXT") return adapter.sendText({ targetRef, text: material.text });
  return adapter.forwardNative({ targetRef, source: { channelUsername: material.source.channelUsername, messageId: material.source.messageId }, sourceAttribution: material.sourceAttribution });
}
