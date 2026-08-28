import type { FastifyInstance, FastifyRequest } from "fastify";
import { BroadcastMaterialValidationError, validateBroadcastMaterial } from "../domain/broadcast-material.ts";
import { BroadcastTargetValidationError, validateBroadcastLpmTarget } from "../domain/broadcast-target.ts";
import type { BroadcastSettingsRepository } from "../broadcast/repository.ts";
import type { AdminAuthorizer } from "./package-routes.ts";
import type { EntitlementRepository } from "../entitlements/repository.ts";

type UserActor = { id: string };
export type UserAuthorizer = (request: FastifyRequest) => Promise<UserActor | null>;

type RouteOptions = {
  broadcasts: BroadcastSettingsRepository;
  authorizeUser: UserAuthorizer;
  authorizeAdmin: AdminAuthorizer;
  entitlements?: EntitlementRepository;
};

type ValidationIssue = Readonly<{ field: string; code: string }>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function replyValidation(reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, code: string, issues: readonly ValidationIssue[]) {
  return reply.code(422).send({ code, issues });
}

async function requireUser(request: FastifyRequest, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, authorizeUser: UserAuthorizer): Promise<UserActor | null> {
  const actor = await authorizeUser(request);
  if (actor) return actor;
  reply.code(401).send({ code: "USER_REQUIRED" });
  return null;
}

async function requireAdmin(request: FastifyRequest, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }, authorizeAdmin: AdminAuthorizer): Promise<UserActor | null> {
  const actor = await authorizeAdmin(request);
  if (actor) return actor;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return null;
}

function parseMaterial(body: unknown, requireActive: boolean): { material: ReturnType<typeof validateBroadcastMaterial>; active: boolean } | { issues: readonly ValidationIssue[] } {
  const input = record(body);
  if (!input) return { issues: [{ field: "body", code: "MUST_BE_OBJECT" }] };
  const allowed = new Set(["kind", "text", "sourceLink", "sourceAttribution", "active"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { issues: unknown.map((field) => ({ field, code: "UNSUPPORTED" })) };
  const active = input.active ?? (requireActive ? undefined : true);
  if (typeof active !== "boolean") return { issues: [{ field: "active", code: "MUST_BE_BOOLEAN" }] };
  try {
    return { material: validateBroadcastMaterial(input), active };
  } catch (error) {
    if (error instanceof BroadcastMaterialValidationError) return { issues: error.issues };
    throw error;
  }
}

function parseTarget(body: unknown): { target: ReturnType<typeof validateBroadcastLpmTarget> } | { issues: readonly ValidationIssue[] } {
  const input = record(body);
  if (!input) return { issues: [{ field: "body", code: "MUST_BE_OBJECT" }] };
  const allowed = new Set(["telegramTargetRef", "label", "active"]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length > 0) return { issues: unknown.map((field) => ({ field, code: "UNSUPPORTED" })) };
  const normalized = { ...input, active: input.active ?? true };
  try {
    return { target: validateBroadcastLpmTarget(normalized) };
  } catch (error) {
    if (error instanceof BroadcastTargetValidationError) return { issues: error.issues };
    throw error;
  }
}

function resourceId(request: FastifyRequest): string | null {
  const value = (request.params as { id?: unknown }).id;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function subjectUserId(request: FastifyRequest): string | null {
  const value = (request.params as { userId?: unknown }).userId;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

async function assertLpmCapacity(options: RouteOptions, userId: string, reply: FastifyReplyLike): Promise<boolean> {
  if (!options.entitlements) return true;
  const entitlement = (await options.entitlements.list(userId)).find((item) => item.status === "ACTIVE" && new Date(item.expiresAt).getTime() > Date.now());
  if (!entitlement) { reply.code(403).send({ code: "SUBSCRIPTION_REQUIRED" }); return false; }
  const current = (await options.broadcasts.listLpmTargets(userId)).filter((target) => target.active).length;
  if (current >= entitlement.maxLpmGroups) { reply.code(409).send({ code: "LPM_GROUP_LIMIT_REACHED", limit: entitlement.maxLpmGroups, current }); return false; }
  return true;
}
type FastifyReplyLike = { code: (status: number) => { send: (payload: unknown) => unknown } };

export function registerBroadcastSettingRoutes(app: FastifyInstance, options: RouteOptions) {
  const userSubject = async (request: FastifyRequest, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }): Promise<string | null> => {
    const actor = await requireUser(request, reply, options.authorizeUser);
    return actor?.id ?? null;
  };
  const adminSubject = async (request: FastifyRequest, reply: { code: (status: number) => { send: (payload: unknown) => unknown } }): Promise<string | null> => {
    const actor = await requireAdmin(request, reply, options.authorizeAdmin);
    if (!actor) return null;
    const userId = subjectUserId(request);
    if (userId) return userId;
    reply.code(400).send({ code: "INVALID_USER_ID" });
    return null;
  };

  const listSettings = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const [materials, lpmTargets] = await Promise.all([
      options.broadcasts.listMaterials(userId),
      options.broadcasts.listLpmTargets(userId),
    ]);
    return { materials, lpmTargets };
  };

  const createMaterial = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const parsed = parseMaterial(request.body, false);
    if ("issues" in parsed) return replyValidation(reply, "INVALID_BROADCAST_MATERIAL", parsed.issues);
    const material = await options.broadcasts.createMaterial({ userId, ...parsed });
    return reply.code(201).send({ material });
  };

  const updateMaterial = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const id = resourceId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_MATERIAL_ID" });
    const parsed = parseMaterial(request.body, true);
    if ("issues" in parsed) return replyValidation(reply, "INVALID_BROADCAST_MATERIAL", parsed.issues);
    const material = await options.broadcasts.updateMaterial({ id, userId, ...parsed });
    if (!material) return reply.code(404).send({ code: "MATERIAL_NOT_FOUND" });
    return { material };
  };

  const deleteMaterial = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const id = resourceId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_MATERIAL_ID" });
    const deleted = await options.broadcasts.deleteMaterial({ id, userId });
    if (!deleted) return reply.code(404).send({ code: "MATERIAL_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const createTarget = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const parsed = parseTarget(request.body);
    if ("issues" in parsed) return replyValidation(reply, "INVALID_LPM_TARGET", parsed.issues);
    if (!await assertLpmCapacity(options, userId, reply)) return;
    try {
      const target = await options.broadcasts.createLpmTarget({ userId, ...parsed });
      return reply.code(201).send({ target });
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "LPM_TARGET_EXISTS" });
      throw error;
    }
  };

  const updateTarget = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const id = resourceId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_LPM_TARGET_ID" });
    const parsed = parseTarget(request.body);
    if ("issues" in parsed) return replyValidation(reply, "INVALID_LPM_TARGET", parsed.issues);
    try {
      const target = await options.broadcasts.updateLpmTarget({ id, userId, ...parsed });
      if (!target) return reply.code(404).send({ code: "LPM_TARGET_NOT_FOUND" });
      return { target };
    } catch (error) {
      if (isUniqueViolation(error)) return reply.code(409).send({ code: "LPM_TARGET_EXISTS" });
      throw error;
    }
  };

  const deleteTarget = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: Parameters<typeof userSubject>[1]) => {
    const userId = await resolveSubject(request, reply);
    if (!userId) return;
    const id = resourceId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_LPM_TARGET_ID" });
    const deleted = await options.broadcasts.deleteLpmTarget({ id, userId });
    if (!deleted) return reply.code(404).send({ code: "LPM_TARGET_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  app.get("/v1/broadcast/settings", listSettings(userSubject));
  app.post("/v1/broadcast/materials", createMaterial(userSubject));
  app.put("/v1/broadcast/materials/:id", updateMaterial(userSubject));
  app.delete("/v1/broadcast/materials/:id", deleteMaterial(userSubject));
  app.post("/v1/broadcast/lpm-targets", createTarget(userSubject));
  app.put("/v1/broadcast/lpm-targets/:id", updateTarget(userSubject));
  app.delete("/v1/broadcast/lpm-targets/:id", deleteTarget(userSubject));

  app.get("/v1/admin/users/:userId/broadcast/settings", listSettings(adminSubject));
  app.post("/v1/admin/users/:userId/broadcast/materials", createMaterial(adminSubject));
  app.put("/v1/admin/users/:userId/broadcast/materials/:id", updateMaterial(adminSubject));
  app.delete("/v1/admin/users/:userId/broadcast/materials/:id", deleteMaterial(adminSubject));
  app.post("/v1/admin/users/:userId/broadcast/lpm-targets", createTarget(adminSubject));
  app.put("/v1/admin/users/:userId/broadcast/lpm-targets/:id", updateTarget(adminSubject));
  app.delete("/v1/admin/users/:userId/broadcast/lpm-targets/:id", deleteTarget(adminSubject));
}
