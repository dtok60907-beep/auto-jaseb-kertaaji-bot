import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { CanaryOperatorRepository } from "../operations/canary-operator.ts";
import type { AdminAuthorizer } from "./package-routes.ts";

const MAX_TELEGRAM_USER_ID = 4_503_599_627_370_495n;

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, authorizeAdmin: AdminAuthorizer): Promise<boolean> {
  if (await authorizeAdmin(request)) return true;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return false;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseTelegramUserId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,15}$/.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed > MAX_TELEGRAM_USER_ID) return null;
  return parsed.toString();
}

export function registerCanaryAdmissionRoutes(
  app: FastifyInstance,
  options: Readonly<{ admissions: CanaryOperatorRepository; authorizeAdmin: AdminAuthorizer }>,
): void {
  app.get("/v1/admin/canary-admissions", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    return { admissions: await options.admissions.list() };
  });

  app.post("/v1/admin/canary-admissions", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    const telegramUserId = parseTelegramUserId(record(request.body)?.telegramUserId);
    if (!telegramUserId) return reply.code(422).send({ code: "INVALID_TELEGRAM_USER_ID" });
    return options.admissions.setAdmission(telegramUserId, true);
  });

  app.delete("/v1/admin/canary-admissions/:telegramUserId", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    const telegramUserId = parseTelegramUserId((request.params as Record<string, unknown>).telegramUserId);
    if (!telegramUserId) return reply.code(422).send({ code: "INVALID_TELEGRAM_USER_ID" });
    return options.admissions.setAdmission(telegramUserId, false);
  });
}
