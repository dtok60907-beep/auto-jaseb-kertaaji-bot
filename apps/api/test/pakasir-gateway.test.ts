import assert from "node:assert/strict";
import test from "node:test";

import { HttpPakasirGateway, PakasirGatewayError } from "../src/payments/pakasir-gateway.ts";

test("Pakasir gateway sends secret only to the fixed transaction-detail origin", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://app.pakasir.com");
    assert.equal(url.pathname, "/api/transactiondetail");
    assert.equal(url.searchParams.get("project"), "auto-promosi-kertaaji");
    assert.equal(url.searchParams.get("api_key"), "secret-key");
    return new Response(JSON.stringify({ transaction: {
      project: "auto-promosi-kertaaji", order_id: "KRT-TEST-00000001", amount: 99000,
      status: "completed", payment_method: "qris", completed_at: "2026-09-09T00:01:00.000Z",
    } }), { status: 200 });
  };
  const gateway = new HttpPakasirGateway({ projectSlug: "auto-promosi-kertaaji", apiKey: "secret-key" });
  assert.equal((await gateway.transactionDetail({ orderCode: "KRT-TEST-00000001", amountIdr: 99_000 })).status, "completed");
});

test("Pakasir gateway fails closed on malformed provider responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response("not-json", { status: 200 });
  const gateway = new HttpPakasirGateway({ projectSlug: "auto-promosi-kertaaji", apiKey: "secret-key" });
  await assert.rejects(() => gateway.transactionDetail({ orderCode: "KRT-TEST-00000001", amountIdr: 99_000 }), PakasirGatewayError);
});
