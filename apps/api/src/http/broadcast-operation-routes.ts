import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { BroadcastOperationRepository } from "../broadcast-operations/repository.ts";
import type { AccountMode } from "../workflows/core-workflows.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type CreateInput = { accountMode: AccountMode; materialId: string; targetIds: readonly string[]; idempotencyKey: string };
function parse(body: unknown): CreateInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || (value.accountMode !== "JASEB_WORKER" && value.accountMode !== "USERBOT") || typeof value.materialId !== "string" || !uuid.test(value.materialId) || !Array.isArray(value.targetIds) || value.targetIds.length === 0 || value.targetIds.some((id) => typeof id !== "string" || !uuid.test(id)) || new Set(value.targetIds).size !== value.targetIds.length || typeof value.idempotencyKey !== "string" || value.idempotencyKey.trim().length < 8 || value.idempotencyKey.trim().length > 128) return null;
  return { accountMode: value.accountMode, materialId: value.materialId, targetIds: value.targetIds, idempotencyKey: value.idempotencyKey.trim() };
}
function errorCode(error: unknown): string | null { return error instanceof Error ? error.message : null; }
function replyError(reply: FastifyReply, code: string) {
  if (code === "SUBSCRIPTION_REQUIRED" || code === "SUBSCRIPTION_EXPIRED") return reply.code(403).send({ code });
  if (code === "BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE" || code === "LPM_TARGET_NOT_FOUND_OR_INACTIVE") return reply.code(404).send({ code });
  if (code === "USERBOT_NOT_CONNECTED" || code === "WORKER_UNAVAILABLE" || code === "IDEMPOTENCY_KEY_CONFLICT") return reply.code(409).send({ code });
  return reply.code(422).send({ code: "INVALID_BROADCAST_OPERATION", issues: [{ field: "body", code }] });
}
export function registerBroadcastOperationRoutes(app: FastifyInstance, options: { operations: BroadcastOperationRepository; authorizeUser: UserAuthorizer }) {
  const user = async (request: FastifyRequest, reply: FastifyReply) => { const actor = await options.authorizeUser(request); if (actor) return actor.id; reply.code(401).send({ code: "USER_REQUIRED" }); return null; };
  app.post("/v1/broadcast/operations", async (request, reply) => {
    const userId = await user(request, reply); if (!userId) return;
    const input = parse(request.body); if (!input) return reply.code(422).send({ code: "INVALID_BROADCAST_OPERATION", issues: [{ field: "body", code: "INVALID_INPUT" }] });
    try {
      const created = await options.operations.create({ userId, ...input });
      return reply.code(created.status === "CREATED" ? 201 : 200).send({ operation: created.operation, idempotent: created.status === "IDEMPOTENT" });
    } catch (error) { return replyError(reply, errorCode(error) ?? "UNKNOWN"); }
  });
  app.get("/v1/broadcast/operations/:id", async (request, reply) => {
    const userId = await user(request, reply); if (!userId) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_OPERATION_ID" });
    const operation = await options.operations.get({ userId, operationId: id });
    if (!operation) return reply.code(404).send({ code: "BROADCAST_OPERATION_NOT_FOUND" });
    return { operation };
  });
}
