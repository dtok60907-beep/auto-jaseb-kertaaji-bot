import type { TelegramMiniAppIdentity } from "../auth/telegram-mini-app.ts";

export type ApplicationUser = Readonly<{
  id: string;
  telegramUserId: string;
}>;

export interface ApplicationUserRepository {
  resolve(identity: TelegramMiniAppIdentity): Promise<ApplicationUser>;
}
