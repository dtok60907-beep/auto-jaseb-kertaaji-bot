import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UserbotProfileRepository } from "../userbot-profiles/repository.ts";
import { UserbotProfileAccountError } from "../userbot-profiles/repository.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";
import type { AdminAuthorizer } from "./package-routes.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function interval(body: unknown): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || typeof value.intervalSeconds !== "number" || !Number.isInteger(value.intervalSeconds) || value.intervalSeconds < 0 || value.intervalSeconds > 2_147_483_647) return null;
  return value.intervalSeconds;
}
function targetUserId(request: FastifyRequest): string | null {
  const userId = (request.params as { userId?: unknown }).userId;
  return typeof userId === "string" && uuid.test(userId) ? userId : null;
}
export function registerUserbotProfileRoutes(app: FastifyInstance, options: { profiles: UserbotProfileRepository; authorizeUser: UserAuthorizer; authorizeAdmin: AdminAuthorizer }) {
  const user = async (request: FastifyRequest, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) => { const actor = await options.authorizeUser(request); if (actor) return actor.id; reply.code(401).send({ code: "USER_REQUIRED" }); return null; };
  const adminUser = async (request: FastifyRequest, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) => { if (!await options.authorizeAdmin(request)) { reply.code(403).send({ code: "ADMIN_REQUIRED" }); return null; } const userId = targetUserId(request); if (userId) return userId; reply.code(400).send({ code: "INVALID_USER_ID" }); return null; };
  const update = (resolve: typeof user) => async (request: FastifyRequest, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) => { const userId = await resolve(request, reply); if (!userId) return; const value = interval(request.body); if (value === null) return reply.code(422).send({ code: "INVALID_USERBOT_BROADCAST_INTERVAL", issues: [{ field: "intervalSeconds", code: "MUST_BE_NON_NEGATIVE_INTEGER" }] }); return { profile: await options.profiles.updateBroadcastInterval(userId, value) }; };
  app.get("/v1/userbot/profile", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; return { profile: await options.profiles.get(userId) }; });
  app.put("/v1/userbot/profile/broadcast-interval", update(user));
  app.post("/v1/userbot/profile/accounts/:id/attach", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; const id = (request.params as { id?: unknown }).id; if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_ACCOUNT_ID" }); try { return { profile: await options.profiles.attach(userId, id) }; } catch (error) { if (error instanceof UserbotProfileAccountError) return reply.code(error.code === "ACCOUNT_NOT_FOUND" ? 404 : 409).send(error); throw error; } });
  app.post("/v1/userbot/profile/detach", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; if (!await options.profiles.detach(userId)) return reply.code(404).send({ code: "PROFILE_NOT_FOUND" }); return reply.code(204).send(null); });
  app.get("/v1/admin/users/:userId/userbot/profile", async (request, reply) => { const userId = await adminUser(request, reply); if (!userId) return; return { profile: await options.profiles.get(userId) }; });
  app.put("/v1/admin/users/:userId/userbot/profile/broadcast-interval", update(adminUser));
}
