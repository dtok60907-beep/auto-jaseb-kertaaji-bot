export type ActiveAdminSession = Readonly<{
  sessionId: string;
  userId: string;
  expiresAt: string;
}>;

export interface AdminAccessRepository {
  findActiveByTokenHash(tokenHash: Uint8Array): Promise<ActiveAdminSession | null>;
}
