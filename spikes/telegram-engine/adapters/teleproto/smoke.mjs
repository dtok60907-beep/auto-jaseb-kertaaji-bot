/**
 * Explicit live smoke test for a dedicated Telegram test account.
 * It only connects, checks authorization, disconnects, and never prints secrets.
 */

import { SessionConfig, createTeleprotoAdapter } from "./adapter.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} wajib diisi untuk smoke test akun uji.`);
  return value;
}

try {
  const config = new SessionConfig({
    apiId: Number(required("TELEGRAM_TEST_API_ID")),
    apiHash: required("TELEGRAM_TEST_API_HASH"),
    session: required("TELEGRAM_TEST_SESSION"),
  });
  const adapter = createTeleprotoAdapter(config);
  await adapter.connect();
  const result = { scenario: "connect_authorized_disconnect", passed: true, ...adapter.describe() };
  await adapter.disconnect();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const code = error?.code ?? "SMOKE_SETUP_OR_CONNECT_FAILED";
  process.stdout.write(`${JSON.stringify({ scenario: "connect_authorized_disconnect", passed: false, code })}\n`);
  process.exitCode = 1;
}
