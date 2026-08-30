import { spawn } from "node:child_process";

const databaseUrl = process.env.F5_DATABASE_URL?.trim();

if (!databaseUrl) {
  process.stderr.write("POSTGRES_INTEGRATION_CONFIG_INVALID:F5_DATABASE_URL\n");
  process.exitCode = 2;
} else {
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    "--test",
    "test/broadcast-executor-postgres.integration.test.ts",
    "test/runtime-accounts-postgres.integration.test.ts",
  ], {
    cwd: process.cwd(),
    env: Object.freeze({
      ...process.env,
      F4_DATABASE_URL: databaseUrl,
      F5_DATABASE_URL: databaseUrl,
    }),
    stdio: "inherit",
  });

  child.once("error", () => {
    process.stderr.write("POSTGRES_INTEGRATION_RUNNER_FAILED\n");
    process.exitCode = 2;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 2 : (code ?? 2);
  });
}
