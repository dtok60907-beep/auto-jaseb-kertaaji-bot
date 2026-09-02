import type { TelegramDeliveryReceipt } from "../../../../packages/telegram-contract/src/index.ts";

export type ClaimedAutoCommentCommand = Readonly<{
  id: string;
  operationId: string;
  accountId: string;
  kind: "COMMENT_TEXT";
  targetRef: string;
  payload: Readonly<Record<string, unknown>>;
  attemptCount: number;
  fencingToken: bigint;
  leaseUntil: string;
}>;

export type AutoCommentFinishOutcome =
  | Readonly<{ status: "SUCCEEDED"; receipt: TelegramDeliveryReceipt }>
  | Readonly<{ status: "FAILED_RETRYABLE"; errorCode: string; retryAfterSeconds: number }>
  | Readonly<{ status: "FAILED_FINAL"; errorCode: string }>
  | Readonly<{ status: "SIDE_EFFECT_UNCERTAIN"; errorCode: string }>;

export interface AutoCommentExecutorRepository {
  claimNext(input: Readonly<{
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    commandLeaseSeconds: number;
  }>): Promise<ClaimedAutoCommentCommand | null>;
  finish(input: Readonly<{
    commandId: string;
    accountId: string;
    leaseOwner: string;
    accountFencingToken: bigint;
    outcome: AutoCommentFinishOutcome;
  }>): Promise<boolean>;
}
