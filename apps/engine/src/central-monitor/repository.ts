import type { AutoCommentMode } from "../../../../packages/auto-comment-contract/src/index.ts";

export type CentralMonitorAccount = Readonly<{
  accountId: string;
  encryptedSession: Uint8Array;
  encryptionKeyVersion: number;
}>;

export type CentralMonitorLeaseContext = Readonly<{
  accountId: string;
  leaseOwner: string;
  fencingToken: bigint;
}>;

export type CentralMonitorDivision = Readonly<{
  divisionId: string;
  accountId: string;
  telegramUserId: number | null;
  mode: AutoCommentMode;
  keywords: readonly string[];
  template: Readonly<{ templateId: string; text: string }>;
  channelTargetId: string;
  discussionTargetRef: string;
  startAfterPostId: number | null;
  activatedAt: string;
}>;

export type CentralMonitorSource = Readonly<{
  sourceId: string;
  sourceChannelRef: string;
  providerPeerId: string | null;
  lastPostId: number | null;
  divisions: readonly CentralMonitorDivision[];
}>;

export type CentralMonitorEvent = Readonly<{
  eventId: string;
  sourceId: string;
  sourceChannelRef: string;
  providerPostId: number;
  content: string;
  providerPostedAt: string | null;
}>;

export type CentralCandidateResult = Readonly<{
  status: "COMMENT_QUEUED" | "PENDING_REVIEW" | "ALREADY_EXISTS";
  candidateId: string;
}>;

export type MonitorConfigSubscription = Readonly<{ close(): Promise<void> }>;

export interface CentralMonitorRepository {
  findActiveAccount(): Promise<Readonly<{ accountId: string }> | null>;
  loadAccountSession(input: Readonly<{ accountId: string; leaseOwner: string; fencingToken: bigint }>): Promise<CentralMonitorAccount | null>;
  loadSources(accountId: string): Promise<readonly CentralMonitorSource[]>;
  markSourceReady(input: Readonly<{ sourceId: string; accountId: string; providerPeerId: string }>): Promise<void>;
  markSourceFailure(input: Readonly<{ sourceId: string; accountId: string; errorCode: string; retryable: boolean }>): Promise<void>;
  advanceCheckpoint(input: Readonly<{ sourceId: string; providerPostId: number }>): Promise<void>;
  enqueueEvent(input: Readonly<{
    sourceId: string;
    providerPostId: number;
    content: string;
    providerPostedAt: string | null;
  }>): Promise<CentralMonitorEvent | null>;
  listPendingEvents(limit: number): Promise<readonly CentralMonitorEvent[]>;
  finishEvent(eventId: string, errorCode?: string): Promise<void>;
  completeEvent(input: Readonly<{ eventId: string; sourceId: string; providerPostId: number }>): Promise<void>;
  createCandidate(input: Readonly<{
    source: CentralMonitorSource;
    division: CentralMonitorDivision;
    providerPostId: number;
    content: string;
    matchedKeywords: readonly string[];
  }>): Promise<CentralCandidateResult>;
  recordNotification(candidateId: string, messageId: number): Promise<void>;
  recordAccountResult(input: CentralMonitorLeaseContext & Readonly<{
    result: "CONNECTED" | "DISCONNECTED" | "FAILED_RETRYABLE" | "DEGRADED" | "REVOKED";
    errorCode?: string;
    retryAfterSeconds?: number;
  }>): Promise<boolean>;
  subscribeChanges(listener: () => void): Promise<MonitorConfigSubscription>;
}
