import { randomBytes } from "node:crypto";

import type { EntitlementRepository, EntitlementView } from "../entitlements/repository.ts";
import type { PackageRepository } from "../packages/repository.ts";
import type { PakasirGateway, PakasirTransaction } from "./pakasir-gateway.ts";
import type { PaymentOrderRepository, PaymentOrderView } from "./repository.ts";

export type CheckoutOrder = PaymentOrderView & Readonly<{ checkoutUrl: string }>;
export type Storefront = Readonly<{
  packages: Awaited<ReturnType<PackageRepository["list"]>>;
  activeEntitlements: readonly EntitlementView[];
  pendingOrder: CheckoutOrder | null;
}>;

export class CheckoutServiceError extends Error {
  readonly code: "INVALID_PACKAGE_ID" | "PACKAGE_NOT_FOUND" | "PACKAGE_NOT_PURCHASABLE" | "SUBSCRIPTION_ALREADY_ACTIVE" | "PAYMENT_ORDER_NOT_FOUND" | "PAYMENT_NOT_COMPLETED" | "PAYMENT_VERIFICATION_FAILED";
  constructor(code: CheckoutServiceError["code"]) { super(code); this.name = "CheckoutServiceError"; this.code = code; }
}

function active(entitlements: readonly EntitlementView[], now = Date.now()): readonly EntitlementView[] {
  return entitlements.filter((item) => item.status === "ACTIVE" && Date.parse(item.expiresAt) > now);
}

export class PakasirCheckoutService {
  readonly #orders: PaymentOrderRepository;
  readonly #packages: PackageRepository;
  readonly #entitlements: EntitlementRepository;
  readonly #gateway: PakasirGateway;
  readonly #projectSlug: string;
  readonly #returnUrl: string;
  readonly #newOrderCode: () => string;

  constructor(input: Readonly<{
    orders: PaymentOrderRepository;
    packages: PackageRepository;
    entitlements: EntitlementRepository;
    gateway: PakasirGateway;
    projectSlug: string;
    returnUrl: string;
    newOrderCode?: () => string;
  }>) {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.projectSlug)) throw new TypeError("INVALID_PAKASIR_PROJECT");
    const returnUrl = new URL(input.returnUrl);
    if (returnUrl.protocol !== "https:") throw new TypeError("INVALID_PAYMENT_RETURN_URL");
    this.#orders = input.orders;
    this.#packages = input.packages;
    this.#entitlements = input.entitlements;
    this.#gateway = input.gateway;
    this.#projectSlug = input.projectSlug;
    this.#returnUrl = returnUrl.toString();
    this.#newOrderCode = input.newOrderCode ?? (() => `KRT-${Date.now().toString(36).toUpperCase()}-${randomBytes(6).toString("hex").toUpperCase()}`);
  }

  #withCheckoutUrl(order: PaymentOrderView): CheckoutOrder {
    const url = new URL(`https://app.pakasir.com/pay/${this.#projectSlug}/${order.amountIdr}`);
    const redirect = new URL(this.#returnUrl);
    redirect.searchParams.set("payment_return", "1");
    redirect.searchParams.set("payment_order_id", order.id);
    url.searchParams.set("order_id", order.orderCode);
    url.searchParams.set("redirect", redirect.toString());
    return Object.freeze({ ...order, checkoutUrl: url.toString() });
  }

  async storefront(userId: string): Promise<Storefront> {
    const [packages, entitlements, pending] = await Promise.all([
      this.#packages.list({ includeInactive: false }),
      this.#entitlements.list(userId),
      this.#orders.findLatestPending(userId),
    ]);
    return Object.freeze({ packages, activeEntitlements: Object.freeze([...active(entitlements)]), pendingOrder: pending ? this.#withCheckoutUrl(pending) : null });
  }

  async create(userId: string, packageId: string): Promise<CheckoutOrder> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packageId)) throw new CheckoutServiceError("INVALID_PACKAGE_ID");
    if (active(await this.#entitlements.list(userId)).length > 0) throw new CheckoutServiceError("SUBSCRIPTION_ALREADY_ACTIVE");
    try {
      const order = await this.#orders.create({ userId, packageId, projectSlug: this.#projectSlug, orderCode: this.#newOrderCode() });
      return this.#withCheckoutUrl(order);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("PACKAGE_NOT_PURCHASABLE")) throw new CheckoutServiceError("PACKAGE_NOT_PURCHASABLE");
      if (message.includes("PACKAGE_NOT_FOUND") || message.includes("active package not found")) throw new CheckoutServiceError("PACKAGE_NOT_FOUND");
      throw error;
    }
  }

  async get(userId: string, orderId: string): Promise<CheckoutOrder> {
    const order = await this.#orders.findOwned({ userId, orderId });
    if (!order) throw new CheckoutServiceError("PAYMENT_ORDER_NOT_FOUND");
    return this.#withCheckoutUrl(order);
  }

  async refresh(userId: string, orderId: string): Promise<CheckoutOrder> {
    const order = await this.#orders.findOwned({ userId, orderId });
    if (!order) throw new CheckoutServiceError("PAYMENT_ORDER_NOT_FOUND");
    if (order.status === "PAID") return this.#withCheckoutUrl(order);
    const transaction = await this.#gateway.transactionDetail({ orderCode: order.orderCode, amountIdr: order.amountIdr });
    await this.#verifyAndFulfill(order, transaction);
    return this.get(userId, orderId);
  }

  async webhook(body: unknown): Promise<void> {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const value = body as Record<string, unknown>;
    if (value.project !== this.#projectSlug || value.status !== "completed"
      || typeof value.order_id !== "string" || typeof value.amount !== "number"
      || !Number.isSafeInteger(value.amount) || value.amount <= 0) return;
    const order = await this.#orders.findProviderOrder({ projectSlug: this.#projectSlug, orderCode: value.order_id, amountIdr: value.amount });
    if (!order || order.status === "PAID") return;
    const transaction = await this.#gateway.transactionDetail({ orderCode: order.orderCode, amountIdr: order.amountIdr });
    await this.#verifyAndFulfill(order, transaction);
  }

  async #verifyAndFulfill(order: PaymentOrderView, transaction: PakasirTransaction): Promise<void> {
    if (transaction.project !== this.#projectSlug || transaction.orderCode !== order.orderCode
      || transaction.amountIdr !== order.amountIdr) throw new CheckoutServiceError("PAYMENT_VERIFICATION_FAILED");
    if (transaction.status !== "completed" || !transaction.paymentMethod || !transaction.completedAt
      || !Number.isFinite(Date.parse(transaction.completedAt))) throw new CheckoutServiceError("PAYMENT_NOT_COMPLETED");
    const fulfilled = await this.#orders.fulfill({ orderId: order.id, paymentMethod: transaction.paymentMethod, completedAt: transaction.completedAt });
    if (fulfilled.result === "NOT_FOUND") throw new CheckoutServiceError("PAYMENT_ORDER_NOT_FOUND");
  }
}
