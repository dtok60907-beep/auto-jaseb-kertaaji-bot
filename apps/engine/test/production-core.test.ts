import assert from "node:assert/strict";
import test from "node:test";
import type { Sql } from "postgres";

import type { AccountRunnerResult } from "../src/account-runner/contracts.ts";
import type {
  AccountSupervisorDependencies,
  AccountSupervisorHandle,
} from "../src/account-supervisor/contracts.ts";
import { PostgresBroadcastExecutorRepository } from "../src/broadcast-executor/postgres-repository.ts";
import { PostgresBroadcastPreparationRepository } from "../src/broadcast-preparation/postgres-repository.ts";
import {
  ProductionEngineStartError,
  startProductionEngineCore,
  type ProductionEngineCoreFactories,
} from "../src/production/core.ts";
import { ProductionEngineConfig } from "../src/production/config.ts";
import type { ProductionDatabase } from "../src/production/postgres-database.ts";
import { PostgresBroadcastRuntimeAccountRepository } from "../src/runtime-accounts/postgres-repository.ts";
import { PostgresRuntimeAccountLeaseRepository } from "../src/runtime-leases/postgres-repository.ts";
import { productionEnvironment, supervisorSnapshot, supervisorSummary } from "../test-support/production-fixtures.ts";

const instanceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const runtimeAccount = Object.freeze({
  accountId: "00000000-0000-0000-0000-000000000001",
  accountType: "USERBOT" as const,
});

function runnerResult(): AccountRunnerResult {
  return Object.freeze({
    accountId: runtimeAccount.accountId,
    status: "DRAINED",
    actions: 0,
    errorCode: null,
    disconnected: true,
    leaseReleased: true,
    cleanupErrorCodes: Object.freeze([]),
  });
}

class FakeDatabase implements ProductionDatabase {
  readonly sql = (() => undefined) as unknown as Sql;
  readonly events: string[];
  probeError: unknown = null;
  closeError: unknown = null;
  clientError: unknown = null;
  probeCalls = 0;
  closeCalls = 0;

  constructor(events: string[] = []) { this.events = events; }
  client() {
    if (this.clientError) throw this.clientError;
    return this.sql;
  }
  async probe() {
    this.probeCalls += 1;
    this.events.push("database.probe");
    if (this.probeError) throw this.probeError;
  }
  async close() {
    this.closeCalls += 1;
    this.events.push("database.close");
    if (this.closeError) throw this.closeError;
  }
}

class FakeSupervisor implements AccountSupervisorHandle {
  readonly events: string[];
  stopError: unknown = null;
  stopCalls = 0;

  constructor(events: string[] = []) { this.events = events; }
  snapshot() { return supervisorSnapshot(); }
  async stop() {
    this.stopCalls += 1;
    this.events.push("supervisor.stop");
    if (this.stopError) throw this.stopError;
    return supervisorSummary();
  }
}

test("core probes database and wires one process identity through supervisor and runner", async () => {
  const config = ProductionEngineConfig.fromEnvironment(productionEnvironment());
  const events: string[] = [];
  const database = new FakeDatabase(events);
  const supervisor = new FakeSupervisor(events);
  const captured: {
    supervisorDependencies: AccountSupervisorDependencies | null;
    supervisorInput: Parameters<ProductionEngineCoreFactories["startSupervisor"]>[1] | null;
    runnerDependencies: Parameters<ProductionEngineCoreFactories["runAccount"]>[0] | null;
    runnerInput: Parameters<ProductionEngineCoreFactories["runAccount"]>[1] | null;
  } = {
    supervisorDependencies: null,
    supervisorInput: null,
    runnerDependencies: null,
    runnerInput: null,
  };

  const handle = await startProductionEngineCore(config, { factories: {
    openDatabase: async () => database,
    createInstanceId: () => instanceId.toUpperCase(),
    startSupervisor: async (dependencies, input) => {
      captured.supervisorDependencies = dependencies;
      captured.supervisorInput = input;
      return supervisor;
    },
    runAccount: async (dependencies, input) => {
      captured.runnerDependencies = dependencies;
      captured.runnerInput = input;
      return runnerResult();
    },
  } });

  assert.equal(database.probeCalls, 1);
  assert.deepEqual(handle.snapshot(), {
    state: "RUNNING",
    instanceId,
    shard: config.shard,
    supervisor: supervisorSnapshot(),
  });
  assert.deepEqual(captured.supervisorInput, { shard: config.shard, policy: config.supervisorPolicy });
  assert.ok(captured.supervisorDependencies?.runtimeAccounts instanceof PostgresBroadcastRuntimeAccountRepository);
  await captured.supervisorDependencies!.runAccount(runtimeAccount);
  assert.equal(captured.runnerInput?.leaseOwner, instanceId);
  assert.equal(captured.runnerInput?.policy, config.runnerPolicy);
  assert.ok(captured.runnerDependencies?.runtimeAccounts instanceof PostgresBroadcastRuntimeAccountRepository);
  assert.ok(captured.runnerDependencies?.accountLeases instanceof PostgresRuntimeAccountLeaseRepository);
  assert.ok(captured.runnerDependencies?.preparations instanceof PostgresBroadcastPreparationRepository);
  assert.ok(captured.runnerDependencies?.executor instanceof PostgresBroadcastExecutorRepository);
  assert.equal(captured.runnerDependencies?.sessionKeyRing, config.sessionKeyRing());
  assert.equal(captured.runnerDependencies?.adapterFactory.constructor.name, "TeleprotoRuntimeAdapterFactory");

  const firstStop = handle.stop();
  const secondStop = handle.stop();
  assert.equal(firstStop, secondStop);
  const summary = await firstStop;
  assert.deepEqual(events, ["database.probe", "supervisor.stop", "database.close"]);
  assert.equal(summary.state, "STOPPED");
  assert.equal(summary.instanceId, instanceId);
  assert.deepEqual(summary.cleanupErrorCodes, []);
  assert.equal(supervisor.stopCalls, 1);
  assert.equal(database.closeCalls, 1);
});

test("startup failures roll back opened resources and expose only stable codes", async () => {
  const config = ProductionEngineConfig.fromEnvironment(productionEnvironment());
  const cases: Array<Readonly<{
    expectedCode: ProductionEngineStartError["code"];
    database?: FakeDatabase;
    factories: Partial<ProductionEngineCoreFactories>;
    expectedCloseCalls: number;
    expectedCleanup?: readonly string[];
  }>> = [
    {
      expectedCode: "DATABASE_OPEN_FAILED",
      factories: { openDatabase: async () => { throw new Error("raw database URL detail"); } },
      expectedCloseCalls: 0,
    },
    {
      expectedCode: "DATABASE_PROBE_FAILED",
      database: Object.assign(new FakeDatabase(), { probeError: new Error("raw probe detail") }),
      factories: {},
      expectedCloseCalls: 1,
    },
    {
      expectedCode: "INSTANCE_ID_INVALID",
      database: new FakeDatabase(),
      factories: { createInstanceId: () => "duplicate-process-id" },
      expectedCloseCalls: 1,
    },
    {
      expectedCode: "ENGINE_COMPOSITION_FAILED",
      database: Object.assign(new FakeDatabase(), { clientError: new Error("raw client detail") }),
      factories: {},
      expectedCloseCalls: 1,
    },
    {
      expectedCode: "SUPERVISOR_START_FAILED",
      database: Object.assign(new FakeDatabase(), { closeError: new Error("raw close detail") }),
      factories: { startSupervisor: async () => { throw new Error("raw supervisor detail"); } },
      expectedCloseCalls: 1,
      expectedCleanup: ["DATABASE_CLOSE_FAILED"],
    },
  ];

  for (const item of cases) {
    const database = item.database;
    let error: unknown;
    try {
      await startProductionEngineCore(config, { factories: {
        openDatabase: async () => database ?? new FakeDatabase(),
        createInstanceId: () => instanceId,
        startSupervisor: async () => new FakeSupervisor(),
        ...item.factories,
      } });
    } catch (caught) { error = caught; }
    assert.ok(error instanceof ProductionEngineStartError, item.expectedCode);
    assert.equal(error.code, item.expectedCode);
    assert.deepEqual(error.cleanupErrorCodes, item.expectedCleanup ?? []);
    assert.equal(database?.closeCalls ?? 0, item.expectedCloseCalls);
    assert.equal(JSON.stringify(error).includes("raw"), false);
  }
});

test("core stop closes database even when supervisor stop fails", async () => {
  const config = ProductionEngineConfig.fromEnvironment(productionEnvironment());
  const events: string[] = [];
  const database = new FakeDatabase(events);
  database.closeError = new Error("raw close detail");
  const supervisor = new FakeSupervisor(events);
  supervisor.stopError = new Error("raw supervisor detail");
  const handle = await startProductionEngineCore(config, { factories: {
    openDatabase: async () => database,
    createInstanceId: () => instanceId,
    startSupervisor: async () => supervisor,
  } });

  const summary = await handle.stop();
  assert.deepEqual(events, ["database.probe", "supervisor.stop", "database.close"]);
  assert.deepEqual(summary.cleanupErrorCodes, ["SUPERVISOR_STOP_FAILED", "DATABASE_CLOSE_FAILED"]);
  assert.equal(JSON.stringify(summary).includes("raw"), false);
});
