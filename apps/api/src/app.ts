import Fastify from "fastify";
import { registerBroadcastSettingRoutes, type UserAuthorizer } from "./http/broadcast-setting-routes.ts";
import { registerPackageRoutes, type AdminAuthorizer } from "./http/package-routes.ts";
import type { BroadcastSettingsRepository } from "./broadcast/repository.ts";
import type { PackageRepository } from "./packages/repository.ts";

export function createApi(options: {
  packages: PackageRepository;
  broadcasts: BroadcastSettingsRepository;
  authorizeAdmin: AdminAuthorizer;
  authorizeUser: UserAuthorizer;
}) {
  const app = Fastify({ logger: false });
  registerPackageRoutes(app, options);
  registerBroadcastSettingRoutes(app, options);
  return app;
}
