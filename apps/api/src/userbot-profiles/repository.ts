export type UserbotProfileView = Readonly<{
  id: string;
  status: "CONNECTED" | "DISCONNECTED" | "NEEDS_REAUTH";
  broadcastIntervalSeconds: number;
  activeAccount: Readonly<{ id: string; label: string; status: string }> | null;
}>;
export interface UserbotProfileRepository {
  get(userId: string): Promise<UserbotProfileView | null>;
  updateBroadcastInterval(userId: string, intervalSeconds: number): Promise<UserbotProfileView>;
  attach(userId: string, accountId: string): Promise<UserbotProfileView>;
  detach(userId: string): Promise<boolean>;
}
