import assert from "node:assert/strict";
import test from "node:test";
import type { PendingQuery, Row, Sql } from "postgres";

import { createPostgresProductionDatabase } from "../src/production/postgres-database.ts";

function pendingProbe() {
  let cancelCalls = 0;
  const unresolved = new Promise<never>(() => undefined) as unknown as PendingQuery<Row[]>;
  const query = Object.assign(unresolved, {
    execute: () => query,
    cancel: () => { cancelCalls += 1; },
  });
  const sql = Object.assign((() => query), {
    end: async () => undefined,
  }) as unknown as Sql;
  return { sql, cancelCalls: () => cancelCalls };
}

test("database probe reaches its client-side deadline and requests cancellation", async () => {
  const fake = pendingProbe();
  const database = createPostgresProductionDatabase(fake.sql, {
    closeTimeoutSeconds: 1,
    probeTimeoutMilliseconds: 5,
  });

  await assert.rejects(database.probe(), (error: unknown) => (
    error instanceof Error && error.message === "DATABASE_PROBE_TIMEOUT"
  ));
  assert.equal(fake.cancelCalls(), 1);
});
