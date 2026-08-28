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

export function createApi(options: {
  packages: PackageRepository;
  broadcasts: BroadcastSettingsRepository;
  autoComments: AutoCommentSettingsRepository;
  authorizeAdmin: AdminAuthorizer;
  authorizeUser: UserAuthorizer;
  entitlements?: EntitlementRepository;
  userbotProfiles?: UserbotProfileRepository;
}) {
  const app = Fastify({ logger: false });
  registerPackageRoutes(app, options);
  registerBroadcastSettingRoutes(app, options);
  registerAutoCommentSettingRoutes(app, options);
  if (options.entitlements) registerEntitlementRoutes(app, options as { entitlements: EntitlementRepository; authorizeAdmin: AdminAuthorizer });
  if (options.userbotProfiles) registerUserbotProfileRoutes(app, { profiles: options.userbotProfiles, authorizeUser: options.authorizeUser });
  return app;
}
