export type ClaimedWorkflowCommand = Readonly<{
  id: string;
  operationId: string;
  accountId: string;
  kind: "SEND_TEXT" | "FORWARD_MESSAGE" | "COMMENT_TEXT";
  targetId: string;
  payload: Readonly<Record<string, unknown>>;
  fencingToken: bigint;
  leaseUntil: string;
}>;

export interface RuntimeOutboxRepository {
  claimNext(input: Readonly<{ accountId: string; leaseOwner: string; accountFencingToken: bigint; commandLeaseSeconds: number }>): Promise<ClaimedWorkflowCommand | null>;
  finish(input: Readonly<{
    commandId: string;
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    status: "SUCCEEDED" | "FAILED_RETRYABLE" | "FAILED_FINAL" | "CANCELLED";
    errorCode?: string | null;
  }>): Promise<boolean>;
}
