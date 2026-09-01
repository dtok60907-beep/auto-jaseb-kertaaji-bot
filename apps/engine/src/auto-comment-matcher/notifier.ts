export interface AutoCommentNotificationResponder {
  sendCandidateNotification(input: Readonly<{
    chatId: number;
    candidateId: string;
    channelLabel: string;
    matchedKeywords: readonly string[];
    postPreview: string;
    templateText: string;
  }>): Promise<number>;
}

export class AutoCommentNotificationDeliveryError extends Error {
  constructor() {
    super("AUTO_COMMENT_NOTIFICATION_DELIVERY_FAILED");
    this.name = "AutoCommentNotificationDeliveryError";
  }
}

type FetchResponse = Readonly<{ ok: boolean; json(): Promise<unknown> }>;
type Fetcher = (input: string, init: RequestInit) => Promise<FetchResponse>;

const PREVIEW_MAX_LENGTH = 300;

function truncate(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

function callbackData(candidateId: string, decision: "TEPAT" | "OOT"): string {
  return `autocomment:${candidateId}:${decision}`;
}

export class TelegramAutoCommentNotifier implements AutoCommentNotificationResponder {
  readonly #botToken: string;
  readonly #fetch: Fetcher;

  constructor(input: Readonly<{ botToken: string; fetch?: Fetcher }>) {
    if (!/^\d+:[^\s]+$/.test(input.botToken)) throw new TypeError("INVALID_TELEGRAM_BOT_TOKEN");
    this.#botToken = input.botToken;
    this.#fetch = input.fetch ?? fetch;
  }

  async sendCandidateNotification(input: Parameters<AutoCommentNotificationResponder["sendCandidateNotification"]>[0]): Promise<number> {
    if (!Number.isSafeInteger(input.chatId)) throw new TypeError("INVALID_TELEGRAM_CHAT_ID");
    const text = [
      "Auto Komen Menfess: kandidat baru",
      "",
      `Channel: ${input.channelLabel}`,
      `Keyword cocok: ${input.matchedKeywords.join(", ")}`,
      "",
      "Post:",
      truncate(input.postPreview, PREVIEW_MAX_LENGTH),
      "",
      "Template balasan:",
      truncate(input.templateText, PREVIEW_MAX_LENGTH),
    ].join("\n");

    try {
      const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: input.chatId,
          text,
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Tepat", callback_data: callbackData(input.candidateId, "TEPAT") },
              { text: "🚫 OOT", callback_data: callbackData(input.candidateId, "OOT") },
            ]],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new AutoCommentNotificationDeliveryError();
      const body = await response.json();
      const messageId = (body as { result?: { message_id?: unknown } } | null)?.result?.message_id;
      if (!Number.isSafeInteger(messageId) || Number(messageId) <= 0) throw new AutoCommentNotificationDeliveryError();
      return Number(messageId);
    } catch (error) {
      if (error instanceof AutoCommentNotificationDeliveryError) throw error;
      throw new AutoCommentNotificationDeliveryError();
    }
  }
}
