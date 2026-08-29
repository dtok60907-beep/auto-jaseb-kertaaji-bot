import type { Sql } from "postgres";
import type { AccountLease, AccountLeaseAcquisition, RuntimeAccountLeaseRepository } from "./repository.ts";

type LeaseRow = { result_status?: "ACQUIRED" | "RENEWED" | "TAKEN_OVER" | "HELD_BY_OTHER"; account_id: string; lease_owner: string; fencing_token: string; lease_until: Date | string };
function lease(row: LeaseRow): AccountLease { return Object.freeze({ accountId: row.account_id, leaseOwner: row.lease_owner, fencingToken: BigInt(row.fencing_token), leaseUntil: new Date(row.lease_until).toISOString() }); }
export class PostgresRuntimeAccountLeaseRepository implements RuntimeAccountLeaseRepository {
  constructor(readonly sql: Sql) {}
  async acquire(input: Parameters<RuntimeAccountLeaseRepository["acquire"]>[0]): Promise<AccountLeaseAcquisition> {
    const rows = await this.sql<LeaseRow[]>`select result_status, account_id::text, lease_owner::text, fencing_token, lease_until from public.acquire_account_lease(${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.leaseSeconds})`;
    const row = rows[0];
    if (!row || !row.result_status) throw new Error("account lease acquisition did not return a result");
    if (row.result_status === "HELD_BY_OTHER") return Object.freeze({ status: "HELD_BY_OTHER" });
    return Object.freeze({ status: row.result_status, lease: lease(row) });
  }
  async renew(input: Parameters<RuntimeAccountLeaseRepository["renew"]>[0]): Promise<AccountLease | null> {
    const rows = await this.sql<LeaseRow[]>`select account_id::text, lease_owner::text, fencing_token, lease_until from public.renew_account_lease(${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.fencingToken.toString()}::bigint, ${input.leaseSeconds})`;
    return rows[0] ? lease(rows[0]) : null;
  }
  async release(input: Parameters<RuntimeAccountLeaseRepository["release"]>[0]): Promise<boolean> {
    const rows = await this.sql<{ released: boolean }[]>`select public.release_account_lease(${input.accountId}::uuid, ${input.leaseOwner}::uuid, ${input.fencingToken.toString()}::bigint) released`;
    return rows[0]?.released ?? false;
  }
}
