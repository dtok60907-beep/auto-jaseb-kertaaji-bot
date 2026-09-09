import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { CheckoutServiceError, type PakasirCheckoutService } from "../payments/service.ts";
import { PakasirGatewayError } from "../payments/pakasir-gateway.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function orderId(request: FastifyRequest): string | null {
  const value = (request.params as { orderId?: unknown }).orderId;
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function checkoutFailure(reply: FastifyReply, error: unknown) {
  if (error instanceof PakasirGatewayError) return reply.code(503).send({ code: error.code });
  if (!(error instanceof CheckoutServiceError)) throw error;
  if (error.code === "PAYMENT_ORDER_NOT_FOUND" || error.code === "PACKAGE_NOT_FOUND") return reply.code(404).send({ code: error.code });
  if (error.code === "SUBSCRIPTION_ALREADY_ACTIVE" || error.code === "PAYMENT_NOT_COMPLETED") return reply.code(409).send({ code: error.code });
  if (error.code === "PAYMENT_VERIFICATION_FAILED") return reply.code(502).send({ code: error.code });
  return reply.code(422).send({ code: error.code });
}

export function registerPaymentRoutes(app: FastifyInstance, options: Readonly<{
  checkout: PakasirCheckoutService;
  authorizeUser: UserAuthorizer;
}>): void {
  const user = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    reply.header("cache-control", "no-store");
    const actor = await options.authorizeUser(request);
    if (actor) return actor.id;
    reply.code(401).send({ code: "USER_REQUIRED" });
    return null;
  };

  app.get("/v1/storefront", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    return options.checkout.storefront(userId);
  });

  app.post("/v1/payments/pakasir/orders", { bodyLimit: 2_048 }, async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    const body = request.body as Record<string, unknown> | null;
    if (!body || Object.keys(body).length !== 1 || typeof body.packageId !== "string") {
      return reply.code(422).send({ code: "INVALID_PACKAGE_ID" });
    }
    try {
      return reply.code(201).send({ order: await options.checkout.create(userId, body.packageId) });
    } catch (error) { return checkoutFailure(reply, error); }
  });

  app.get("/v1/payments/orders/:orderId", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    const id = orderId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_PAYMENT_ORDER_ID" });
    try { return { order: await options.checkout.get(userId, id) }; }
    catch (error) { return checkoutFailure(reply, error); }
  });

  app.post("/v1/payments/orders/:orderId/refresh", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    const id = orderId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_PAYMENT_ORDER_ID" });
    try { return { order: await options.checkout.refresh(userId, id) }; }
    catch (error) { return checkoutFailure(reply, error); }
  });

  app.post("/v1/payments/pakasir/webhook", { bodyLimit: 8_192 }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      await options.checkout.webhook(request.body);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof PakasirGatewayError) return reply.code(503).send({ code: error.code });
      if (error instanceof CheckoutServiceError) return reply.code(502).send({ code: error.code });
      throw error;
    }
  });
}
