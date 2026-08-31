import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { UserAuthorizer } from "./broadcast-setting-routes.ts";
import {
  TelegramAuthorizationServiceError,
  type TelegramAuthorizationResult,
} from "../telegram-authorization/service.ts";

const BODY_LIMIT_BYTES = 2_048;

export type TelegramAuthorizationUseCase = Readonly<{
  start(userId: string, phoneNumber: unknown): Promise<TelegramAuthorizationResult>;
  submitCode(userId: string, authFlowId: unknown, version: unknown, code: unknown): Promise<TelegramAuthorizationResult>;
  submitPassword(userId: string, authFlowId: unknown, version: unknown, password: unknown): Promise<TelegramAuthorizationResult>;
  cancel(userId: string, authFlowId: unknown, version: unknown): Promise<void>;
}>;

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  return Object.keys(record).sort().join(",") === [...keys].sort().join(",") ? record : null;
}

function authFlowId(request: FastifyRequest): unknown {
  return (request.params as { authFlowId?: unknown }).authFlowId;
}

function statusFor(code: TelegramAuthorizationServiceError["code"]): number {
  if (code.startsWith("INVALID_")) return 422;
  if (code === "SUBSCRIPTION_REQUIRED" || code === "SUBSCRIPTION_EXPIRED" || code === "PHONE_NUMBER_BANNED") return 403;
  if (code === "AUTH_FLOW_NOT_FOUND") return 404;
  if (code === "AUTH_FLOW_EXPIRED" || code === "PHONE_CODE_EXPIRED" || code === "AUTH_SESSION_EXPIRED") return 410;
  if (code === "TELEGRAM_RATE_LIMITED") return 429;
  if (
    code === "AUTH_FLOW_ACTIVE" || code === "AUTH_FLOW_CONFLICT"
    || code === "ACCOUNT_ALREADY_CONNECTED"
  ) return 409;
  if (
    code === "PHONE_NUMBER_INVALID" || code === "PHONE_CODE_INVALID"
    || code === "PHONE_CODE_HASH_INVALID" || code === "PASSWORD_INVALID"
    || code === "EMAIL_VERIFICATION_REQUIRED" || code === "NEW_ACCOUNT_NOT_SUPPORTED"
  ) return 422;
  return 503;
}

function serviceFailure(reply: FastifyReply, error: unknown) {
  noStore(reply);
  if (!(error instanceof TelegramAuthorizationServiceError)) {
    return reply.code(503).send({ code: "AUTH_TEMPORARILY_UNAVAILABLE" });
  }
  return reply.code(statusFor(error.code)).send({
    code: error.code,
    ...(error.flow ? { flow: error.flow } : {}),
  });
}

function parserFailure(reply: FastifyReply, error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  noStore(reply);
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
    return reply.code(413).send({ code: "TELEGRAM_AUTH_REQUEST_TOO_LARGE" });
  }
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") {
    return reply.code(400).send({ code: "INVALID_TELEGRAM_AUTH_REQUEST" });
  }
  return serviceFailure(reply, error);
}

export function registerTelegramAccountAuthRoutes(
  app: FastifyInstance,
  options: Readonly<{
    authorization: TelegramAuthorizationUseCase;
    authorizeUser: UserAuthorizer;
  }>,
): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => parserFailure(reply, error));
    const user = async (request: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
      noStore(reply);
      const actor = await options.authorizeUser(request);
      if (actor) return actor.id;
      reply.code(401).send({ code: "USER_REQUIRED" });
      return null;
    };

    scope.post("/v1/userbot/telegram-auth-flows", { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const userId = await user(request, reply);
      if (!userId) return;
      const body = exactBody(request.body, ["phoneNumber"]);
      if (!body) return reply.code(422).send({ code: "INVALID_TELEGRAM_AUTH_REQUEST" });
      try {
        const result = await options.authorization.start(userId, body.phoneNumber);
        return reply.code(201).send(result);
      } catch (error) { return serviceFailure(reply, error); }
    });

    scope.post("/v1/userbot/telegram-auth-flows/:authFlowId/code", { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const userId = await user(request, reply);
      if (!userId) return;
      const body = exactBody(request.body, ["code", "version"]);
      if (!body) return reply.code(422).send({ code: "INVALID_TELEGRAM_AUTH_REQUEST" });
      try {
        return await options.authorization.submitCode(
          userId, authFlowId(request), body.version, body.code,
        );
      } catch (error) { return serviceFailure(reply, error); }
    });

    scope.post("/v1/userbot/telegram-auth-flows/:authFlowId/password", { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const userId = await user(request, reply);
      if (!userId) return;
      const body = exactBody(request.body, ["password", "version"]);
      if (!body) return reply.code(422).send({ code: "INVALID_TELEGRAM_AUTH_REQUEST" });
      try {
        return await options.authorization.submitPassword(
          userId, authFlowId(request), body.version, body.password,
        );
      } catch (error) { return serviceFailure(reply, error); }
    });

    scope.post("/v1/userbot/telegram-auth-flows/:authFlowId/cancel", { bodyLimit: BODY_LIMIT_BYTES }, async (request, reply) => {
      const userId = await user(request, reply);
      if (!userId) return;
      const body = exactBody(request.body, ["version"]);
      if (!body) return reply.code(422).send({ code: "INVALID_TELEGRAM_AUTH_REQUEST" });
      try {
        await options.authorization.cancel(userId, authFlowId(request), body.version);
        return reply.code(204).send();
      } catch (error) { return serviceFailure(reply, error); }
    });
  });
}
