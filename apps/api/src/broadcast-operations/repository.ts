import type { AccountMode } from "../workflows/core-workflows.ts";
import type { BroadcastMaterial } from "../domain/broadcast-material.ts";

export type BroadcastOperationTargetView = Readonly<{
  id: string;
  sourceLpmTargetId: string;
  telegramTargetRef: string;
  sequenceNumber: number;
  preparationStatus: string;
  deliveryStatus: string;
  lastErrorCode: string | null;
}>;

export type BroadcastOperationView = Readonly<{
  id: string;
  accountId: string;
  accountMode: AccountMode;
  status: string;
  intervalSeconds: number;
  material: Readonly<BroadcastMaterial & { id: string }>;
  targets: readonly BroadcastOperationTargetView[];
}>;

export interface BroadcastOperationRepository {
  create(input: Readonly<{
    userId: string;
    accountMode: AccountMode;
    materialId: string;
    targetIds: readonly string[];
    idempotencyKey: string;
  }>): Promise<Readonly<{ status: "CREATED" | "IDEMPOTENT"; operation: BroadcastOperationView }>>;
  get(input: Readonly<{ userId: string; operationId: string }>): Promise<BroadcastOperationView | null>;
}
