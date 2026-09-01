import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { BroadcastCampaignRepository } from "../broadcast-campaigns/repository.ts";
import type { AccountMode } from "../workflows/core-workflows.ts";
import type { AdminAuthorizer } from "./package-routes.ts";
import type { UserAuthorizer } from "./broadcast-setting-routes.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type CreateInput = { accountMode: AccountMode; materialId: string; targetIds: readonly string[]; intervalSeconds: number };

function parseCreate(body: unknown): CreateInput | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).length !== 4
    || (value.accountMode !== "JASEB_WORKER" && value.accountMode !== "USERBOT")
    || typeof value.materialId !== "string" || !uuid.test(value.materialId)
    || !Array.isArray(value.targetIds) || value.targetIds.length === 0
    || value.targetIds.some((id) => typeof id !== "string" || !uuid.test(id))
    || new Set(value.targetIds).size !== value.targetIds.length
    || typeof value.intervalSeconds !== "number" || !Number.isInteger(value.intervalSeconds)
    || value.intervalSeconds < 300 || value.intervalSeconds > 2_147_483_647
  ) return null;
  return { accountMode: value.accountMode, materialId: value.materialId, targetIds: value.targetIds, intervalSeconds: value.intervalSeconds };
}

function campaignId(request: FastifyRequest): string | null {
  const value = (request.params as { id?: unknown }).id;
  return typeof value === "string" && uuid.test(value) ? value : null;
}

function subjectUserId(request: FastifyRequest): string | null {
  const value = (request.params as { userId?: unknown }).userId;
  return typeof value === "string" && uuid.test(value) ? value : null;
}

function errorCode(error: unknown): string | null { return error instanceof Error ? error.message : null; }

function replyError(reply: FastifyReply, code: string) {
  if (code === "SUBSCRIPTION_REQUIRED") return reply.code(403).send({ code });
  if (code === "BROADCAST_MATERIAL_NOT_FOUND_OR_INACTIVE" || code === "LPM_TARGET_NOT_FOUND_OR_INACTIVE") return reply.code(404).send({ code });
  if (code === "CAMPAIGN_ALREADY_ACTIVE") return reply.code(409).send({ code });
  if (code === "INTERVAL_TOO_SHORT") return reply.code(422).send({ code, issues: [{ field: "intervalSeconds", code: "TOO_SHORT" }] });
  return reply.code(422).send({ code: "INVALID_BROADCAST_CAMPAIGN", issues: [{ field: "body", code }] });
}

export function registerBroadcastCampaignRoutes(app: FastifyInstance, options: {
  campaigns: BroadcastCampaignRepository;
  authorizeUser: UserAuthorizer;
  authorizeAdmin: AdminAuthorizer;
}) {
  const userSubject = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const actor = await options.authorizeUser(request);
    if (actor) return actor.id;
    reply.code(401).send({ code: "USER_REQUIRED" });
    return null;
  };

  const adminSubject = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const actor = await options.authorizeAdmin(request);
    if (!actor) { reply.code(403).send({ code: "ADMIN_REQUIRED" }); return null; }
    const userId = subjectUserId(request);
    if (userId) return userId;
    reply.code(400).send({ code: "INVALID_USER_ID" });
    return null;
  };

  const create = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolveSubject(request, reply); if (!userId) return;
    const input = parseCreate(request.body);
    if (!input) return reply.code(422).send({ code: "INVALID_BROADCAST_CAMPAIGN", issues: [{ field: "body", code: "INVALID_INPUT" }] });
    try {
      const campaign = await options.campaigns.create({ userId, ...input });
      return reply.code(201).send({ campaign });
    } catch (error) { return replyError(reply, errorCode(error) ?? "UNKNOWN"); }
  };

  const getCurrent = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolveSubject(request, reply); if (!userId) return;
    return { campaign: await options.campaigns.getCurrent(userId) };
  };

  const stop = (resolveSubject: typeof userSubject) => async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = await resolveSubject(request, reply); if (!userId) return;
    const id = campaignId(request);
    if (!id) return reply.code(400).send({ code: "INVALID_CAMPAIGN_ID" });
    await options.campaigns.stop({ userId, campaignId: id });
    return reply.code(204).send(null);
  };

  app.post("/v1/broadcast/campaigns", create(userSubject));
  app.get("/v1/broadcast/campaigns", getCurrent(userSubject));
  app.post("/v1/broadcast/campaigns/:id/stop", stop(userSubject));

  app.post("/v1/admin/users/:userId/broadcast/campaigns", create(adminSubject));
  app.get("/v1/admin/users/:userId/broadcast/campaigns", getCurrent(adminSubject));
  app.post("/v1/admin/users/:userId/broadcast/campaigns/:id/stop", stop(adminSubject));
}
