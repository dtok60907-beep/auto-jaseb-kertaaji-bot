import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BroadcastOperationRepository } from "../broadcast-operations/repository.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerBroadcastOperationRoutes(app: FastifyInstance, options: { operations: BroadcastOperationRepository; authorizeUser: UserAuthorizer }) {
  const user = async (request: FastifyRequest, reply: FastifyReply) => { const actor = await options.authorizeUser(request); if (actor) return actor.id; reply.code(401).send({ code: "USER_REQUIRED" }); return null; };
  app.post("/v1/broadcast/operations", async (request, reply) => {
    const userId = await user(request, reply); if (!userId) return;
    return reply.code(410).send({ code: "BROADCAST_SERVICE_TOGGLE_REQUIRED" });
  });
  app.get("/v1/broadcast/operations/:id", async (request, reply) => {
    const userId = await user(request, reply); if (!userId) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_OPERATION_ID" });
    const operation = await options.operations.get({ userId, operationId: id });
    if (!operation) return reply.code(404).send({ code: "BROADCAST_OPERATION_NOT_FOUND" });
    return { operation };
  });
  app.post("/v1/broadcast/operations/:id/cancel", async (request, reply) => {
    const userId = await user(request, reply); if (!userId) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_OPERATION_ID" });
    if (!await options.operations.cancel({ userId, operationId: id })) return reply.code(404).send({ code: "BROADCAST_OPERATION_NOT_FOUND" });
    return reply.code(204).send(null);
  });
}
