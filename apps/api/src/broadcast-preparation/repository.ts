export type ClaimedBroadcastPreparation = Readonly<{ targetId: string; operationId: string; telegramTargetRef: string }>;
export type BroadcastPreparationStatus = "QUEUED" | "CHECKING" | "JOINING" | "READY" | "FAILED_FINAL";
export interface BroadcastPreparationRepository {
  claimNext(input: Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint }>): Promise<ClaimedBroadcastPreparation | null>;
  transition(input: Readonly<{
    targetId: string;
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    expectedStatus: "CHECKING" | "JOINING";
    status: BroadcastPreparationStatus;
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
  }>): Promise<boolean>;
}
