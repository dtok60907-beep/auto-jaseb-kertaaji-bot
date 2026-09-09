import assert from "node:assert/strict";
import test from "node:test";

import postgres from "postgres";

import { PostgresCentralMonitorRepository } from "../src/central-monitor/postgres-repository.ts";

const databaseUrl = process.env.F5_DATABASE_URL?.trim();

test("central monitor source discovery executes against the production schema", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 1, prepare: false });
  try {
    const sources = await new PostgresCentralMonitorRepository(sql).loadSources(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    assert.deepEqual(sources, []);
  } finally {
    await sql.end({ timeout: 1 });
  }
});
