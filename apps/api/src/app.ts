import Fastify from "fastify";
import { registerBroadcastSettingRoutes, type UserAuthorizer } from "./http/broadcast-setting-routes.ts";
import { registerAutoCommentSettingRoutes } from "./http/auto-comment-setting-routes.ts";
import { registerPackageRoutes, type AdminAuthorizer } from "./http/package-routes.ts";
import type { AutoCommentSettingsRepository } from "./auto-comment/repository.ts";
import type { BroadcastSettingsRepository } from "./broadcast/repository.ts";
import type { PackageRepository } from "./packages/repository.ts";
import type { EntitlementRepository } from "./entitlements/repository.ts";
import { registerEntitlementRoutes } from "./http/entitlement-routes.ts";
import { registerUserbotProfileRoutes } from "./http/userbot-profile-routes.ts";
import type { UserbotProfileRepository } from "./userbot-profiles/repository.ts";
import { registerWorkerAccountRoutes } from "./http/worker-account-routes.ts";
import type { WorkerAccountSettingsRepository } from "./workers/repository.ts";
import { registerBroadcastOperationRoutes } from "./http/broadcast-operation-routes.ts";
import type { BroadcastOperationRepository } from "./broadcast-operations/repository.ts";
import { registerTelegramAuthRoutes, type TelegramSessionExchange } from "./http/telegram-auth-routes.ts";
import type { ApiSessionRepository } from "./auth/api-session-repository.ts";
import {
  ApiAuthenticationUnavailableError,
  createApiSessionUserAuthorizer,
} from "./auth/api-session-user-authorizer.ts";

type CommonApiOptions = {
  packages: PackageRepository;
  broadcasts: BroadcastSettingsRepository;
  autoComments: AutoCommentSettingsRepository;
  authorizeAdmin: AdminAuthorizer;
  entitlements: EntitlementRepository;
  userbotProfiles?: UserbotProfileRepository;
  workers?: WorkerAccountSettingsRepository;
  broadcastOperations?: BroadcastOperationRepository;
  telegramSessionIssuer?: TelegramSessionExchange;
};

type ApiOptions = CommonApiOptions & (
  | Readonly<{ apiSessions: ApiSessionRepository; authorizeUser?: never }>
  | Readonly<{ apiSessions?: undefined; authorizeUser: UserAuthorizer }>
);

export function createApi(options: ApiOptions) {
  const app = Fastify({ logger: false });
  const authorizeUser = options.apiSessions
    ? createApiSessionUserAuthorizer(options.apiSessions)
    : options.authorizeUser;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiAuthenticationUnavailableError) {
      reply.header("cache-control", "no-store");
      return reply.code(503).send({ code: "AUTH_TEMPORARILY_UNAVAILABLE" });
    }
    return reply.send(error);
  });
  if (options.telegramSessionIssuer) registerTelegramAuthRoutes(app, { issuer: options.telegramSessionIssuer });
  registerPackageRoutes(app, options);
  registerBroadcastSettingRoutes(app, { ...options, authorizeUser });
  registerAutoCommentSettingRoutes(app, { ...options, authorizeUser });
  registerEntitlementRoutes(app, options);
  if (options.userbotProfiles) registerUserbotProfileRoutes(app, { profiles: options.userbotProfiles, authorizeUser, authorizeAdmin: options.authorizeAdmin });
  if (options.workers) registerWorkerAccountRoutes(app, { workers: options.workers, authorizeAdmin: options.authorizeAdmin });
  if (options.broadcastOperations) registerBroadcastOperationRoutes(app, { operations: options.broadcastOperations, authorizeUser });
  return app;
}
