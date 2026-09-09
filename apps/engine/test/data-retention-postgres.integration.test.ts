import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import { PostgresDataRetentionSource } from "../src/data-retention/scheduler.ts";

const databaseUrl = process.env.F5_DATABASE_URL?.trim();

test("production retention source executes both bounded cleanup functions", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 1, prepare: false });
  try {
    const result = await new PostgresDataRetentionSource(sql).prune({
      broadcastHistoryRetentionSeconds: 3 * 24 * 60 * 60,
      internalRetentionSeconds: 3 * 24 * 60 * 60,
    });
    for (const value of Object.values(result)) {
      assert.equal(Number.isSafeInteger(value), true);
      assert.equal(value >= 0, true);
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
});
