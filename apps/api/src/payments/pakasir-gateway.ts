export type PakasirTransaction = Readonly<{
  project: string;
  orderCode: string;
  amountIdr: number;
  status: string;
  paymentMethod: string | null;
  completedAt: string | null;
}>;

export interface PakasirGateway {
  transactionDetail(input: Readonly<{ orderCode: string; amountIdr: number }>): Promise<PakasirTransaction>;
}

export class PakasirGatewayError extends Error {
  readonly code = "PAKASIR_UNAVAILABLE";
  constructor() { super("PAKASIR_UNAVAILABLE"); this.name = "PakasirGatewayError"; }
}

export class HttpPakasirGateway implements PakasirGateway {
  readonly #projectSlug: string;
  readonly #apiKey: string;
  readonly #timeoutMilliseconds: number;

  constructor(input: Readonly<{ projectSlug: string; apiKey: string; timeoutMilliseconds?: number }>) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.projectSlug)) throw new TypeError("INVALID_PAKASIR_PROJECT");
    if (!input.apiKey || input.apiKey.length > 512 || /[\0\r\n]/.test(input.apiKey)) throw new TypeError("INVALID_PAKASIR_API_KEY");
    const timeout = input.timeoutMilliseconds ?? 8_000;
    if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 30_000) throw new TypeError("INVALID_PAKASIR_TIMEOUT");
    this.#projectSlug = input.projectSlug;
    this.#apiKey = input.apiKey;
    this.#timeoutMilliseconds = timeout;
  }

  async transactionDetail(input: Readonly<{ orderCode: string; amountIdr: number }>): Promise<PakasirTransaction> {
    const url = new URL("https://app.pakasir.com/api/transactiondetail");
    url.searchParams.set("project", this.#projectSlug);
    url.searchParams.set("amount", String(input.amountIdr));
    url.searchParams.set("order_id", input.orderCode);
    url.searchParams.set("api_key", this.#apiKey);
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(this.#timeoutMilliseconds) });
    } catch { throw new PakasirGatewayError(); }
    if (!response.ok) throw new PakasirGatewayError();
    let body: unknown;
    try { body = await response.json(); } catch { throw new PakasirGatewayError(); }
    const value = typeof body === "object" && body !== null && "transaction" in body
      ? (body as { transaction?: unknown }).transaction : null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new PakasirGatewayError();
    const transaction = value as Record<string, unknown>;
    if (typeof transaction.project !== "string" || typeof transaction.order_id !== "string"
      || typeof transaction.amount !== "number" || !Number.isSafeInteger(transaction.amount)
      || typeof transaction.status !== "string") throw new PakasirGatewayError();
    return Object.freeze({
      project: transaction.project,
      orderCode: transaction.order_id,
      amountIdr: transaction.amount,
      status: transaction.status,
      paymentMethod: typeof transaction.payment_method === "string" ? transaction.payment_method : null,
      completedAt: typeof transaction.completed_at === "string" ? transaction.completed_at : null,
    });
  }
}
