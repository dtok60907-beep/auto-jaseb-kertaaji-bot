export type WorkerAvailability = "READY" | "NOT_CONFIGURED" | "DISABLED" | "ACCOUNT_NOT_READY";
export type WorkerAccountView = Readonly<{
  id: string;
  label: string;
  accountStatus: "DISCONNECTED" | "READY" | "DEGRADED" | "REVOKED" | "DISABLED";
  intervalSeconds: number | null;
  active: boolean | null;
  availability: WorkerAvailability;
}>;

export interface WorkerAccountSettingsRepository {
  list(): Promise<readonly WorkerAccountView[]>;
  update(input: Readonly<{ accountId: string; intervalSeconds: number; active: boolean }>): Promise<WorkerAccountView | null>;
}
