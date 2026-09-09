import assert from "node:assert/strict";
import test from "node:test";

import type { EntitlementRepository, EntitlementView } from "../src/entitlements/repository.ts";
import type { PackageRepository, PackageView } from "../src/packages/repository.ts";
import type { PakasirGateway, PakasirTransaction } from "../src/payments/pakasir-gateway.ts";
import { CheckoutServiceError, PakasirCheckoutService } from "../src/payments/service.ts";
import type { PaymentFulfillment, PaymentOrderRepository, PaymentOrderView } from "../src/payments/repository.ts";
import { createApi } from "../src/app.ts";

const USER = "10000000-0000-4000-8000-000000000001";
const PACKAGE = "20000000-0000-4000-8000-000000000002";
const ORDER = "30000000-0000-4000-8000-000000000003";

const pkg: PackageView = Object.freeze({
  id: PACKAGE, code: "userbot-30", name: "Userbot 30 Hari", type: "USERBOT",
  priceIdr: 99_000, durationDays: 30, features: ["JASEB", "AUTO_COMMENT_MF"] as const,
  maxTargetsPerMinute: 5, maxAccounts: 1, intervalMinSeconds: 300,
  intervalMaxSeconds: 86_400, displayOrder: 0, active: true, version: 1,
});

function order(status: "PENDING" | "PAID" = "PENDING"): PaymentOrderView {
  return Object.freeze({
    id: ORDER, userId: USER, orderCode: "KRT-TEST-00000001", packageId: PACKAGE,
    packageName: pkg.name, packageType: "USERBOT", amountIdr: 99_000,
    projectSlug: "auto-promosi-kertaaji", status, paymentMethod: status === "PAID" ? "qris" : null,
    createdAt: "2026-09-09T00:00:00.000Z", paidAt: status === "PAID" ? "2026-09-09T00:01:00.000Z" : null,
    entitlementId: status === "PAID" ? "40000000-0000-4000-8000-000000000004" : null,
  });
}

class FakeOrders implements PaymentOrderRepository {
  current = order();
  fulfillments: Parameters<PaymentOrderRepository["fulfill"]>[0][] = [];
  async create(): Promise<PaymentOrderView> { return this.current; }
  async findOwned(input: Parameters<PaymentOrderRepository["findOwned"]>[0]) { return input.userId === USER && input.orderId === ORDER ? this.current : null; }
  async findLatestPending() { return this.current.status === "PENDING" ? this.current : null; }
  async findProviderOrder(input: Parameters<PaymentOrderRepository["findProviderOrder"]>[0]) {
    return input.orderCode === this.current.orderCode && input.amountIdr === this.current.amountIdr && input.projectSlug === this.current.projectSlug ? this.current : null;
  }
  async fulfill(input: Parameters<PaymentOrderRepository["fulfill"]>[0]): Promise<PaymentFulfillment> {
    this.fulfillments.push(input); this.current = order("PAID");
    return Object.freeze({ result: "FULFILLED", entitlementId: this.current.entitlementId, expiresAt: "2026-10-09T00:00:00.000Z" });
  }
}

class FakePackages implements PackageRepository {
  async list() { return [pkg]; }
  async create() { return pkg; }
  async publish() { return pkg; }
}

class FakeEntitlements implements EntitlementRepository {
  values: EntitlementView[] = [];
  async list() { return this.values; }
  async grant(): Promise<EntitlementView> { throw new Error("unused"); }
  async extend(): Promise<EntitlementView | null> { throw new Error("unused"); }
  async revoke(): Promise<boolean> { throw new Error("unused"); }
}

class FakeGateway implements PakasirGateway {
  transaction: PakasirTransaction = Object.freeze({
    project: "auto-promosi-kertaaji", orderCode: "KRT-TEST-00000001", amountIdr: 99_000,
    status: "completed", paymentMethod: "qris", completedAt: "2026-09-09T00:01:00.000Z",
  });
  calls = 0;
  async transactionDetail() { this.calls += 1; return this.transaction; }
}

function fixture() {
  const orders = new FakeOrders();
  const entitlements = new FakeEntitlements();
  const gateway = new FakeGateway();
  const service = new PakasirCheckoutService({
    orders, entitlements, gateway, packages: new FakePackages(),
    projectSlug: "auto-promosi-kertaaji", returnUrl: "https://mini.example.com/app",
    newOrderCode: () => "KRT-TEST-00000001",
  });
  return { service, orders, entitlements, gateway };
}

test("storefront returns active packages and a resumable Pakasir checkout URL", async () => {
  const { service } = fixture();
  const storefront = await service.storefront(USER);
  assert.equal(storefront.packages[0]?.id, PACKAGE);
  assert.equal(storefront.activeEntitlements.length, 0);
  const url = new URL(storefront.pendingOrder!.checkoutUrl);
  assert.equal(url.pathname, "/pay/auto-promosi-kertaaji/99000");
  assert.equal(url.searchParams.get("order_id"), "KRT-TEST-00000001");
  const redirect = new URL(url.searchParams.get("redirect")!);
  assert.equal(redirect.searchParams.get("payment_return"), "1");
  assert.equal(redirect.searchParams.get("payment_order_id"), ORDER);
  assert.equal(url.toString().includes("api_key"), false);
});

test("checkout is only created for a buyer without an active subscription", async () => {
  const { service, entitlements } = fixture();
  const created = await service.create(USER, PACKAGE);
  assert.equal(created.amountIdr, 99_000);
  entitlements.values = [{ id: "entitlement", userId: USER, packageId: PACKAGE, packageType: "USERBOT", status: "ACTIVE", startsAt: "2026-09-09T00:00:00Z", expiresAt: "2099-10-09T00:00:00Z", maxLpmGroups: 5, maxChannelTargets: 5 }];
  await assert.rejects(() => service.create(USER, PACKAGE), (error) => error instanceof CheckoutServiceError && error.code === "SUBSCRIPTION_ALREADY_ACTIVE");
});

test("webhook re-checks Pakasir transaction detail before exactly-once fulfillment", async () => {
  const { service, orders, gateway } = fixture();
  await service.webhook({ project: "auto-promosi-kertaaji", order_id: "KRT-TEST-00000001", amount: 99_000, status: "completed" });
  assert.equal(gateway.calls, 1);
  assert.equal(orders.fulfillments.length, 1);
  await service.webhook({ project: "auto-promosi-kertaaji", order_id: "KRT-TEST-00000001", amount: 99_000, status: "completed" });
  assert.equal(gateway.calls, 1);
  assert.equal(orders.fulfillments.length, 1);
});

test("spoofed or mismatched payment data never activates a subscription", async () => {
  const { service, orders, gateway } = fixture();
  await service.webhook({ project: "other-project", order_id: "KRT-TEST-00000001", amount: 99_000, status: "completed" });
  assert.equal(gateway.calls, 0);
  gateway.transaction = { ...gateway.transaction, amountIdr: 1 };
  await assert.rejects(
    () => service.webhook({ project: "auto-promosi-kertaaji", order_id: "KRT-TEST-00000001", amount: 99_000, status: "completed" }),
    (error) => error instanceof CheckoutServiceError && error.code === "PAYMENT_VERIFICATION_FAILED",
  );
  assert.equal(orders.fulfillments.length, 0);
});

test("HTTP checkout routes require a buyer while verified Pakasir webhook remains public", async (t) => {
  const { service, orders } = fixture();
  const packages = new FakePackages();
  const entitlements = new FakeEntitlements();
  const api = createApi({
    packages,
    broadcasts: {} as never,
    autoComments: {} as never,
    entitlements,
    checkout: service,
    authorizeUser: async (request) => request.headers.authorization === "Bearer buyer" ? { id: USER } : null,
    authorizeAdmin: async () => null,
  });
  t.after(() => api.close());

  const denied = await api.inject({ method: "POST", url: "/v1/payments/pakasir/orders", payload: { packageId: PACKAGE } });
  const created = await api.inject({ method: "POST", url: "/v1/payments/pakasir/orders", headers: { authorization: "Bearer buyer" }, payload: { packageId: PACKAGE } });
  const webhook = await api.inject({ method: "POST", url: "/v1/payments/pakasir/webhook", payload: { project: "auto-promosi-kertaaji", order_id: "KRT-TEST-00000001", amount: 99_000, status: "completed" } });

  assert.equal(denied.statusCode, 401);
  assert.equal(created.statusCode, 201);
  assert.equal(new URL(created.json().order.checkoutUrl).hostname, "app.pakasir.com");
  assert.equal(webhook.statusCode, 204);
  assert.equal(orders.fulfillments.length, 1);
});
