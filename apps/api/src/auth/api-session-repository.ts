import type { TelegramMiniAppIdentity } from "./telegram-mini-app.ts";

export type ApiSessionIssueInput = Readonly<{
  identity: TelegramMiniAppIdentity;
  tokenHash: Uint8Array;
  initDataHash: Uint8Array;
  expiresAt: string;
}>;

export type ApiSessionIssueResult =
  | Readonly<{
      status: "CREATED";
      userId: string;
      sessionId: string;
      expiresAt: string;
    }>
  | Readonly<{ status: "REPLAY" }>;

export type ActiveApiSession = Readonly<{
  sessionId: string;
  userId: string;
  expiresAt: string;
}>;

export interface ApiSessionRepository {
  issue(input: ApiSessionIssueInput): Promise<ApiSessionIssueResult>;
  findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveApiSession | null>;
}
