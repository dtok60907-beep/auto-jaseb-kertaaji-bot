import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

import { ProductionApiConfig } from "../src/production/config.ts";
import { composeProductionApi } from "../src/production/composition.ts";

const databaseUrl = process.env.API_DATABASE_URL?.trim();
const telegramUserId = "900000601";
const botToken = "123456789:production-composition-proof";

function config() {
  const configDatabaseUrl = new URL(databaseUrl!);
  if (!configDatabaseUrl.password) configDatabaseUrl.password = "ephemeral-proof-only";
  return ProductionApiConfig.fromEnvironment({
    DATABASE_URL: configDatabaseUrl.toString(),
    TELEGRAM_BOT_TOKEN: botToken,
    API_DATABASE_MAX_CONNECTIONS: "3",
    API_DATABASE_CONNECT_TIMEOUT_SECONDS: "5",
    API_DATABASE_IDLE_TIMEOUT_SECONDS: "10",
    API_DATABASE_MAX_LIFETIME_SECONDS: "300",
    API_DATABASE_CLOSE_TIMEOUT_SECONDS: "5",
    API_DATABASE_PREPARE_STATEMENTS: "false",
    API_SESSION_TTL_SECONDS: "3600",
    TELEGRAM_INIT_DATA_MAX_AGE_SECONDS: "300",
    TELEGRAM_INIT_DATA_CLOCK_SKEW_SECONDS: "30",
    API_HOST: "127.0.0.1",
    PORT: "8080",
    API_READINESS_PROBE_INTERVAL_MS: "1000",
    API_READINESS_PROBE_TIMEOUT_MS: "500",
    API_READINESS_FAILURE_THRESHOLD: "2",
    API_SHUTDOWN_GRACE_MS: "5000",
  });
}

function signedInitData(): string {
  const fields = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1_000)),
    query_id: "production-composition-proof",
    user: JSON.stringify({ id: Number(telegramUserId), first_name: "Composition Proof", language_code: "id" }),
  });
  const check = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  fields.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return fields.toString();
}

test("production composition wires canary login, user auth, admin auth, and every business repository", { skip: !databaseUrl }, async () => {
  const sql = postgres(databaseUrl!, { max: 3, prepare: false });
  const api = composeProductionApi(config(), sql);
  try {
    await sql`delete from public.canary_admissions where telegram_user_id = ${telegramUserId}::bigint`;
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;

    const packages = await api.inject({ method: "GET", url: "/v1/packages" });
    assert.equal(packages.statusCode, 200);
    assert.deepEqual(packages.json(), { packages: [] });

    const denied = await api.inject({
      method: "POST",
      url: "/v1/auth/telegram",
      payload: { initData: signedInitData() },
    });
    assert.equal(denied.statusCode, 403);
    assert.deepEqual(denied.json(), { code: "CANARY_ACCESS_REQUIRED" });
    assert.equal((await sql`select count(*)::integer count from public.app_users where telegram_user_id = ${telegramUserId}::bigint`)[0].count, 0);

    await sql`select * from public.set_canary_admission(${telegramUserId}::bigint, true)`;
    const login = await api.inject({
      method: "POST",
      url: "/v1/auth/telegram",
      payload: { initData: signedInitData() },
    });
    assert.equal(login.statusCode, 200);
    const token = login.json().accessToken as string;
    const userId = login.json().user.id as string;
    assert.match(token, /^jas_[A-Za-z0-9_-]{43}$/);

    const userSettings = await api.inject({
      method: "GET",
      url: "/v1/broadcast/settings",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(userSettings.statusCode, 200);
    assert.deepEqual(userSettings.json(), { materials: [], lpmTargets: [] });

    const noAdmin = await api.inject({
      method: "GET",
      url: "/v1/admin/packages",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(noAdmin.statusCode, 403);
    await sql`insert into public.app_admins (user_id) values (${userId}::uuid)`;
    const admin = await api.inject({
      method: "GET",
      url: "/v1/admin/packages",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(admin.statusCode, 200);
    assert.deepEqual(admin.json(), { packages: [] });

    const authorization = { authorization: `Bearer ${token}` };
    const autoComment = await api.inject({ method: "GET", url: "/v1/auto-comment/settings", headers: authorization });
    const userbot = await api.inject({ method: "GET", url: "/v1/userbot/profile", headers: authorization });
    const workers = await api.inject({ method: "GET", url: "/v1/admin/worker-accounts", headers: authorization });
    const operation = await api.inject({
      method: "GET",
      url: "/v1/broadcast/operations/00000000-0000-4000-8000-000000000001",
      headers: authorization,
    });
    assert.equal(autoComment.statusCode, 200);
    assert.equal(userbot.statusCode, 200);
    assert.equal(workers.statusCode, 200);
    assert.equal(operation.statusCode, 404);
  } finally {
    await api.close();
    await sql`delete from public.canary_admissions where telegram_user_id = ${telegramUserId}::bigint`;
    await sql`delete from public.app_users where telegram_user_id = ${telegramUserId}::bigint`;
    await sql.end({ timeout: 5 });
  }
});
