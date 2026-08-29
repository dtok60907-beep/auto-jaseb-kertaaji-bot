export type AccountLease = Readonly<{ accountId: string; leaseOwner: string; fencingToken: bigint; leaseUntil: string }>;
export type AccountLeaseAcquisition =
  | Readonly<{ status: "ACQUIRED" | "RENEWED" | "TAKEN_OVER"; lease: AccountLease }>
  | Readonly<{ status: "HELD_BY_OTHER" }>;

export interface RuntimeAccountLeaseRepository {
  acquire(input: Readonly<{ accountId: string; leaseOwner: string; leaseSeconds: number }>): Promise<AccountLeaseAcquisition>;
  renew(input: Readonly<{ accountId: string; leaseOwner: string; fencingToken: bigint; leaseSeconds: number }>): Promise<AccountLease | null>;
  release(input: Readonly<{ accountId: string; leaseOwner: string; fencingToken: bigint }>): Promise<boolean>;
}
