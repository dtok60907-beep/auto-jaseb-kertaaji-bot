export type ShardConfig = Readonly<{ shardCount: number; shardIndex: number }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Reads SHARD_COUNT/SHARD_INDEX. One shard is the safe default for local and
 * single-runtime deployments; a multi-shard deployment must use the same count
 * in every runtime and a distinct index from 0 through count - 1.
 */
export function parseShardConfig(env: Readonly<Record<string, string | undefined>>): ShardConfig {
  const countText = env.SHARD_COUNT ?? "1";
  const indexText = env.SHARD_INDEX ?? "0";
  if (!/^[1-9][0-9]*$/.test(countText) || !/^[0-9]+$/.test(indexText)) throw new Error("INVALID_SHARD_CONFIG");
  const shardCount = Number(countText);
  const shardIndex = Number(indexText);
  if (!positiveInteger(shardCount) || !Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount || shardCount > 65_536) throw new Error("INVALID_SHARD_CONFIG");
  return Object.freeze({ shardCount, shardIndex });
}

/** Uses the UUID's full unsigned 128-bit value, avoiding process-local hashes. */
export function shardIndexForAccount(accountId: string, shardCount: number): number {
  if (!UUID.test(accountId) || !positiveInteger(shardCount) || shardCount > 65_536) throw new Error("INVALID_SHARD_INPUT");
  return Number(BigInt(`0x${accountId.replaceAll("-", "")}`) % BigInt(shardCount));
}

export function shardOwnsAccount(accountId: string, config: ShardConfig): boolean {
  return shardIndexForAccount(accountId, config.shardCount) === config.shardIndex;
}

/** Filters safe account metadata only; sessions are deliberately absent here. */
export function accountsForShard<T extends Readonly<{ id: string }>>(accounts: readonly T[], config: ShardConfig): readonly T[] {
  return Object.freeze(accounts.filter((account) => shardOwnsAccount(account.id, config)));
}
