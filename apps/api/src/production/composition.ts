import postgres, { type Sql } from "postgres";

import { createApi } from "../app.ts";
import { PostgresAdminAccessRepository } from "../auth/postgres-admin-access-repository.ts";
import { PostgresApiSessionRepository } from "../auth/postgres-api-session-repository.ts";
import { TelegramMiniAppVerifier } from "../auth/telegram-mini-app.ts";
import { TelegramSessionIssuer } from "../auth/telegram-session-issuer.ts";
import { PostgresAutoCommentSettingsRepository } from "../auto-comment/postgres-repository.ts";
import { PostgresBroadcastOperationRepository } from "../broadcast-operations/postgres-repository.ts";
import { PostgresBroadcastSettingsRepository } from "../broadcast/postgres-repository.ts";
import { PostgresEntitlementRepository } from "../entitlements/postgres-repository.ts";
import { PostgresPackageRepository } from "../packages/postgres-repository.ts";
import { PostgresUserbotProfileRepository } from "../userbot-profiles/postgres-repository.ts";
import { PostgresWorkerAccountSettingsRepository } from "../workers/postgres-repository.ts";
import { PostgresTelegramAccountLifecycleRepository } from "../telegram-accounts/postgres-repository.ts";
import { PostgresAdminUserRepository } from "../admin-users/postgres-repository.ts";
import { TelegramAuthorizationService } from "../telegram-authorization/service.ts";
import { TeleprotoAuthorizationTransport } from "../telegram-authorization/teleproto-transport.ts";
import type { ProductionApiConfig } from "./config.ts";

export function createProductionApiDatabase(config: ProductionApiConfig): Sql {
  const policy = config.databasePolicy;
  return postgres(config.databaseUrl(), {
    max: policy.maxConnections,
    connect_timeout: policy.connectTimeoutSeconds,
    idle_timeout: policy.idleTimeoutSeconds,
    max_lifetime: policy.maxLifetimeSeconds,
    prepare: policy.prepareStatements,
  });
}

export function composeProductionApi(config: ProductionApiConfig, sql: Sql) {
  const sessions = new PostgresApiSessionRepository(sql);
  const verifier = new TelegramMiniAppVerifier({
    botToken: config.telegramBotToken(),
    maxAgeSeconds: config.authPolicy.initDataMaxAgeSeconds,
    clockSkewSeconds: config.authPolicy.initDataClockSkewSeconds,
  });
  const sessionIssuer = new TelegramSessionIssuer({
    verifier,
    sessions,
    sessionTtlSeconds: config.authPolicy.sessionTtlSeconds,
  });
  const entitlements = new PostgresEntitlementRepository(sql);
  const telegramAccounts = new PostgresTelegramAccountLifecycleRepository(sql);
  const telegramAuthorization = new TelegramAuthorizationService({
    accounts: telegramAccounts,
    entitlements,
    transport: new TeleprotoAuthorizationTransport({
      apiId: config.telegramApiId,
      apiHash: config.telegramApiHash(),
    }),
    keyRing: config.telegramSessionKeyRing(),
    flowTtlSeconds: config.telegramAuthorizationPolicy.flowTtlSeconds,
  });
  return createApi({
    packages: new PostgresPackageRepository(sql),
    broadcasts: new PostgresBroadcastSettingsRepository(sql),
    autoComments: new PostgresAutoCommentSettingsRepository(sql),
    entitlements,
    userbotProfiles: new PostgresUserbotProfileRepository(sql),
    workers: new PostgresWorkerAccountSettingsRepository(sql),
    broadcastOperations: new PostgresBroadcastOperationRepository(sql),
    apiSessions: sessions,
    adminAccess: new PostgresAdminAccessRepository(sql),
    telegramSessionIssuer: sessionIssuer,
    telegramAuthorization,
    telegramAccounts,
    adminUsers: new PostgresAdminUserRepository(sql),
  });
}
