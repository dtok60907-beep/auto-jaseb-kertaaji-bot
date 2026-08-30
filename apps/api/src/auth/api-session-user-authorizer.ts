import type { FastifyRequest } from "fastify";

import type { ApiSessionRepository } from "./api-session-repository.ts";
import { hashApiSessionToken } from "./telegram-session-issuer.ts";

const API_SESSION_TOKEN = /^jas_[A-Za-z0-9_-]{43}$/;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApiSessionUserActor = Readonly<{ id: string }>;

export class ApiAuthenticationUnavailableError extends Error {
  constructor() {
    super("AUTH_TEMPORARILY_UNAVAILABLE");
    this.name = "ApiAuthenticationUnavailableError";
  }
}

function bearerToken(authorization: unknown): string | null {
  if (typeof authorization !== "string") return null;
  const match = /^Bearer (.+)$/i.exec(authorization);
  if (!match || !API_SESSION_TOKEN.test(match[1])) return null;
  return match[1];
}

export function createApiSessionUserAuthorizer(sessions: ApiSessionRepository) {
  if (!sessions || typeof sessions.findActiveByTokenHash !== "function") {
    throw new TypeError("INVALID_API_SESSION_REPOSITORY");
  }
  return async (request: FastifyRequest): Promise<ApiSessionUserActor | null> => {
    const token = bearerToken(request.headers.authorization);
    if (token === null) return null;
    try {
      const active = await sessions.findActiveByTokenHash(hashApiSessionToken(token));
      if (active === null) return null;
      if (!USER_ID.test(active.userId)) throw new Error("INVALID_API_SESSION_RESULT");
      return Object.freeze({ id: active.userId });
    } catch {
      throw new ApiAuthenticationUnavailableError();
    }
  };
}
