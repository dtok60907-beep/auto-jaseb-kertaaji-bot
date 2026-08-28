import type { EntitlementGrantInput } from "../domain/entitlement.ts";

export type EntitlementView = Readonly<{ id: string; userId: string; packageId: string; packageType: "JASEB_WORKER" | "USERBOT"; status: string; startsAt: string; expiresAt: string; maxLpmGroups: number; maxChannelTargets: number }>;
export interface EntitlementRepository {
  grant(input: Readonly<{ userId: string; grant: EntitlementGrantInput }>): Promise<EntitlementView>;
  list(userId: string): Promise<readonly EntitlementView[]>;
  extend(id: string, durationDays: number): Promise<EntitlementView | null>;
  revoke(id: string): Promise<boolean>;
}
