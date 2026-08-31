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
import type { AdminAccessRepository } from "./auth/admin-access-repository.ts";
import { createApiSessionAdminAuthorizer } from "./auth/api-session-admin-authorizer.ts";
import {
  registerTelegramAccountAuthRoutes,
  type TelegramAuthorizationUseCase,
} from "./http/telegram-account-auth-routes.ts";
import { registerTelegramAccountManagementRoutes } from "./http/telegram-account-management-routes.ts";
import type { TelegramAccountLifecycleRepository } from "./telegram-accounts/repository.ts";

type CommonApiOptions = {
  packages: PackageRepository;
  broadcasts: BroadcastSettingsRepository;
  autoComments: AutoCommentSettingsRepository;
  entitlements: EntitlementRepository;
  userbotProfiles?: UserbotProfileRepository;
  workers?: WorkerAccountSettingsRepository;
  broadcastOperations?: BroadcastOperationRepository;
  telegramSessionIssuer?: TelegramSessionExchange;
  telegramAuthorization?: TelegramAuthorizationUseCase;
  telegramAccounts?: TelegramAccountLifecycleRepository;
};

type ApiOptions = CommonApiOptions & (
  | Readonly<{
      apiSessions: ApiSessionRepository;
      adminAccess: AdminAccessRepository;
      authorizeUser?: never;
      authorizeAdmin?: never;
    }>
  | Readonly<{
      apiSessions?: undefined;
      adminAccess?: undefined;
      authorizeUser: UserAuthorizer;
      authorizeAdmin: AdminAuthorizer;
    }>
);

export function createApi(options: ApiOptions) {
  const app = Fastify({ logger: false });
  const authorizeUser = options.apiSessions
    ? createApiSessionUserAuthorizer(options.apiSessions)
    : options.authorizeUser;
  const authorizeAdmin = options.apiSessions
    ? createApiSessionAdminAuthorizer(options.adminAccess)
    : options.authorizeAdmin;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiAuthenticationUnavailableError) {
      reply.header("cache-control", "no-store");
      return reply.code(503).send({ code: "AUTH_TEMPORARILY_UNAVAILABLE" });
    }
    return reply.send(error);
  });
  if (options.telegramSessionIssuer) registerTelegramAuthRoutes(app, { issuer: options.telegramSessionIssuer });
  if (options.telegramAuthorization) {
    registerTelegramAccountAuthRoutes(app, {
      authorization: options.telegramAuthorization,
      authorizeUser,
    });
  }
  if (options.telegramAccounts && options.userbotProfiles) {
    registerTelegramAccountManagementRoutes(app, {
      accounts: options.telegramAccounts,
      profiles: options.userbotProfiles,
      authorizeUser,
    });
  }
  registerPackageRoutes(app, { ...options, authorizeAdmin });
  registerBroadcastSettingRoutes(app, { ...options, authorizeUser, authorizeAdmin });
  registerAutoCommentSettingRoutes(app, { ...options, authorizeUser, authorizeAdmin });
  registerEntitlementRoutes(app, { ...options, authorizeAdmin });
  if (options.userbotProfiles) registerUserbotProfileRoutes(app, { profiles: options.userbotProfiles, authorizeUser, authorizeAdmin });
  if (options.workers) registerWorkerAccountRoutes(app, { workers: options.workers, authorizeAdmin });
  if (options.broadcastOperations) registerBroadcastOperationRoutes(app, { operations: options.broadcastOperations, authorizeUser });
  return app;
}
