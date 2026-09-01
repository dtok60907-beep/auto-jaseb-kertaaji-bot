export interface TelegramCallbackResponder {
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  editMessageText(input: Readonly<{ chatId: number; messageId: number; text: string }>): Promise<void>;
}

export class TelegramCallbackDeliveryError extends Error {
  constructor() {
    super("TELEGRAM_CALLBACK_DELIVERY_FAILED");
    this.name = "TelegramCallbackDeliveryError";
  }
}

type FetchResponse = Readonly<{ ok: boolean }>;
type Fetcher = (input: string, init: RequestInit) => Promise<FetchResponse>;

export class TelegramBotCallbackResponder implements TelegramCallbackResponder {
  readonly #botToken: string;
  readonly #fetch: Fetcher;

  constructor(input: Readonly<{ botToken: string; fetch?: Fetcher }>) {
    if (!/^\d+:[^\s]+$/.test(input.botToken)) throw new TypeError("INVALID_TELEGRAM_BOT_TOKEN");
    this.#botToken = input.botToken;
    this.#fetch = input.fetch ?? fetch;
  }

  async #call(method: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    try {
      const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new TelegramCallbackDeliveryError();
    } catch (error) {
      if (error instanceof TelegramCallbackDeliveryError) throw error;
      throw new TelegramCallbackDeliveryError();
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (typeof callbackQueryId !== "string" || !callbackQueryId.trim()) throw new TypeError("INVALID_TELEGRAM_CALLBACK_QUERY_ID");
    await this.#call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: false });
  }

  async editMessageText(input: Parameters<TelegramCallbackResponder["editMessageText"]>[0]): Promise<void> {
    if (!Number.isSafeInteger(input.chatId) || !Number.isSafeInteger(input.messageId)) throw new TypeError("INVALID_TELEGRAM_MESSAGE_REFERENCE");
    await this.#call("editMessageText", { chat_id: input.chatId, message_id: input.messageId, text: input.text });
  }
}
