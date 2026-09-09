import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminAuthorizer } from "./package-routes.ts";
import type { MonitorAccountRepository } from "../monitors/repository.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, authorize: AdminAuthorizer) {
  if (await authorize(request)) return true;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return false;
}

function activeValue(body: unknown): boolean | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  return Object.keys(value).length === 1 && typeof value.active === "boolean" ? value.active : null;
}

export function registerMonitorAccountRoutes(
  app: FastifyInstance,
  options: Readonly<{ monitors: MonitorAccountRepository; authorizeAdmin: AdminAuthorizer }>,
): void {
  app.get("/v1/admin/monitor-accounts", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    return { monitors: await options.monitors.list() };
  });

  app.put("/v1/admin/monitor-accounts/:id", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    const id = (request.params as { id?: unknown }).id;
    if (typeof id !== "string" || !UUID.test(id)) return reply.code(400).send({ code: "INVALID_MONITOR_ACCOUNT_ID" });
    const active = activeValue(request.body);
    if (active === null) return reply.code(422).send({ code: "INVALID_MONITOR_ACCOUNT_SETTING" });
    const monitor = await options.monitors.setActive(id, active);
    if (!monitor) return reply.code(404).send({ code: "MONITOR_ACCOUNT_NOT_FOUND" });
    return { monitor };
  });
}
