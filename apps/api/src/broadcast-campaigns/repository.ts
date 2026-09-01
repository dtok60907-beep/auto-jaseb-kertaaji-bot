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
  lastOperationId: string | null;
}>;

export interface BroadcastCampaignRepository {
  create(input: Readonly<{
    userId: string;
    accountMode: AccountMode;
    materialId: string;
    targetIds: readonly string[];
    intervalSeconds: number;
  }>): Promise<BroadcastCampaignView>;
  getCurrent(userId: string): Promise<BroadcastCampaignView | null>;
  stop(input: Readonly<{ userId: string; campaignId: string }>): Promise<boolean>;
}
