export type MonitorAccountView = Readonly<{
  id: string;
  label: string;
  accountStatus: "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";
  active: boolean;
  sourceCount: number;
  readySourceCount: number;
  lastRuntimeErrorCode: string | null;
}>;

export interface MonitorAccountRepository {
  list(): Promise<readonly MonitorAccountView[]>;
  setActive(accountId: string, active: boolean): Promise<MonitorAccountView | null>;
}
