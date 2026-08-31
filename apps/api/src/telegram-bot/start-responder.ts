export interface TelegramStartResponder {
  sendStart(chatId: number): Promise<void>;
}

export class TelegramStartDeliveryError extends Error {
  constructor() {
    super("TELEGRAM_START_DELIVERY_FAILED");
    this.name = "TelegramStartDeliveryError";
  }
}

type FetchResponse = Readonly<{ ok: boolean }>;
type Fetcher = (input: string, init: RequestInit) => Promise<FetchResponse>;

const START_MESSAGE = `Selamat datang di Kertaaji.

Fitur yang tersedia:
1. Jaseb untuk mengirim materi ke grup atau channel target.
2. Auto Comment untuk mengatur komentar otomatis pada posting channel.
3. Userbot untuk menghubungkan dan memilih akun Telegram yang dipakai.

Fitur yang bisa digunakan mengikuti paket akunmu.

Tekan Buka Mini App untuk masuk dan mengatur layanan.`;

export class TelegramBotStartResponder implements TelegramStartResponder {
  readonly #botToken: string;
  readonly #miniAppUrl: string;
  readonly #fetch: Fetcher;

  constructor(input: Readonly<{ botToken: string; miniAppUrl: string; fetch?: Fetcher }>) {
    if (!/^\d+:[^\s]+$/.test(input.botToken)) throw new TypeError("INVALID_TELEGRAM_BOT_TOKEN");
    let url: URL;
    try { url = new URL(input.miniAppUrl); }
    catch { throw new TypeError("INVALID_TELEGRAM_MINI_APP_URL"); }
    if (url.protocol !== "https:") throw new TypeError("INVALID_TELEGRAM_MINI_APP_URL");
    this.#botToken = input.botToken;
    this.#miniAppUrl = url.toString();
    this.#fetch = input.fetch ?? fetch;
  }

  async sendStart(chatId: number): Promise<void> {
    if (!Number.isSafeInteger(chatId)) throw new TypeError("INVALID_TELEGRAM_CHAT_ID");
    try {
      const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: START_MESSAGE,
          reply_markup: {
            inline_keyboard: [[{
              text: "Buka Mini App",
              web_app: { url: this.#miniAppUrl },
            }]],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new TelegramStartDeliveryError();
    } catch (error) {
      if (error instanceof TelegramStartDeliveryError) throw error;
      throw new TelegramStartDeliveryError();
    }
  }
}
