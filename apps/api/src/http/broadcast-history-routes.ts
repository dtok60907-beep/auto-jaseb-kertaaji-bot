import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BroadcastHistoryRepository } from "../broadcast-history/repository.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

function parseLimit(value: unknown): number | null {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= MAX_LIMIT ? parsed : null;
}

function parseBefore(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > 128) return undefined;
  return value;
}

export function registerBroadcastHistoryRoutes(app: FastifyInstance, options: { history: BroadcastHistoryRepository; authorizeUser: UserAuthorizer }) {
  app.get("/v1/broadcast/history", async (request: FastifyRequest, reply: FastifyReply) => {
    const actor = await options.authorizeUser(request);
    if (!actor) return reply.code(401).send({ code: "USER_REQUIRED" });
    const query = request.query as Record<string, unknown>;
    const limit = parseLimit(query.limit);
    if (limit === null) return reply.code(400).send({ code: "INVALID_LIMIT" });
    const before = parseBefore(query.before);
    if (before === undefined) return reply.code(400).send({ code: "INVALID_CURSOR" });
    const page = await options.history.list({ userId: actor.id, limit, before });
    return { entries: page.entries, nextCursor: page.nextCursor };
  });
}
