import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import {
  startNodeProductionHealthServer,
  type ProductionReadinessView,
} from "../src/production/health-server.ts";

function call(port: number, method: string, path: string): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Object.freeze({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      })));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test("health server exposes stable live/ready states and contains callback failure", async () => {
  let current: ProductionReadinessView = Object.freeze({
    ready: false,
    state: "STARTING",
    errorCode: "ENGINE_STARTING",
    instanceId: null,
    shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
  });
  let throwReadiness = false;
  const server = await startNodeProductionHealthServer({
    host: "127.0.0.1",
    port: 0,
    readinessProbeIntervalMilliseconds: 100,
    readinessProbeTimeoutMilliseconds: 50,
    readinessFailureThreshold: 1,
  }, () => {
    if (throwReadiness) throw new Error("raw readiness detail");
    return current;
  });

  assert.deepEqual(await call(server.port, "GET", "/health/live"), {
    status: 200,
    body: JSON.stringify({ status: "alive" }),
  });
  assert.equal((await call(server.port, "GET", "/health/ready")).status, 503);
  current = Object.freeze({
    ready: true,
    state: "RUNNING",
    errorCode: null,
    instanceId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    shard: Object.freeze({ shardCount: 1, shardIndex: 0 }),
  });
  const ready = await call(server.port, "GET", "/health/ready?probe=1");
  assert.equal(ready.status, 200);
  assert.equal(JSON.parse(ready.body).status, "ready");
  assert.equal((await call(server.port, "POST", "/health/ready")).status, 405);
  assert.equal((await call(server.port, "GET", "/missing")).status, 404);
  assert.deepEqual(await call(server.port, "HEAD", "/health/ready"), { status: 200, body: "" });

  throwReadiness = true;
  const unavailable = await call(server.port, "GET", "/health/ready");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.includes("raw readiness detail"), false);
  assert.equal((await call(server.port, "GET", "/health/live")).status, 200);

  const firstClose = server.close();
  const secondClose = server.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
});
