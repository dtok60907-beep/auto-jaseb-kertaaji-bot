export type AutoCommentResolutionStatus = "QUEUED" | "CHECKING" | "JOINING" | "WAITING_APPROVAL" | "READY" | "FAILED_FINAL";
export type ClaimedAutoCommentPreparation = Readonly<{
  channelTargetId: string;
  sourceChannelRef: string;
  discussionTargetRef: string | null;
  previousStatus: "QUEUED" | "NEEDS_REVALIDATION" | "WAITING_APPROVAL";
}>;

export interface AutoCommentPreparationRepository {
  claimNext(input: Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint }>): Promise<ClaimedAutoCommentPreparation | null>;
  transition(input: Readonly<{
    channelTargetId: string;
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    expectedStatus: "CHECKING" | "JOINING";
    status: AutoCommentResolutionStatus;
    discussionTargetRef?: string | null;
    errorCode?: string | null;
    retryAfterSeconds?: number | null;
  }>): Promise<boolean>;
}
