import type { Sql } from "postgres";

import type { PaymentFulfillment, PaymentOrderRepository, PaymentOrderView } from "./repository.ts";

type OrderRow = Readonly<{
  id: string;
  user_id: string;
  provider_order_id: string;
  package_id: string;
  package_name: string;
  package_type: "JASEB_WORKER" | "USERBOT";
  amount_idr: string | number;
  project_slug: string;
  status: "PENDING" | "PAID";
  payment_method: string | null;
  created_at: string;
  paid_at: string | null;
  entitlement_id: string | null;
}>;

const SELECT_ORDER = `
  select payment.id::text, payment.user_id::text, payment.provider_order_id,
         payment.package_id::text, payment.package_snapshot->>'name' as package_name,
         payment.package_snapshot->>'packageType' as package_type,
         payment.amount_idr, payment.project_slug, payment.status,
         payment.payment_method, payment.created_at::text, payment.paid_at::text,
         payment.entitlement_id::text
    from public.payment_orders payment
`;

function view(row: OrderRow): PaymentOrderView {
  return Object.freeze({
    id: row.id,
    userId: row.user_id,
    orderCode: row.provider_order_id,
    packageId: row.package_id,
    packageName: row.package_name,
    packageType: row.package_type,
    amountIdr: Number(row.amount_idr),
    projectSlug: row.project_slug,
    status: row.status,
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    entitlementId: row.entitlement_id,
  });
}

export class PostgresPaymentOrderRepository implements PaymentOrderRepository {
  readonly #sql: Sql;

  constructor(sql: Sql) { this.#sql = sql; }

  async create(input: Parameters<PaymentOrderRepository["create"]>[0]): Promise<PaymentOrderView> {
    const created = await this.#sql<{ order_id: string }[]>`
      select order_id::text from public.create_payment_order(
        ${input.userId}::uuid, ${input.packageId}::uuid,
        ${input.projectSlug}, ${input.orderCode}
      )
    `;
    const order = created[0] ? await this.read(created[0].order_id) : null;
    if (!order) throw new Error("PAYMENT_ORDER_NOT_PERSISTED");
    return order;
  }

  async findOwned(input: Parameters<PaymentOrderRepository["findOwned"]>[0]): Promise<PaymentOrderView | null> {
    const rows = await this.#sql.unsafe<OrderRow[]>(`${SELECT_ORDER} where payment.id = $1::uuid and payment.user_id = $2::uuid`, [input.orderId, input.userId]);
    return rows[0] ? view(rows[0]) : null;
  }

  async findLatestPending(userId: string): Promise<PaymentOrderView | null> {
    const rows = await this.#sql.unsafe<OrderRow[]>(`${SELECT_ORDER} where payment.user_id = $1::uuid and payment.status = 'PENDING' order by payment.created_at desc limit 1`, [userId]);
    return rows[0] ? view(rows[0]) : null;
  }

  async findProviderOrder(input: Parameters<PaymentOrderRepository["findProviderOrder"]>[0]): Promise<PaymentOrderView | null> {
    const rows = await this.#sql.unsafe<OrderRow[]>(`${SELECT_ORDER} where payment.project_slug = $1 and payment.provider_order_id = $2 and payment.amount_idr = $3`, [input.projectSlug, input.orderCode, input.amountIdr]);
    return rows[0] ? view(rows[0]) : null;
  }

  async fulfill(input: Parameters<PaymentOrderRepository["fulfill"]>[0]): Promise<PaymentFulfillment> {
    const rows = await this.#sql<ReadonlyArray<{
      result_status: PaymentFulfillment["result"];
      fulfilled_entitlement_id: string | null;
      entitlement_expires_at: string | null;
    }>>`
      select result_status, fulfilled_entitlement_id::text, entitlement_expires_at::text
        from public.fulfill_payment_order(
          ${input.orderId}::uuid, ${input.paymentMethod}, ${input.completedAt}::timestamptz
        )
    `;
    const row = rows[0];
    if (!row) throw new Error("PAYMENT_FULFILLMENT_RESULT_MISSING");
    return Object.freeze({ result: row.result_status, entitlementId: row.fulfilled_entitlement_id, expiresAt: row.entitlement_expires_at });
  }

  private async read(orderId: string): Promise<PaymentOrderView | null> {
    const rows = await this.#sql.unsafe<OrderRow[]>(`${SELECT_ORDER} where payment.id = $1::uuid`, [orderId]);
    return rows[0] ? view(rows[0]) : null;
  }
}
