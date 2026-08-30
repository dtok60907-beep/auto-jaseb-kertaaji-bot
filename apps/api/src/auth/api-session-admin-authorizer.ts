import type { FastifyRequest } from "fastify";

import type { AdminAccessRepository } from "./admin-access-repository.ts";
import {
  ApiAuthenticationUnavailableError,
  isCanonicalApplicationUserId,
  parseApiSessionBearerToken,
} from "./api-session-user-authorizer.ts";
import { hashApiSessionToken } from "./telegram-session-issuer.ts";

export type ApiSessionAdminActor = Readonly<{ id: string }>;

export function createApiSessionAdminAuthorizer(adminAccess: AdminAccessRepository) {
  if (!adminAccess || typeof adminAccess.findActiveByTokenHash !== "function") {
    throw new TypeError("INVALID_ADMIN_ACCESS_REPOSITORY");
  }
  return async (request: FastifyRequest): Promise<ApiSessionAdminActor | null> => {
    const token = parseApiSessionBearerToken(request.headers.authorization);
    if (token === null) return null;
    try {
      const active = await adminAccess.findActiveByTokenHash(hashApiSessionToken(token));
      if (active === null) return null;
      if (!isCanonicalApplicationUserId(active.userId)) throw new Error("INVALID_ADMIN_SESSION_RESULT");
      return Object.freeze({ id: active.userId });
    } catch {
      throw new ApiAuthenticationUnavailableError();
    }
  };
}
