export type PaymentOrderStatus = "PENDING" | "PAID";

export type PaymentOrderView = Readonly<{
  id: string;
  userId: string;
  orderCode: string;
  packageId: string;
  packageName: string;
  packageType: "JASEB_WORKER" | "USERBOT";
  amountIdr: number;
  projectSlug: string;
  status: PaymentOrderStatus;
  paymentMethod: string | null;
  createdAt: string;
  paidAt: string | null;
  entitlementId: string | null;
}>;

export type PaymentFulfillment = Readonly<{
  result: "FULFILLED" | "ALREADY_PAID" | "NOT_FOUND";
  entitlementId: string | null;
  expiresAt: string | null;
}>;

export interface PaymentOrderRepository {
  create(input: Readonly<{
    userId: string;
    packageId: string;
    projectSlug: string;
    orderCode: string;
  }>): Promise<PaymentOrderView>;
  findOwned(input: Readonly<{ userId: string; orderId: string }>): Promise<PaymentOrderView | null>;
  findLatestPending(userId: string): Promise<PaymentOrderView | null>;
  findProviderOrder(input: Readonly<{
    projectSlug: string;
    orderCode: string;
    amountIdr: number;
  }>): Promise<PaymentOrderView | null>;
  fulfill(input: Readonly<{
    orderId: string;
    paymentMethod: string;
    completedAt: string;
  }>): Promise<PaymentFulfillment>;
}
