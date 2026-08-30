import assert from "node:assert/strict";
import test from "node:test";

import {
  CanaryOperatorInputError,
  executeCanaryOperator,
  parseCanaryOperatorCommand,
  type CanaryOperatorRepository,
} from "../src/operations/canary-operator.ts";
import { runCanaryOperatorCli } from "../src/operations/canary-operator-cli.ts";

test("parses only explicit commands and canonical Telegram numeric IDs", () => {
  assert.deepEqual(parseCanaryOperatorCommand(["list"]), { kind: "LIST" });
  assert.deepEqual(parseCanaryOperatorCommand(["admit", "900000501"]), { kind: "ADMIT", telegramUserId: "900000501" });
  assert.deepEqual(parseCanaryOperatorCommand(["revoke", "900000501"]), { kind: "REVOKE", telegramUserId: "900000501" });
  assert.deepEqual(parseCanaryOperatorCommand(["grant-admin", "900000501"]), { kind: "GRANT_ADMIN", telegramUserId: "900000501" });
  assert.deepEqual(parseCanaryOperatorCommand(["revoke-admin", "900000501"]), { kind: "REVOKE_ADMIN", telegramUserId: "900000501" });

  for (const args of [[], ["list", "1"], ["unknown", "1"], ["admit", "0"], ["admit", "-1"], ["admit", "4.2"], ["admit", "4503599627370496"]]) {
    assert.throws(
      () => parseCanaryOperatorCommand(args),
      (error) => error instanceof CanaryOperatorInputError,
    );
  }
});

test("dispatches operator actions without changing their target identity", async () => {
  const calls: unknown[] = [];
  const repository: CanaryOperatorRepository = {
    async setAdmission(id, enabled) { calls.push(["admission", id, enabled]); return { status: "ADMITTED", telegramUserId: id, slot: 1 }; },
    async setAdmin(id, enabled) { calls.push(["admin", id, enabled]); return { status: "ADMIN_GRANTED", telegramUserId: id }; },
    async list() { calls.push(["list"]); return []; },
  };
  await executeCanaryOperator(parseCanaryOperatorCommand(["admit", "900000501"]), repository);
  await executeCanaryOperator(parseCanaryOperatorCommand(["revoke", "900000502"]), repository);
  await executeCanaryOperator(parseCanaryOperatorCommand(["grant-admin", "900000503"]), repository);
  await executeCanaryOperator(parseCanaryOperatorCommand(["revoke-admin", "900000504"]), repository);
  await executeCanaryOperator(parseCanaryOperatorCommand(["list"]), repository);
  assert.deepEqual(calls, [
    ["admission", "900000501", true],
    ["admission", "900000502", false],
    ["admin", "900000503", true],
    ["admin", "900000504", false],
    ["list"],
  ]);
});

test("CLI emits stable errors without exposing database credentials or provider detail", async () => {
  const secretUrl = "postgresql://operator:database-password@example.invalid/db";
  const output: string[] = [];
  const errors: string[] = [];
  const invalid = await runCanaryOperatorCli({
    args: ["admit", "invalid"],
    databaseUrl: secretUrl,
    writeOut: (line) => output.push(line),
    writeError: (line) => errors.push(line),
  });
  assert.equal(invalid, 2);
  assert.deepEqual(errors, [JSON.stringify({ code: "INVALID_TELEGRAM_USER_ID" })]);

  errors.length = 0;
  const failed = await runCanaryOperatorCli({
    args: ["list"],
    databaseUrl: secretUrl,
    writeOut: (line) => output.push(line),
    writeError: (line) => errors.push(line),
    execute: async () => { throw new Error("raw-query-detail database-password"); },
  });
  assert.equal(failed, 1);
  assert.deepEqual(errors, [JSON.stringify({ code: "CANARY_OPERATOR_FAILED" })]);
  assert.equal([...output, ...errors].join(" ").includes(secretUrl), false);
  assert.equal([...output, ...errors].join(" ").includes("database-password"), false);
  assert.equal([...output, ...errors].join(" ").includes("raw-query-detail"), false);
});
