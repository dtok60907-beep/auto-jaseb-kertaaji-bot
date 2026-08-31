import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";

import type { Sql } from "postgres";

import { createPostgresProductionApiDatabase } from "../src/production/database.ts";

function fakeSql(input: Readonly<{ pending?: boolean }> = {}) {
  let cancelled = false;
  let closeCalls = 0;
  let closeTimeout: number | undefined;
  const pending = new Promise<unknown[]>(() => undefined);
  const resolved = Promise.resolve([{ api_database_ready: 1 }]);
  const query = input.pending ? pending : resolved;
  const executable = Object.assign(query, {
    execute: () => executable,
    cancel: () => { cancelled = true; },
  });
  const tag = (() => executable) as unknown as Sql;
  tag.end = async (options?: { timeout?: number }) => {
    closeCalls += 1;
    closeTimeout = options?.timeout;
  };
  return {
    sql: tag,
    cancelled: () => cancelled,
    closeCalls: () => closeCalls,
    closeTimeout: () => closeTimeout,
  };
}

test("production database bounds probes, cancels timeout, and closes its pool once", async () => {
  const healthy = fakeSql();
  const database = createPostgresProductionApiDatabase(healthy.sql, {
    closeTimeoutSeconds: 7,
    probeTimeoutMilliseconds: 20,
  });
  await database.probe();
  const firstClose = database.close();
  const secondClose = database.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  assert.equal(healthy.closeCalls(), 1);
  assert.equal(healthy.closeTimeout(), 7);
  assert.deepEqual(JSON.parse(JSON.stringify(database)), { redacted: true });
  assert.equal(inspect(database), "PostgresProductionApiDatabase(redacted)");

  const stalled = fakeSql({ pending: true });
  const unavailable = createPostgresProductionApiDatabase(stalled.sql, {
    closeTimeoutSeconds: 7,
    probeTimeoutMilliseconds: 5,
  });
  await assert.rejects(unavailable.probe(), /DATABASE_PROBE_TIMEOUT/);
  assert.equal(stalled.cancelled(), true);
  await unavailable.close();
});
