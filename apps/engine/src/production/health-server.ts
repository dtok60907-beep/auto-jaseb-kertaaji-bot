import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { ShardConfig } from "../runtime-sharding/shard.ts";
import type { ProductionHealthPolicy } from "./config.ts";

export type ProductionReadinessErrorCode =
  | "DATABASE_UNAVAILABLE"
  | "ENGINE_STARTING"
  | "ENGINE_FAILED"
  | "ENGINE_STOPPING"
  | "ENGINE_STOPPED";

export type ProductionReadinessView = Readonly<{
  ready: boolean;
  state: "STARTING" | "RUNNING" | "FAILED" | "STOPPING" | "STOPPED";
  errorCode: ProductionReadinessErrorCode | null;
  instanceId: string | null;
  shard: ShardConfig;
}>;

export interface ProductionHealthServer {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

export type ProductionHealthServerStarter = (
  policy: ProductionHealthPolicy,
  readiness: () => ProductionReadinessView,
) => Promise<ProductionHealthServer>;

function json(serverResponse: ServerResponse, statusCode: number, body: unknown, head: boolean): void {
  const serialized = JSON.stringify(body);
  serverResponse.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
  });
  serverResponse.end(head ? undefined : serialized);
}

export async function startNodeProductionHealthServer(
  policy: ProductionHealthPolicy,
  readiness: () => ProductionReadinessView,
): Promise<ProductionHealthServer> {
  if (typeof policy.host !== "string" || !policy.host || !Number.isInteger(policy.port) || policy.port < 0 || policy.port > 65_535) {
    throw new TypeError("INVALID_HEALTH_SERVER_CONFIG");
  }
  const server: Server = createServer((request, response) => {
    const method = request.method ?? "";
    const head = method === "HEAD";
    if (method !== "GET" && !head) {
      json(response, 405, { errorCode: "METHOD_NOT_ALLOWED" }, false);
      return;
    }
    let path: string;
    try { path = new URL(request.url ?? "/", "http://engine-health").pathname; }
    catch {
      json(response, 400, { errorCode: "INVALID_REQUEST_PATH" }, head);
      return;
    }
    if (path === "/health/live") {
      json(response, 200, { status: "alive" }, head);
      return;
    }
    if (path === "/health/ready") {
      let current: ProductionReadinessView;
      try { current = readiness(); }
      catch {
        json(response, 503, { status: "not_ready", errorCode: "READINESS_STATE_UNAVAILABLE" }, head);
        return;
      }
      json(response, current.ready ? 200 : 503, {
        status: current.ready ? "ready" : "not_ready",
        state: current.state,
        errorCode: current.errorCode,
        instanceId: current.instanceId,
        shard: current.shard,
      }, head);
      return;
    }
    json(response, 404, { errorCode: "NOT_FOUND" }, head);
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(policy.port, policy.host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("HEALTH_SERVER_ADDRESS_MISSING");
  }

  let closePromise: Promise<void> | null = null;
  return Object.freeze({
    host: policy.host,
    port: address.port,
    close() {
      if (!closePromise) {
        closePromise = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
      return closePromise;
    },
  });
}
