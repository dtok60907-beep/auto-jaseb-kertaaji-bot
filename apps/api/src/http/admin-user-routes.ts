import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AdminUserRepository } from "../admin-users/repository.ts";
import type { AdminAuthorizer } from "./package-routes.ts";

function input(request: FastifyRequest): Readonly<{ query: string; limit: number }> | null {
  const value = request.query as Record<string, unknown>;
  const rawQuery = value.q;
  const rawLimit = value.limit;
  if (rawQuery !== undefined && (typeof rawQuery !== "string" || rawQuery.trim().length > 80)) return null;
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9][0-9]{0,2}$/.test(rawLimit))) return null;
  const limit = rawLimit === undefined ? 50 : Number(rawLimit);
  if (limit > 100) return null;
  return Object.freeze({ query: typeof rawQuery === "string" ? rawQuery.trim() : "", limit });
}

async function requireAdmin(request: FastifyRequest, reply: FastifyReply, authorizeAdmin: AdminAuthorizer): Promise<boolean> {
  if (await authorizeAdmin(request)) return true;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return false;
}

export function registerAdminUserRoutes(
  app: FastifyInstance,
  options: Readonly<{ users: AdminUserRepository; authorizeAdmin: AdminAuthorizer }>,
): void {
  app.get("/v1/admin/users", async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return;
    const filters = input(request);
    if (!filters) return reply.code(422).send({ code: "INVALID_ADMIN_USER_QUERY" });
    return { users: await options.users.list(filters) };
  });
}
