import type { AccountMode } from "../workflows/core-workflows.ts";

export type BroadcastCampaignView = Readonly<{
  id: string;
  accountMode: AccountMode;
  materialId: string;
  targetIds: readonly string[];
  intervalSeconds: number;
  status: "ACTIVE" | "STOPPED";
  errorCode: string | null;
  lastCycleAt: string | null;
  nextCycleAt: string;
}>;

export interface BroadcastCampaignRepository {
  create(input: Readonly<{
    userId: string;
    accountMode: AccountMode;
    materialId: string;
    targetIds: readonly string[];
    intervalSeconds: number;
  }>): Promise<BroadcastCampaignView>;
  listActive(userId: string): Promise<readonly BroadcastCampaignView[]>;
  stop(input: Readonly<{ userId: string; campaignId: string }>): Promise<boolean>;
}
