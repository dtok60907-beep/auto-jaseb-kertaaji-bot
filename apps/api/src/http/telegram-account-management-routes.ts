import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { TelegramAccountLifecycleRepository } from "../telegram-accounts/repository.ts";
import {
  UserbotProfileAccountError,
  type UserbotProfileRepository,
} from "../userbot-profiles/repository.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AccountOperations = Pick<
  TelegramAccountLifecycleRepository,
  "listOwnedAccounts" | "revokeSession"
>;
type ProfileOperations = Pick<UserbotProfileRepository, "attach" | "detach">;

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function accountId(request: FastifyRequest): string | null {
  const id = (request.params as { accountId?: unknown }).accountId;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

function hasBody(request: FastifyRequest): boolean {
  return request.body !== undefined && request.body !== null;
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ code: "ACCOUNT_OPERATION_UNAVAILABLE" });
}

export function registerTelegramAccountManagementRoutes(
  app: FastifyInstance,
  options: Readonly<{
    accounts: AccountOperations;
    profiles: ProfileOperations;
    authorizeUser: UserAuthorizer;
  }>,
): void {
  const user = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    noStore(reply);
    const actor = await options.authorizeUser(request);
    if (actor) return actor.id;
    reply.code(401).send({ code: "USER_REQUIRED" });
    return null;
  };

  app.get("/v1/userbot/telegram-accounts", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    try {
      return { accounts: await options.accounts.listOwnedAccounts(userId) };
    } catch { return unavailable(reply); }
  });

  app.post("/v1/userbot/telegram-accounts/:accountId/switch", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    const id = accountId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_ACCOUNT_ID" });
    if (hasBody(request)) return reply.code(422).send({ code: "ACCOUNT_OPERATION_BODY_NOT_ALLOWED" });
    try {
      return { profile: await options.profiles.attach(userId, id) };
    } catch (error) {
      if (error instanceof UserbotProfileAccountError) {
        return reply
          .code(error.code === "ACCOUNT_NOT_FOUND" ? 404 : 409)
          .send({ code: error.code });
      }
      return unavailable(reply);
    }
  });

  app.post("/v1/userbot/telegram-accounts/detach", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    if (hasBody(request)) return reply.code(422).send({ code: "ACCOUNT_OPERATION_BODY_NOT_ALLOWED" });
    try {
      await options.profiles.detach(userId);
      return reply.code(204).send();
    } catch { return unavailable(reply); }
  });

  app.delete("/v1/userbot/telegram-accounts/:accountId/session", async (request, reply) => {
    const userId = await user(request, reply);
    if (!userId) return;
    const id = accountId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_ACCOUNT_ID" });
    if (hasBody(request)) return reply.code(422).send({ code: "ACCOUNT_OPERATION_BODY_NOT_ALLOWED" });
    try {
      const result = await options.accounts.revokeSession(userId, id);
      if (result === "NOT_FOUND") return reply.code(404).send({ code: "ACCOUNT_NOT_FOUND" });
      return reply.code(204).send();
    } catch { return unavailable(reply); }
  });
}
