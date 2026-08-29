import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WorkerAccountSettingsRepository } from "../workers/repository.ts";
import type { AdminAuthorizer } from "./package-routes.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function requireAdmin(request: FastifyRequest, reply: FastifyReply, authorize: AdminAuthorizer) { if (await authorize(request)) return true; reply.code(403).send({ code: "ADMIN_REQUIRED" }); return false; }
function input(body: unknown): { intervalSeconds: number; active: boolean } | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.intervalSeconds !== "number" || !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 0 || value.intervalSeconds > 2_147_483_647 || typeof value.active !== "boolean") return null;
  return { intervalSeconds: value.intervalSeconds, active: value.active };
}
export function registerWorkerAccountRoutes(app: FastifyInstance, options: { workers: WorkerAccountSettingsRepository; authorizeAdmin: AdminAuthorizer }) {
  app.get("/v1/admin/worker-accounts", async (request, reply) => { if (!await requireAdmin(request, reply, options.authorizeAdmin)) return; return { workers: await options.workers.list() }; });
  app.put("/v1/admin/worker-accounts/:id/settings", async (request, reply) => { if (!await requireAdmin(request, reply, options.authorizeAdmin)) return; const id = (request.params as { id?: unknown }).id; if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_WORKER_ACCOUNT_ID" }); const setting = input(request.body); if (!setting) return reply.code(422).send({ code: "INVALID_WORKER_ACCOUNT_SETTING", issues: [{ field: "intervalSeconds", code: "MUST_BE_NON_NEGATIVE_INTEGER" }] }); const worker = await options.workers.update({ accountId: id, ...setting }); if (!worker) return reply.code(404).send({ code: "WORKER_ACCOUNT_NOT_FOUND" }); return { worker }; });
}
