import assert from "node:assert/strict";
import test from "node:test";

import { PostgresBroadcastRuntimeAccountRepository } from "../src/runtime-accounts/postgres-repository.ts";
import { PostgresBroadcastPreparationRepository } from "../src/broadcast-preparation/postgres-repository.ts";
import { PostgresRuntimeAccountLeaseRepository } from "../src/runtime-leases/postgres-repository.ts";

test("runtime PostgreSQL repositories load under native TypeScript stripping", () => {
  assert.equal(typeof PostgresBroadcastRuntimeAccountRepository, "function");
  assert.equal(typeof PostgresBroadcastPreparationRepository, "function");
  assert.equal(typeof PostgresRuntimeAccountLeaseRepository, "function");
});
