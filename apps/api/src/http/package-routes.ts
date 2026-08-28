import type { FastifyInstance, FastifyRequest } from "fastify";
import { PackageValidationError, validatePackageConfig } from "../domain/package-catalog.ts";
import type { PackageConfig } from "../domain/package-catalog.ts";
import type { PackageRepository } from "../packages/repository.ts";

type AdminActor = { id: string };
export type AdminAuthorizer = (request: FastifyRequest) => Promise<AdminActor | null>;

type RouteOptions = {
  packages: PackageRepository;
  authorizeAdmin: AdminAuthorizer;
};

const configFields = new Set([
  "name", "type", "priceIdr", "durationDays", "features", "maxTargetsPerMinute",
  "maxAccounts", "intervalMinSeconds", "intervalMaxSeconds", "displayOrder", "active",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function validationReply(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, issues: readonly { field: string; code: string }[]) {
  return reply.code(422).send({ code: "INVALID_PACKAGE", issues });
}

function parseConfig(body: unknown): { config: PackageConfig; issues: readonly { field: string; code: string }[] } | { config: null; issues: readonly { field: string; code: string }[] } {
  const input = record(body);
  if (!input) return { config: null, issues: [{ field: "body", code: "MUST_BE_OBJECT" }] };
  const unknown = Object.keys(input).filter((key) => key !== "code" && !configFields.has(key));
  if (unknown.length > 0) return { config: null, issues: unknown.map((field) => ({ field, code: "UNSUPPORTED" })) };
  try {
    return { config: validatePackageConfig(input), issues: [] };
  } catch (error) {
    if (error instanceof PackageValidationError) return { config: null, issues: error.issues };
    throw error;
  }
}

function parseCode(body: unknown): { code: string } | { issues: readonly { field: string; code: string }[] } {
  const input = record(body);
  const code = input?.code;
  if (typeof code !== "string" || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(code)) {
    return { issues: [{ field: "code", code: "INVALID_FORMAT" }] };
  }
  return { code };
}

async function requireAdmin(request: FastifyRequest, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, authorizeAdmin: AdminAuthorizer): Promise<AdminActor | null> {
  const actor = await authorizeAdmin(request);
  if (actor) return actor;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

export function registerPackageRoutes(app: FastifyInstance, options: RouteOptions) {
  app.get("/v1/packages", async () => ({ packages: await options.packages.list({ includeInactive: false }) }));

  app.get("/v1/admin/packages", async (request, reply) => {
    const actor = await requireAdmin(request, reply, options.authorizeAdmin);
    if (!actor) return;
    return { packages: await options.packages.list({ includeInactive: true }) };
  });

  app.post("/v1/admin/packages", async (request, reply) => {
    const actor = await requireAdmin(request, reply, options.authorizeAdmin);
    if (!actor) return;
    const code = parseCode(request.body);
    if ("issues" in code) return validationReply(reply, code.issues);
    const parsed = parseConfig(request.body);
    if (!parsed.config) return validationReply(reply, parsed.issues);
    try {
      const pkg = await options.packages.create({ code: code.code, config: parsed.config, actorId: actor.id });
      return reply.code(201).send({ package: pkg });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "PACKAGE_CODE_EXISTS" });
      throw error;
    }
  });

  app.patch("/v1/admin/packages/:id", async (request, reply) => {
    const actor = await requireAdmin(request, reply, options.authorizeAdmin);
    if (!actor) return;
    const params = request.params as { id?: unknown };
    if (typeof params.id !== "string" || params.id.trim() === "") return reply.code(400).send({ code: "INVALID_PACKAGE_ID" });
    const parsed = parseConfig(request.body);
    if (!parsed.config) return validationReply(reply, parsed.issues);
    const pkg = await options.packages.publish({ id: params.id, config: parsed.config, actorId: actor.id });
    if (!pkg) return reply.code(404).send({ code: "PACKAGE_NOT_FOUND" });
    return { package: pkg };
  });
}
