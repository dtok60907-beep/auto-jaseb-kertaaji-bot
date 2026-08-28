import type { FastifyInstance, FastifyRequest } from "fastify";
import type { UserbotProfileRepository } from "../userbot-profiles/repository.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function registerUserbotProfileRoutes(app: FastifyInstance, options: { profiles: UserbotProfileRepository; authorizeUser: UserAuthorizer }) {
  const user = async (request: FastifyRequest, reply: { code: (status: number) => { send: (value: unknown) => unknown } }) => { const actor = await options.authorizeUser(request); if (actor) return actor.id; reply.code(401).send({ code: "USER_REQUIRED" }); return null; };
  app.get("/v1/userbot/profile", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; return { profile: await options.profiles.get(userId) }; });
  app.post("/v1/userbot/profile/accounts/:id/attach", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; const id = (request.params as { id?: unknown }).id; if (typeof id !== "string" || !uuid.test(id)) return reply.code(400).send({ code: "INVALID_ACCOUNT_ID" }); try { return { profile: await options.profiles.attach(userId, id) }; } catch (error) { if (typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "42501") return reply.code(409).send({ code: "ACCOUNT_NOT_READY_OR_NOT_OWNED" }); throw error; } });
  app.post("/v1/userbot/profile/detach", async (request, reply) => { const userId = await user(request, reply); if (!userId) return; if (!await options.profiles.detach(userId)) return reply.code(404).send({ code: "PROFILE_NOT_FOUND" }); return reply.code(204).send(null); });
}
