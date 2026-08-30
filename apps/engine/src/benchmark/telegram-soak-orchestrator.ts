import type { TelegramSessionKeyRing } from "../../../../packages/telegram-session-crypto/src/index.ts";

import {
  cleanupTelegramSoakRun,
  provisionTelegramSoakAccounts,
  revokeTelegramSoakAccount,
  type TelegramSoakCleanupResult,
  type TelegramSoakProvisioningStore,
  type TelegramSoakSessionVerifier,
} from "./telegram-soak-provisioning.ts";
import {
  runTelegramSoak,
  type SoakEmitter,
  type SoakRunResult,
  type TelegramSoakEnvironment,
} from "./run-telegram-soak.ts";
import type { TelegramSoakStore } from "./telegram-soak-store.ts";

export type TelegramSoakOrchestrationFailureCode =
  | "F57C_PROVISION_FAILED"
  | "F57C_RUN_FAILED"
  | "F57C_HARD_GATE_FAILED"
  | "F57C_TEARDOWN_FAILED";

export type TelegramSoakOrchestrationResult = Readonly<{
  passed: boolean;
  provisionedAccounts: number;
  run: SoakRunResult | null;
  cleanup: TelegramSoakCleanupResult | null;
  failureCode: TelegramSoakOrchestrationFailureCode | null;
}>;

type SoakRun = (input: Parameters<typeof runTelegramSoak>[0]) => Promise<SoakRunResult>;

export async function orchestrateTelegramSoak(input: Readonly<{
  environment: TelegramSoakEnvironment;
  sessions: readonly string[];
  verifier: TelegramSoakSessionVerifier;
  keyRing: Pick<TelegramSessionKeyRing, "encrypt">;
  provisioningStore: TelegramSoakProvisioningStore;
  runStore: TelegramSoakStore;
  emit: SoakEmitter;
  run?: SoakRun;
}>): Promise<TelegramSoakOrchestrationResult> {
  const run = input.run ?? runTelegramSoak;
  let provisionedAccounts = 0;
  let runResult: SoakRunResult | null = null;
  let cleanup: TelegramSoakCleanupResult | null = null;
  let failureCode: TelegramSoakOrchestrationFailureCode | null = null;

  try {
    const provisioned = await provisionTelegramSoakAccounts({
      runId: input.environment.soakConfig.runId,
      sessions: input.sessions,
      intervalSeconds: input.environment.soakConfig.sendIntervalSeconds,
      verifier: input.verifier,
      store: input.provisioningStore,
      keyRing: input.keyRing,
    });
    provisionedAccounts = provisioned.accounts.length;
  } catch {
    return Object.freeze({
      passed: false,
      provisionedAccounts: 0,
      run: null,
      cleanup: null,
      failureCode: "F57C_PROVISION_FAILED",
    });
  }

  try {
    runResult = await run({
      environment: input.environment,
      emit: input.emit,
      store: input.runStore,
      revokeAccount: async ({ account, firedAtIso }) => {
        await revokeTelegramSoakAccount({
          runId: input.environment.soakConfig.runId,
          accountId: account.accountId,
          firedAtIso,
          store: input.provisioningStore,
        });
      },
    });
    if (!runResult.passed) failureCode = "F57C_HARD_GATE_FAILED";
  } catch {
    failureCode = "F57C_RUN_FAILED";
  } finally {
    try {
      cleanup = await cleanupTelegramSoakRun({
        runId: input.environment.soakConfig.runId,
        store: input.provisioningStore,
      });
    } catch {
      failureCode = "F57C_TEARDOWN_FAILED";
      cleanup = null;
    }
  }

  return Object.freeze({
    passed: failureCode === null && runResult?.passed === true && cleanup !== null,
    provisionedAccounts,
    run: runResult,
    cleanup,
    failureCode,
  });
}
