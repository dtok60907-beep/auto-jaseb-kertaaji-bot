export type AdminUserView = Readonly<{
  id: string;
  telegramUserId: string;
  firstName: string;
  username: string | null;
  lastAuthenticatedAt: string | null;
  isAdmin: boolean;
}>;

export interface AdminUserRepository {
  list(input: Readonly<{ query: string; limit: number }>): Promise<readonly AdminUserView[]>;
}
