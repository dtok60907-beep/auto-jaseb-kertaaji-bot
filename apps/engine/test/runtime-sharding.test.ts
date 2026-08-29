import assert from "node:assert/strict";
import test from "node:test";

import {
  accountsForShard,
  parseShardConfig,
  shardIndexForAccount,
  shardOwnsAccount,
} from "../src/runtime-sharding/shard.ts";

const ACCOUNTS = [
  "00000000-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000002",
  "00000000-0000-0000-0000-000000000003",
  "00000000-0000-0000-0000-000000000004",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
];

test("account UUID maps to exactly one stable shard", () => {
  for (const accountId of ACCOUNTS) {
    const first = shardIndexForAccount(accountId, 3);
    assert.equal(shardIndexForAccount(accountId, 3), first);
    assert.equal(
      [0, 1, 2].filter((index) => shardOwnsAccount(accountId, { shardCount: 3, shardIndex: index })).length,
      1,
    );
  }
});

test("shard selection partitions safe account metadata without overlap", () => {
  const rows = ACCOUNTS.map((id) => ({ id, label: "safe metadata" }));
  const selected = [0, 1, 2].flatMap((shardIndex) => accountsForShard(rows, { shardCount: 3, shardIndex }));
  assert.deepEqual(selected.map((row) => row.id).sort(), ACCOUNTS.slice().sort());
});

test("single shard is default and invalid environment configuration fails clearly", () => {
  assert.deepEqual(parseShardConfig({}), { shardCount: 1, shardIndex: 0 });
  assert.deepEqual(parseShardConfig({ SHARD_COUNT: "4", SHARD_INDEX: "3" }), { shardCount: 4, shardIndex: 3 });
  assert.throws(() => parseShardConfig({ SHARD_COUNT: "2", SHARD_INDEX: "2" }), /INVALID_SHARD_CONFIG/);
  assert.throws(() => shardIndexForAccount("not-a-uuid", 1), /INVALID_SHARD_INPUT/);
});
