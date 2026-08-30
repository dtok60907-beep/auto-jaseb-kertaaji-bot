import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

test("dedicated PostgreSQL gate fails closed when its connection is missing", async () => {
  const env = { ...process.env };
  delete env.F4_DATABASE_URL;
  delete env.F5_DATABASE_URL;

  const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "src/benchmark/run-postgres-integration.ts",
    ], {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve(Object.freeze({ code, stdout, stderr })));
  });

  assert.equal(result.code, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "POSTGRES_INTEGRATION_CONFIG_INVALID:F5_DATABASE_URL\n");
});
