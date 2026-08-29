import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AutoCommentSettingsRepository } from "../auto-comment/repository.ts";
import {
  AutoCommentSettingsValidationError,
  validateChannelTarget,
  validateChannelTargetPatch,
  validateDivisionPatch,
  validateDivisionSetting,
  validateKeyword,
  validateTemplateSetting,
} from "../domain/auto-comment-settings.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";
import type { AdminAuthorizer } from "./package-routes.ts";
import type { EntitlementRepository } from "../entitlements/repository.ts";
import { resolveEntitlementAccess } from "../entitlements/access.ts";

type RouteOptions = {
  autoComments: AutoCommentSettingsRepository;
  authorizeUser: UserAuthorizer;
  authorizeAdmin: AdminAuthorizer;
  entitlements: EntitlementRepository;
};

type SubjectResolver = (request: FastifyRequest, reply: FastifyReply) => Promise<string | null>;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireUser(request: FastifyRequest, reply: FastifyReply, authorizeUser: UserAuthorizer): Promise<string | null> {
  const actor = await authorizeUser(request);
  if (actor) return actor.id;
  reply.code(401).send({ code: "USER_REQUIRED" });
  return null;
}
async function requireAdmin(request: FastifyRequest, reply: FastifyReply, authorizeAdmin: AdminAuthorizer): Promise<boolean> {
  if (await authorizeAdmin(request)) return true;
  reply.code(403).send({ code: "ADMIN_REQUIRED" });
  return false;
}

function idParam(request: FastifyRequest, field: string): string | null {
  const value = (request.params as Record<string, unknown>)[field];
  return typeof value === "string" && uuid.test(value) ? value : null;
}

function settingError(error: unknown): string | null {
  if (error instanceof Error && (error.message === "SUBSCRIPTION_REQUIRED" || error.message === "CHANNEL_TARGET_LIMIT_REACHED")) return error.message;
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  if (code === "23505") return "DUPLICATE_SETTING";
  if (code === "23503") return "SETTING_IN_USE";
  if (code === "42501") return "ACCOUNT_NOT_AVAILABLE";
  return null;
}

function validate<T>(reply: FastifyReply, parse: () => T): T | null {
  try {
    return parse();
  } catch (error) {
    if (error instanceof AutoCommentSettingsValidationError) {
      reply.code(422).send({ code: "INVALID_AUTO_COMMENT_SETTING", issues: error.issues });
      return null;
    }
    throw error;
  }
}

function decision(body: unknown): "TEPAT" | "OOT" | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== 1 || (value.decision !== "TEPAT" && value.decision !== "OOT")) return null;
  return value.decision;
}

async function execute<T>(reply: FastifyReply, action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch (error) {
    const code = settingError(error);
    if (code) return reply.code(code === "SUBSCRIPTION_REQUIRED" ? 403 : 409).send({ code }) as T;
    throw error;
  }
}

async function assertChannelCapacity(options: RouteOptions, userId: string, reply: FastifyReply, excludingId?: string): Promise<boolean> {
  const access = resolveEntitlementAccess(await options.entitlements.list(userId), "AUTO_COMMENT_MF");
  if (!access.ok) { reply.code(403).send({ code: access.code }); return false; }
  const current = (await options.autoComments.listSettings(userId)).channelTargets.filter((item) => item.active && item.id !== excludingId).length;
  if (current >= access.limit) { reply.code(409).send({ code: "CHANNEL_TARGET_LIMIT_REACHED", limit: access.limit, current }); return false; }
  return true;
}

export function registerAutoCommentSettingRoutes(app: FastifyInstance, options: RouteOptions) {
  const userSubject: SubjectResolver = (request, reply) => requireUser(request, reply, options.authorizeUser);
  const adminSubject: SubjectResolver = async (request, reply) => {
    if (!await requireAdmin(request, reply, options.authorizeAdmin)) return null;
    const userId = idParam(request, "userId");
    if (userId) return userId;
    reply.code(400).send({ code: "INVALID_USER_ID" });
    return null;
  };

  const listSettings = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    return { settings: await options.autoComments.listSettings(userId) };
  };

  const createDivision = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const division = validate(reply, () => validateDivisionSetting(request.body));
    if (!division) return;
    const created = await execute(reply, () => options.autoComments.createDivision({ userId, division }));
    if (!created) return;
    return reply.code(201).send({ division: created });
  };

  const updateDivision = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const id = idParam(request, "id");
    if (!id) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    const patch = validate(reply, () => validateDivisionPatch(request.body));
    if (!patch) return;
    const updated = await execute(reply, () => options.autoComments.updateDivision({ userId, id, patch }));
    if (!updated) return reply.code(404).send({ code: "DIVISION_NOT_FOUND" });
    return { division: updated };
  };

  const deleteDivision = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const id = idParam(request, "id");
    if (!id) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    const deleted = await execute(reply, () => options.autoComments.deleteDivision({ userId, id }));
    if (!deleted) return reply.code(404).send({ code: "DIVISION_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const createKeyword = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    const keyword = validate(reply, () => validateKeyword(request.body));
    if (!keyword) return;
    const created = await execute(reply, () => options.autoComments.createKeyword({ userId, divisionId, keyword }));
    if (!created) return reply.code(404).send({ code: "DIVISION_NOT_FOUND" });
    return reply.code(201).send({ keyword: created });
  };

  const deleteKeyword = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    const id = idParam(request, "id");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    if (!id) return reply.code(400).send({ code: "INVALID_KEYWORD_ID" });
    const deleted = await options.autoComments.deleteKeyword({ userId, divisionId, id });
    if (!deleted) return reply.code(404).send({ code: "KEYWORD_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const createTemplate = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    const template = validate(reply, () => validateTemplateSetting(request.body));
    if (!template) return;
    const created = await execute(reply, () => options.autoComments.createTemplate({ userId, divisionId, template }));
    if (!created) return reply.code(404).send({ code: "DIVISION_NOT_FOUND" });
    return reply.code(201).send({ template: created });
  };

  const updateTemplate = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    const id = idParam(request, "id");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    if (!id) return reply.code(400).send({ code: "INVALID_TEMPLATE_ID" });
    const template = validate(reply, () => validateTemplateSetting(request.body));
    if (!template) return;
    const updated = await execute(reply, () => options.autoComments.updateTemplate({ userId, divisionId, id, template }));
    if (!updated) return reply.code(404).send({ code: "TEMPLATE_NOT_FOUND" });
    return { template: updated };
  };

  const deleteTemplate = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    const id = idParam(request, "id");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    if (!id) return reply.code(400).send({ code: "INVALID_TEMPLATE_ID" });
    const deleted = await execute(reply, () => options.autoComments.deleteTemplate({ userId, divisionId, id }));
    if (!deleted) return reply.code(404).send({ code: "TEMPLATE_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const createChannelTarget = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const target = validate(reply, () => validateChannelTarget(request.body));
    if (!target) return;
    if (target.active && !await assertChannelCapacity(options, userId, reply)) return;
    const created = await execute(reply, () => options.autoComments.createChannelTarget({ userId, target }));
    if (!created) return;
    return reply.code(201).send({ channelTarget: created });
  };

  const updateChannelTarget = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const id = idParam(request, "id");
    if (!id) return reply.code(400).send({ code: "INVALID_CHANNEL_TARGET_ID" });
    const patch = validate(reply, () => validateChannelTargetPatch(request.body));
    if (!patch) return;
    if (patch.active) {
      const existing = (await options.autoComments.listSettings(userId)).channelTargets.find((target) => target.id === id);
      if (!existing) return reply.code(404).send({ code: "CHANNEL_TARGET_NOT_FOUND" });
      if (!existing.active && !await assertChannelCapacity(options, userId, reply, id)) return;
    }
    const updated = await execute(reply, () => options.autoComments.updateChannelTarget({ userId, id, patch }));
    if (!updated) return reply.code(404).send({ code: "CHANNEL_TARGET_NOT_FOUND" });
    return { channelTarget: updated };
  };

  const deleteChannelTarget = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const id = idParam(request, "id");
    if (!id) return reply.code(400).send({ code: "INVALID_CHANNEL_TARGET_ID" });
    const deleted = await execute(reply, () => options.autoComments.deleteChannelTarget({ userId, id }));
    if (!deleted) return reply.code(404).send({ code: "CHANNEL_TARGET_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const attachChannel = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    const channelTargetId = idParam(request, "channelTargetId");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    if (!channelTargetId) return reply.code(400).send({ code: "INVALID_CHANNEL_TARGET_ID" });
    const result = await options.autoComments.attachChannel({ userId, divisionId, channelTargetId });
    if (result === "NOT_FOUND") return reply.code(404).send({ code: "DIVISION_OR_CHANNEL_TARGET_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const detachChannel = (resolve: SubjectResolver) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolve(request, reply);
    if (!userId) return;
    const divisionId = idParam(request, "divisionId");
    const channelTargetId = idParam(request, "channelTargetId");
    if (!divisionId) return reply.code(400).send({ code: "INVALID_DIVISION_ID" });
    if (!channelTargetId) return reply.code(400).send({ code: "INVALID_CHANNEL_TARGET_ID" });
    const deleted = await options.autoComments.detachChannel({ userId, divisionId, channelTargetId });
    if (!deleted) return reply.code(404).send({ code: "DIVISION_CHANNEL_MAPPING_NOT_FOUND" });
    return reply.code(204).send(null);
  };

  const decideCandidate = async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await userSubject(request, reply);
    if (!userId) return;
    const candidateId = idParam(request, "id");
    if (!candidateId) return reply.code(400).send({ code: "INVALID_CANDIDATE_ID" });
    const selected = decision(request.body);
    if (!selected) return reply.code(422).send({ code: "INVALID_AUTO_COMMENT_DECISION", issues: [{ field: "decision", code: "MUST_BE_TEPAT_OR_OOT" }] });
    const result = await options.autoComments.decideCandidate({ userId, candidateId, decision: selected });
    if (result.status === "NOT_FOUND") return reply.code(404).send({ code: "CANDIDATE_NOT_FOUND" });
    return { decision: result };
  };

  const register = (prefix: string, resolve: SubjectResolver) => {
    app.get(prefix + "/settings", listSettings(resolve));
    app.post(prefix + "/divisions", createDivision(resolve));
    app.put(prefix + "/divisions/:id", updateDivision(resolve));
    app.delete(prefix + "/divisions/:id", deleteDivision(resolve));
    app.post(prefix + "/divisions/:divisionId/keywords", createKeyword(resolve));
    app.delete(prefix + "/divisions/:divisionId/keywords/:id", deleteKeyword(resolve));
    app.post(prefix + "/divisions/:divisionId/templates", createTemplate(resolve));
    app.put(prefix + "/divisions/:divisionId/templates/:id", updateTemplate(resolve));
    app.delete(prefix + "/divisions/:divisionId/templates/:id", deleteTemplate(resolve));
    app.post(prefix + "/channel-targets", createChannelTarget(resolve));
    app.put(prefix + "/channel-targets/:id", updateChannelTarget(resolve));
    app.delete(prefix + "/channel-targets/:id", deleteChannelTarget(resolve));
    app.put(prefix + "/divisions/:divisionId/channel-targets/:channelTargetId", attachChannel(resolve));
    app.delete(prefix + "/divisions/:divisionId/channel-targets/:channelTargetId", detachChannel(resolve));
  };

  register("/v1/auto-comment", userSubject);
  register("/v1/admin/users/:userId/auto-comment", adminSubject);
  app.post("/v1/auto-comment/candidates/:id/decision", decideCandidate);
}
