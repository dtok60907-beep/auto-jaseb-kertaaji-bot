import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { EntitlementValidationError, validateEntitlementGrant } from "../domain/entitlement.ts";
import type { EntitlementRepository } from "../entitlements/repository.ts";
import type { AdminAuthorizer } from "./package-routes.ts";

export function registerEntitlementRoutes(app: FastifyInstance, options: { entitlements: EntitlementRepository; authorizeAdmin: AdminAuthorizer }) {
  const admin = async (request: FastifyRequest, reply: FastifyReply) => { if (await options.authorizeAdmin(request)) return true; reply.code(403).send({ code: "ADMIN_REQUIRED" }); return false; };
  const uid = (request: FastifyRequest) => { const value = (request.params as { userId?: unknown }).userId; return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null; };
  app.get("/v1/admin/users/:userId/entitlements", async (request, reply) => { if (!await admin(request, reply)) return; const userId = uid(request); if (!userId) return reply.code(400).send({ code: "INVALID_USER_ID" }); return { entitlements: await options.entitlements.list(userId) }; });
  app.post("/v1/admin/users/:userId/entitlements", async (request, reply) => { if (!await admin(request, reply)) return; const userId = uid(request); if (!userId) return reply.code(400).send({ code: "INVALID_USER_ID" }); let grant; try { grant = validateEntitlementGrant(request.body); } catch (error) { if (error instanceof EntitlementValidationError) return reply.code(422).send({ code: "INVALID_ENTITLEMENT", issues: error.issues }); throw error; } const entitlement = await options.entitlements.grant({ userId, grant }); return reply.code(201).send({ entitlement }); });
  app.post("/v1/admin/entitlements/:id/extend", async (request, reply) => { if (!await admin(request, reply)) return; const id = (request.params as { id?: string }).id; const days = (request.body as Record<string, unknown> | null)?.durationDays; if (!id || typeof days !== "number" || !Number.isInteger(days) || days <= 0) return reply.code(422).send({ code: "INVALID_EXTENSION" }); const entitlement = await options.entitlements.extend(id, days); if (!entitlement) return reply.code(404).send({ code: "ENTITLEMENT_NOT_FOUND" }); return { entitlement }; });
  app.post("/v1/admin/entitlements/:id/revoke", async (request, reply) => { if (!await admin(request, reply)) return; const id = (request.params as { id?: string }).id; if (!id || !await options.entitlements.revoke(id)) return reply.code(404).send({ code: "ENTITLEMENT_NOT_FOUND" }); return reply.code(204).send(null); });
}
