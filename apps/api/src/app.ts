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
import { registerBroadcastHistoryRoutes } from "./http/broadcast-history-routes.ts";
import type { BroadcastHistoryRepository } from "./broadcast-history/repository.ts";
import { registerBroadcastCampaignRoutes } from "./http/broadcast-campaign-routes.ts";
import type { BroadcastCampaignRepository } from "./broadcast-campaigns/repository.ts";
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
import { registerCurrentUserRoutes } from "./http/current-user-routes.ts";
import type { AdminUserRepository } from "./admin-users/repository.ts";
import { registerAdminUserRoutes } from "./http/admin-user-routes.ts";
import type { CanaryOperatorRepository } from "./operations/canary-operator.ts";
import { registerCanaryAdmissionRoutes } from "./http/canary-admission-routes.ts";
import { registerTelegramBotWebhookRoutes } from "./http/telegram-bot-webhook-routes.ts";
import type { TelegramCallbackResponder } from "./telegram-bot/decision-responder.ts";
import type { TelegramStartResponder } from "./telegram-bot/start-responder.ts";

type CommonApiOptions = {
  packages: PackageRepository;
  broadcasts: BroadcastSettingsRepository;
  autoComments: AutoCommentSettingsRepository;
  entitlements: EntitlementRepository;
  userbotProfiles?: UserbotProfileRepository;
  workers?: WorkerAccountSettingsRepository;
  broadcastOperations?: BroadcastOperationRepository;
  broadcastHistory?: BroadcastHistoryRepository;
  broadcastCampaigns?: BroadcastCampaignRepository;
  telegramSessionIssuer?: TelegramSessionExchange;
  telegramAuthorization?: TelegramAuthorizationUseCase;
  telegramAccounts?: TelegramAccountLifecycleRepository;
  adminUsers?: AdminUserRepository;
  canaryAdmissions?: CanaryOperatorRepository;
  telegramBot?: Readonly<{ webhookSecret: string; responder: TelegramStartResponder; callbackResponder: TelegramCallbackResponder }>;
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
  // The Mini App is deployed separately from the API. Authentication uses an
  // explicit bearer token, never cookies, so wildcard origin is safe here and
  // keeps Telegram's changing WebApp origin from breaking preflight requests.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.headers.origin) return;
    reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-headers", "authorization, content-type")
      .header("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
      .header("access-control-max-age", "600");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });
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
  if (options.telegramBot) registerTelegramBotWebhookRoutes(app, {
    secret: options.telegramBot.webhookSecret,
    responder: options.telegramBot.responder,
    callbackResponder: options.telegramBot.callbackResponder,
    autoComments: options.autoComments,
  });
  registerCurrentUserRoutes(app, { authorizeUser, authorizeAdmin });
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
  if (options.adminUsers) registerAdminUserRoutes(app, { users: options.adminUsers, authorizeAdmin });
  if (options.canaryAdmissions) registerCanaryAdmissionRoutes(app, { admissions: options.canaryAdmissions, authorizeAdmin });
  registerBroadcastSettingRoutes(app, { ...options, authorizeUser, authorizeAdmin });
  registerAutoCommentSettingRoutes(app, { ...options, authorizeUser, authorizeAdmin });
  registerEntitlementRoutes(app, { ...options, authorizeAdmin });
  if (options.userbotProfiles) registerUserbotProfileRoutes(app, { profiles: options.userbotProfiles, authorizeUser, authorizeAdmin });
  if (options.workers) registerWorkerAccountRoutes(app, { workers: options.workers, authorizeAdmin });
  if (options.broadcastOperations) registerBroadcastOperationRoutes(app, { operations: options.broadcastOperations, authorizeUser });
  if (options.broadcastHistory) registerBroadcastHistoryRoutes(app, { history: options.broadcastHistory, authorizeUser });
  if (options.broadcastCampaigns) registerBroadcastCampaignRoutes(app, { campaigns: options.broadcastCampaigns, authorizeUser, authorizeAdmin });
  return app;
}
