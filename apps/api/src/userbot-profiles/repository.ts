export type UserbotProfileView = Readonly<{
  id: string;
  status: "CONNECTED" | "DISCONNECTED" | "NEEDS_REAUTH";
  broadcastIntervalSeconds: number;
  activeAccount: Readonly<{ id: string; label: string; status: string }> | null;
}>;

export type UserbotProfileAccountErrorCode = "ACCOUNT_NOT_FOUND" | "ACCOUNT_NOT_READY";

export class UserbotProfileAccountError extends Error {
  readonly code: UserbotProfileAccountErrorCode;

  constructor(code: UserbotProfileAccountErrorCode) {
    super(code);
    this.name = "UserbotProfileAccountError";
    this.code = code;
  }

  toJSON(): Readonly<{ code: UserbotProfileAccountErrorCode }> {
    return Object.freeze({ code: this.code });
  }
}

export interface UserbotProfileRepository {
  get(userId: string): Promise<UserbotProfileView | null>;
  updateBroadcastInterval(userId: string, intervalSeconds: number): Promise<UserbotProfileView>;
  attach(userId: string, accountId: string): Promise<UserbotProfileView>;
  detach(userId: string): Promise<boolean>;
}
