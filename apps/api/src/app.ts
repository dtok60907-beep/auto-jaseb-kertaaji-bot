import Fastify from "fastify";
import { registerPackageRoutes, type AdminAuthorizer } from "./http/package-routes.ts";
import type { PackageRepository } from "./packages/repository.ts";

export function createApi(options: { packages: PackageRepository; authorizeAdmin: AdminAuthorizer }) {
  const app = Fastify({ logger: false });
  registerPackageRoutes(app, options);
  return app;
}
