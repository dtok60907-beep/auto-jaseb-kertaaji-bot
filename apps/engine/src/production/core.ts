import { randomUUID } from "node:crypto";

import type { AccountRunnerResult } from "../account-runner/contracts.ts";
import { runBroadcastAccount } from "../account-runner/service.ts";
import { SerialRuntimeRepeatingTaskScheduler } from "../account-runner/serial-scheduler.ts";
import { TeleprotoRuntimeAdapterFactory } from "../account-runner/teleproto-factory.ts";
import type {
  AccountSupervisorDependencies,
  AccountSupervisorHandle,
  AccountSupervisorObserver,
  AccountSupervisorSnapshot,
  AccountSupervisorSummary,
} from "../account-supervisor/contracts.ts";
import { startBroadcastShardSupervisor } from "../account-supervisor/service.ts";
import {
  createPostgresBroadcastCampaignCycleRunner,
  PostgresBroadcastCampaignSource,
  startBroadcastCampaignScheduler,
  type BroadcastCampaignSchedulerHandle,
} from "../broadcast-campaign/scheduler.ts";
import { PostgresBroadcastExecutorRepository } from "../broadcast-executor/postgres-repository.ts";
import { PostgresBroadcastPreparationRepository } from "../broadcast-preparation/postgres-repository.ts";
import { PostgresBroadcastRuntimeAccountRepository } from "../runtime-accounts/postgres-repository.ts";
import { PostgresRuntimeAccountLeaseRepository } from "../runtime-leases/postgres-repository.ts";
import type { ShardConfig } from "../runtime-sharding/shard.ts";
import type { ProductionEngineConfig } from "./config.ts";
import {
  openPostgresProductionDatabase,
  type ProductionDatabase,
} from "./postgres-database.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProductionEngineCoreState = "RUNNING" | "STOPPING" | "STOPPED";

export type ProductionEngineCoreSnapshot = Readonly<{
  state: ProductionEngineCoreState;
  instanceId: string;
  shard: ShardConfig;
  supervisor: AccountSupervisorSnapshot;
}>;

export type ProductionEngineCoreSummary = Readonly<{
  state: "STOPPED";
  instanceId: string;
  shard: ShardConfig;
  supervisor: AccountSupervisorSummary | null;
  cleanupErrorCodes: readonly string[];
}>;

export type ProductionEngineStartErrorCode =
  | "DATABASE_OPEN_FAILED"
  | "DATABASE_PROBE_FAILED"
  | "INSTANCE_ID_INVALID"
  | "ENGINE_COMPOSITION_FAILED"
  | "SUPERVISOR_START_FAILED"
  | "CAMPAIGN_SCHEDULER_START_FAILED";

export class ProductionEngineStartError extends Error {
  readonly code: ProductionEngineStartErrorCode;
  readonly cleanupErrorCodes: readonly string[];

  constructor(code: ProductionEngineStartErrorCode, cleanupErrorCodes: readonly string[] = []) {
    super(code);
    this.name = "ProductionEngineStartError";
    this.code = code;
    this.cleanupErrorCodes = Object.freeze([...cleanupErrorCodes]);
  }

  publicData(): Readonly<{ code: ProductionEngineStartErrorCode; cleanupErrorCodes: readonly string[] }> {
    return Object.freeze({ code: this.code, cleanupErrorCodes: this.cleanupErrorCodes });
  }

  toJSON(): ReturnType<ProductionEngineStartError["publicData"]> { return this.publicData(); }
}

export interface ProductionEngineCoreHandle {
  snapshot(): ProductionEngineCoreSnapshot;
  probeDatabase(): Promise<void>;
  stop(): Promise<ProductionEngineCoreSummary>;
}

type SupervisorStarter = (
  dependencies: AccountSupervisorDependencies,
  input: Parameters<typeof startBroadcastShardSupervisor>[1],
) => Promise<AccountSupervisorHandle>;

type CampaignSchedulerStarter = (sql: ReturnType<ProductionDatabase["client"]>) => BroadcastCampaignSchedulerHandle;

export type ProductionEngineCoreFactories = Readonly<{
  openDatabase(config: ProductionEngineConfig): Promise<ProductionDatabase>;
  startSupervisor: SupervisorStarter;
  runAccount: typeof runBroadcastAccount;
  createInstanceId(): string;
  startCampaignScheduler: CampaignSchedulerStarter;
}>;

const defaultFactories: ProductionEngineCoreFactories = Object.freeze({
  openDatabase: openPostgresProductionDatabase,
  startSupervisor: startBroadcastShardSupervisor,
  runAccount: runBroadcastAccount,
  createInstanceId: randomUUID,
  startCampaignScheduler: (sql) => startBroadcastCampaignScheduler({
    source: new PostgresBroadcastCampaignSource(sql),
    runCycle: createPostgresBroadcastCampaignCycleRunner(sql),
  }),
});

async function closeAfterFailedStart(database: ProductionDatabase): Promise<readonly string[]> {
  try {
    await database.close();
    return Object.freeze([]);
  } catch {
    return Object.freeze(["DATABASE_CLOSE_FAILED"]);
  }
}

export async function startProductionEngineCore(
  config: ProductionEngineConfig,
  input: Readonly<{
    observer?: AccountSupervisorObserver;
    factories?: Partial<ProductionEngineCoreFactories>;
  }> = {},
): Promise<ProductionEngineCoreHandle> {
  const factories = Object.freeze({ ...defaultFactories, ...input.factories });
  let database: ProductionDatabase;
  try { database = await factories.openDatabase(config); }
  catch { throw new ProductionEngineStartError("DATABASE_OPEN_FAILED"); }

  try { await database.probe(); }
  catch {
    throw new ProductionEngineStartError("DATABASE_PROBE_FAILED", await closeAfterFailedStart(database));
  }

  let instanceId: string;
  try { instanceId = factories.createInstanceId().toLowerCase(); }
  catch {
    throw new ProductionEngineStartError("INSTANCE_ID_INVALID", await closeAfterFailedStart(database));
  }
  if (!UUID.test(instanceId)) {
    throw new ProductionEngineStartError("INSTANCE_ID_INVALID", await closeAfterFailedStart(database));
  }

  let supervisorDependencies: AccountSupervisorDependencies;
  try {
    const sql = database.client();
    const runtimeAccounts = new PostgresBroadcastRuntimeAccountRepository(sql);
    const runnerDependencies = Object.freeze({
      runtimeAccounts,
      accountLeases: new PostgresRuntimeAccountLeaseRepository(sql),
      preparations: new PostgresBroadcastPreparationRepository(sql),
      executor: new PostgresBroadcastExecutorRepository(sql),
      sessionKeyRing: config.sessionKeyRing(),
      adapterFactory: new TeleprotoRuntimeAdapterFactory({
        apiId: config.telegramApiId,
        apiHash: config.telegramApiHash(),
        operationTimeoutMilliseconds: config.telegramOperationTimeoutMilliseconds,
      }),
      scheduler: new SerialRuntimeRepeatingTaskScheduler(),
    });
    supervisorDependencies = Object.freeze({
      runtimeAccounts,
      observer: input.observer,
      runAccount: (account): Promise<AccountRunnerResult> => factories.runAccount(runnerDependencies, {
        account,
        leaseOwner: instanceId,
        policy: config.runnerPolicy,
      }),
    });
  } catch {
    throw new ProductionEngineStartError("ENGINE_COMPOSITION_FAILED", await closeAfterFailedStart(database));
  }

  let supervisor: AccountSupervisorHandle;
  try {
    supervisor = await factories.startSupervisor(supervisorDependencies, {
      shard: config.shard,
      policy: config.supervisorPolicy,
    });
  } catch {
    throw new ProductionEngineStartError("SUPERVISOR_START_FAILED", await closeAfterFailedStart(database));
  }

  let campaignScheduler: BroadcastCampaignSchedulerHandle;
  try {
    campaignScheduler = factories.startCampaignScheduler(database.client());
  } catch {
    const cleanupErrorCodes: string[] = [];
    try { await supervisor.stop(); } catch { cleanupErrorCodes.push("SUPERVISOR_STOP_FAILED"); }
    cleanupErrorCodes.push(...await closeAfterFailedStart(database));
    throw new ProductionEngineStartError("CAMPAIGN_SCHEDULER_START_FAILED", cleanupErrorCodes);
  }

  let state: ProductionEngineCoreState = "RUNNING";
  let stopPromise: Promise<ProductionEngineCoreSummary> | null = null;
  const snapshot = (): ProductionEngineCoreSnapshot => Object.freeze({
    state,
    instanceId,
    shard: config.shard,
    supervisor: supervisor.snapshot(),
  });

  const stop = (): Promise<ProductionEngineCoreSummary> => {
    if (stopPromise) return stopPromise;
    state = "STOPPING";
    stopPromise = (async () => {
      const cleanupErrorCodes: string[] = [];
      try { await campaignScheduler.stop(); }
      catch { cleanupErrorCodes.push("CAMPAIGN_SCHEDULER_STOP_FAILED"); }
      let supervisorSummary: AccountSupervisorSummary | null = null;
      try { supervisorSummary = await supervisor.stop(); }
      catch { cleanupErrorCodes.push("SUPERVISOR_STOP_FAILED"); }
      try { await database.close(); }
      catch { cleanupErrorCodes.push("DATABASE_CLOSE_FAILED"); }
      state = "STOPPED";
      return Object.freeze({
        state,
        instanceId,
        shard: config.shard,
        supervisor: supervisorSummary,
        cleanupErrorCodes: Object.freeze(cleanupErrorCodes),
      });
    })();
    return stopPromise;
  };

  return Object.freeze({ snapshot, probeDatabase: () => database.probe(), stop });
}
