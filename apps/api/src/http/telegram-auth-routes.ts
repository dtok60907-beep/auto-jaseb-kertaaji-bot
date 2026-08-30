import type { FastifyInstance, FastifyReply } from "fastify";

import { TelegramMiniAppAuthError } from "../auth/telegram-mini-app.ts";
import {
  TelegramSessionExchangeError,
  type IssuedTelegramSession,
} from "../auth/telegram-session-issuer.ts";

const MAX_INIT_DATA_BYTES = 16_384;
const AUTH_BODY_LIMIT_BYTES = 20_480;

export type TelegramSessionExchange = Readonly<{
  exchange(rawInitData: string): Promise<IssuedTelegramSession>;
}>;

type PublicAuthErrorCode =
  | "INVALID_TELEGRAM_AUTH_REQUEST"
  | "TELEGRAM_AUTH_REQUEST_TOO_LARGE"
  | "TELEGRAM_AUTH_INVALID"
  | "TELEGRAM_AUTH_EXPIRED"
  | "TELEGRAM_AUTH_CLOCK_INVALID"
  | "TELEGRAM_AUTH_REPLAYED"
  | "AUTH_TEMPORARILY_UNAVAILABLE";

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("pragma", "no-cache");
}

function fail(reply: FastifyReply, status: number, code: PublicAuthErrorCode) {
  noStore(reply);
  return reply.code(status).send({ code });
}

function initDataFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "initData" || typeof record.initData !== "string" || !record.initData) return null;
  return record.initData;
}

function telegramError(reply: FastifyReply, error: TelegramMiniAppAuthError) {
  if (error.code === "TELEGRAM_INIT_DATA_EXPIRED") return fail(reply, 401, "TELEGRAM_AUTH_EXPIRED");
  if (error.code === "TELEGRAM_INIT_DATA_FUTURE") return fail(reply, 401, "TELEGRAM_AUTH_CLOCK_INVALID");
  return fail(reply, 401, "TELEGRAM_AUTH_INVALID");
}

function parserError(reply: FastifyReply, error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : null;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return fail(reply, 413, "TELEGRAM_AUTH_REQUEST_TOO_LARGE");
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") return fail(reply, 400, "INVALID_TELEGRAM_AUTH_REQUEST");
  return fail(reply, 503, "AUTH_TEMPORARILY_UNAVAILABLE");
}

export function registerTelegramAuthRoutes(
  app: FastifyInstance,
  options: Readonly<{ issuer: TelegramSessionExchange }>,
): void {
  app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => parserError(reply, error));
    scope.post("/v1/auth/telegram", { bodyLimit: AUTH_BODY_LIMIT_BYTES }, async (request, reply) => {
      noStore(reply);
      const initData = initDataFrom(request.body);
      if (initData === null) return fail(reply, 400, "INVALID_TELEGRAM_AUTH_REQUEST");
      if (Buffer.byteLength(initData, "utf8") > MAX_INIT_DATA_BYTES) {
        return fail(reply, 413, "TELEGRAM_AUTH_REQUEST_TOO_LARGE");
      }
      try {
        const issued = await options.issuer.exchange(initData);
        return reply.send({
          accessToken: issued.accessToken,
          tokenType: issued.tokenType,
          expiresAt: issued.expiresAt,
          user: {
            id: issued.userId,
            telegramUserId: issued.telegramUserId,
          },
        });
      } catch (error) {
        if (error instanceof TelegramMiniAppAuthError) return telegramError(reply, error);
        if (error instanceof TelegramSessionExchangeError) {
          if (error.code === "TELEGRAM_INIT_DATA_ALREADY_USED") return fail(reply, 409, "TELEGRAM_AUTH_REPLAYED");
          return fail(reply, 503, "AUTH_TEMPORARILY_UNAVAILABLE");
        }
        return fail(reply, 503, "AUTH_TEMPORARILY_UNAVAILABLE");
      }
    });
  });
}
