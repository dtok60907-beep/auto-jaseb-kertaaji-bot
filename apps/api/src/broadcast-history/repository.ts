export type BroadcastHistoryEntry = Readonly<{
  id: string;
  accountId: string;
  accountLabel: string;
  telegramTargetRef: string;
  resolvedTitle: string | null;
  sentAt: string;
  bubbleLink: string | null;
}>;

export type BroadcastHistoryPage = Readonly<{
  entries: readonly BroadcastHistoryEntry[];
  nextCursor: string | null;
}>;

export interface BroadcastHistoryRepository {
  list(input: Readonly<{ userId: string; limit: number; before: string | null }>): Promise<BroadcastHistoryPage>;
}
