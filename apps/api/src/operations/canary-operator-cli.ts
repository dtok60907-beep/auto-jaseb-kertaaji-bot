import { pathToFileURL } from "node:url";
import postgres from "postgres";

import {
  CanaryOperatorInputError,
  executeCanaryOperator,
  parseCanaryOperatorCommand,
  type CanaryOperatorCommand,
} from "./canary-operator.ts";
import { PostgresCanaryOperatorRepository } from "./postgres-canary-operator-repository.ts";

export async function runCanaryOperatorCli(input: Readonly<{
  args: readonly string[];
  databaseUrl: string | undefined;
  writeOut: (line: string) => void;
  writeError: (line: string) => void;
  execute?: (command: CanaryOperatorCommand, databaseUrl: string) => Promise<unknown>;
}>): Promise<number> {
  let command;
  try {
    command = parseCanaryOperatorCommand(input.args);
  } catch (error) {
    const code = error instanceof CanaryOperatorInputError
      ? error.code
      : "INVALID_CANARY_OPERATOR_COMMAND";
    input.writeError(JSON.stringify({ code }));
    return 2;
  }
  const databaseUrl = input.databaseUrl?.trim();
  if (!databaseUrl) {
    input.writeError(JSON.stringify({ code: "DATABASE_URL_REQUIRED" }));
    return 2;
  }
  try {
    const result = await (input.execute ?? executeWithPostgres)(command, databaseUrl);
    input.writeOut(JSON.stringify(result));
    return 0;
  } catch {
    input.writeError(JSON.stringify({ code: "CANARY_OPERATOR_FAILED" }));
    return 1;
  }
}

async function executeWithPostgres(command: CanaryOperatorCommand, databaseUrl: string): Promise<unknown> {
  const sql = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 5 });
  try {
    return await executeCanaryOperator(command, new PostgresCanaryOperatorRepository(sql));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  process.exitCode = await runCanaryOperatorCli({
    args: process.argv.slice(2),
    databaseUrl: process.env.DATABASE_URL,
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
