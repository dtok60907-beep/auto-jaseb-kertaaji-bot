import assert from "node:assert/strict";
import test from "node:test";

import { TelegramSessionKeyRing } from "../../../packages/telegram-session-crypto/src/index.ts";
import type { EntitlementRepository, EntitlementView } from "../src/entitlements/repository.ts";
import type {
  TelegramAccountAuthFlowClaim,
  TelegramAccountAuthFlowResult,
  TelegramAccountAuthFlowStatus,
  TelegramAccountLifecycleRepository,
} from "../src/telegram-accounts/repository.ts";
import {
  TelegramAuthorizationService,
  TelegramAuthorizationServiceError,
} from "../src/telegram-authorization/service.ts";
import {
  TelegramAuthorizationTransportError,
  type TelegramAuthorizationTransport,
  type TelegramPendingAuthorization,
} from "../src/telegram-authorization/transport.ts";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FLOW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const pending: TelegramPendingAuthorization = Object.freeze({
  phoneNumber: "+628123456789",
  phoneCodeHash: "private-code-hash",
  session: "temporary-session",
  codeDelivery: "APP",
});
const active: EntitlementView = Object.freeze({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  userId: USER,
  packageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  packageType: "USERBOT",
  status: "ACTIVE",
  startsAt: "2026-01-01T00:00:00.000Z",
  expiresAt: EXPIRES,
  maxLpmGroups: 10,
  maxChannelTargets: 10,
});

class FakeEntitlements implements EntitlementRepository {
  items: EntitlementView[] = [active];
  async list() { return this.items; }
  async grant(): Promise<EntitlementView> { throw new Error("unused"); }
  async extend(): Promise<EntitlementView | null> { throw new Error("unused"); }
  async revoke(): Promise<boolean> { throw new Error("unused"); }
}

class FakeAccounts implements TelegramAccountLifecycleRepository {
  status: TelegramAccountAuthFlowStatus = "CREATED";
  version = 1n;
  encryptedState: Uint8Array | null = null;
  encryptionKeyVersion: number | null = null;
  transitions: Array<{ nextStatus: string; errorCode?: string; encryptedState?: Uint8Array }> = [];
  completionCalls = 0;

  async beginAuthFlow(): Promise<TelegramAccountAuthFlowResult> {
    return { result: "CREATED", id: FLOW, status: this.status, version: this.version, expiresAt: EXPIRES };
  }
  async transitionAuthFlow(input: Parameters<TelegramAccountLifecycleRepository["transitionAuthFlow"]>[0]) {
    if (input.expectedVersion !== this.version) {
      return { result: "VERSION_CONFLICT" as const, id: FLOW, status: this.status, version: this.version, expiresAt: EXPIRES };
    }
    this.status = input.nextStatus;
    this.version += 1n;
    this.encryptedState = input.encryptedState ? Uint8Array.from(input.encryptedState) : null;
    this.encryptionKeyVersion = input.encryptionKeyVersion ?? null;
    this.transitions.push({
      nextStatus: input.nextStatus,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
      ...(input.encryptedState ? { encryptedState: Uint8Array.from(input.encryptedState) } : {}),
    });
    return { result: "UPDATED" as const, id: FLOW, status: this.status, version: this.version, expiresAt: EXPIRES };
  }
  async claimAuthFlowStep(input: Parameters<TelegramAccountLifecycleRepository["claimAuthFlowStep"]>[0]): Promise<TelegramAccountAuthFlowClaim> {
    if (input.expectedVersion !== this.version || input.expectedStatus !== this.status) {
      return { result: "VERSION_CONFLICT", status: this.status, version: this.version, expiresAt: EXPIRES, encryptedState: null, encryptionKeyVersion: null };
    }
    this.status = "VERIFYING";
    this.version += 1n;
    return {
      result: "CLAIMED", status: this.status, version: this.version, expiresAt: EXPIRES,
      encryptedState: this.encryptedState ? Uint8Array.from(this.encryptedState) : null,
      encryptionKeyVersion: this.encryptionKeyVersion,
    };
  }
  async resolveCompletionAccountId() { return { result: "RESOLVED" as const, accountId: ACCOUNT }; }
  async completeAuthFlow(input: Parameters<TelegramAccountLifecycleRepository["completeAuthFlow"]>[0]) {
    this.completionCalls += 1;
    this.status = "SUCCEEDED";
    this.version += 1n;
    return { result: "CONNECTED" as const, accountId: input.accountId, label: input.label, version: this.version };
  }
  async expireAuthFlows() { return 0; }
  async listOwnedAccounts() { return []; }
  async revokeSession() { return "NOT_FOUND" as const; }
}

class FakeTransport implements TelegramAuthorizationTransport {
  codeResult: "PASSWORD_REQUIRED" | "AUTHORIZED" | "INVALID" = "PASSWORD_REQUIRED";
  passwordInvalid = false;
  calls: Array<{ kind: string; secret?: string }> = [];
  async requestCode(phoneNumber: string) { this.calls.push({ kind: "request", secret: phoneNumber }); return pending; }
  async submitCode(state: TelegramPendingAuthorization, code: string) {
    this.calls.push({ kind: "code", secret: code });
    if (this.codeResult === "INVALID") throw new TelegramAuthorizationTransportError("PHONE_CODE_INVALID");
    if (this.codeResult === "PASSWORD_REQUIRED") return { status: "PASSWORD_REQUIRED" as const, pending: state };
    return { status: "AUTHORIZED" as const, verified: { providerUserId: "900000001", label: "@verified", session: "final-session" } };
  }
  async submitPassword(_state: TelegramPendingAuthorization, password: string) {
    this.calls.push({ kind: "password", secret: password });
    if (this.passwordInvalid) throw new TelegramAuthorizationTransportError("PASSWORD_INVALID");
    return { providerUserId: "900000001", label: "@verified", session: "final-session" };
  }
}

function fixture() {
  const accounts = new FakeAccounts();
  const entitlements = new FakeEntitlements();
  const transport = new FakeTransport();
  const keyRing = TelegramSessionKeyRing.fromHexKeys({ activeKeyVersion: 1, keys: { 1: "11".repeat(32) } });
  const service = new TelegramAuthorizationService({
    accounts, entitlements, transport, keyRing, newAccountId: () => ACCOUNT,
  });
  return { accounts, entitlements, transport, keyRing, service };
}

test("start claims before requesting Telegram code and persists only encrypted pending state", async () => {
  const { accounts, service } = fixture();
  const result = await service.start(USER, "+62 812-3456-789");
  assert.equal(result.status, "CODE_REQUIRED");
  assert.deepEqual(result.status === "CODE_REQUIRED" ? result.flow : null, {
    id: FLOW, status: "CODE_REQUIRED", version: 3, expiresAt: EXPIRES, codeDelivery: "APP",
  });
  assert.deepEqual(accounts.transitions.map((item) => item.nextStatus), ["VERIFYING", "CODE_REQUIRED"]);
  const rendered = Buffer.from(accounts.encryptedState ?? []).toString("utf8");
  assert.equal(rendered.includes("private-code-hash"), false);
  assert.equal(rendered.includes("temporary-session"), false);
});

test("wrong OTP restores CODE_REQUIRED with a new version and never persists the submitted code", async () => {
  const { accounts, transport, service } = fixture();
  await service.start(USER, pending.phoneNumber);
  transport.codeResult = "INVALID";
  await assert.rejects(
    service.submitCode(USER, FLOW, 3, "12345"),
    (error) => {
      assert.equal(error instanceof TelegramAuthorizationServiceError, true);
      assert.equal((error as TelegramAuthorizationServiceError).code, "PHONE_CODE_INVALID");
      assert.equal((error as TelegramAuthorizationServiceError).flow?.version, 5);
      return true;
    },
  );
  assert.equal(JSON.stringify(accounts.transitions).includes("12345"), false);
  assert.equal(accounts.status, "CODE_REQUIRED");
});

test("OTP to 2FA completion reuses durable state and activates the resolved account", async () => {
  const { accounts, service } = fixture();
  await service.start(USER, pending.phoneNumber);
  const passwordStep = await service.submitCode(USER, FLOW, 3, "12345");
  assert.equal(passwordStep.status, "PASSWORD_REQUIRED");
  assert.equal(passwordStep.status === "PASSWORD_REQUIRED" ? passwordStep.flow.version : null, 5);
  const connected = await service.submitPassword(USER, FLOW, 5, "two-factor-secret");
  assert.deepEqual(connected, { status: "CONNECTED", account: { id: ACCOUNT, label: "@verified" } });
  assert.equal(accounts.completionCalls, 1);
  assert.equal(JSON.stringify(accounts.transitions).includes("two-factor-secret"), false);
});

test("expired subscription cancels durable auth state before another Telegram attempt", async () => {
  const { accounts, entitlements, transport, service } = fixture();
  await service.start(USER, pending.phoneNumber);
  entitlements.items = [{ ...active, status: "EXPIRED", expiresAt: "2026-01-02T00:00:00.000Z" }];
  await assert.rejects(
    service.submitCode(USER, FLOW, 3, "12345"),
    (error) => error instanceof TelegramAuthorizationServiceError && error.code === "SUBSCRIPTION_EXPIRED",
  );
  assert.equal(accounts.status, "CANCELLED");
  assert.deepEqual(transport.calls.map((item) => item.kind), ["request"]);
});
