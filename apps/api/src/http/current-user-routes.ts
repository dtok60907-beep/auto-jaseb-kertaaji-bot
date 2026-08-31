import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { UserAuthorizer } from "./broadcast-setting-routes.ts";
import type { AdminAuthorizer } from "./package-routes.ts";

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

export function registerCurrentUserRoutes(
  app: FastifyInstance,
  options: Readonly<{ authorizeUser: UserAuthorizer; authorizeAdmin: AdminAuthorizer }>,
): void {
  app.get("/v1/me", async (request: FastifyRequest, reply) => {
    noStore(reply);
    const user = await options.authorizeUser(request);
    if (!user) return reply.code(401).send({ code: "USER_REQUIRED" });

    const admin = await options.authorizeAdmin(request);
    if (admin && admin.id !== user.id) {
      return reply.code(503).send({ code: "AUTH_TEMPORARILY_UNAVAILABLE" });
    }

    return {
      user: {
        id: user.id,
        role: admin ? "ADMIN" : "USER",
      },
    };
  });
}
