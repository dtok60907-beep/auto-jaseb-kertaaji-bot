import { inspect } from "node:util";

import type { Sql } from "postgres";

import { createProductionApiDatabase } from "./composition.ts";
import type { ProductionApiConfig } from "./config.ts";

const INSPECT = inspect.custom;

export interface ProductionApiDatabase {
  client(): Sql;
  probe(): Promise<void>;
  close(): Promise<void>;
}

class PostgresProductionApiDatabase implements ProductionApiDatabase {
  readonly #sql: Sql;
  readonly #closeTimeoutSeconds: number;
  readonly #probeTimeoutMilliseconds: number;
  #closePromise: Promise<void> | null = null;

  constructor(sql: Sql, input: Readonly<{ closeTimeoutSeconds: number; probeTimeoutMilliseconds: number }>) {
    this.#sql = sql;
    this.#closeTimeoutSeconds = input.closeTimeoutSeconds;
    this.#probeTimeoutMilliseconds = input.probeTimeoutMilliseconds;
    Object.freeze(this);
  }

  client(): Sql { return this.#sql; }

  async probe(): Promise<void> {
    const query = this.#sql`select 1 as api_database_ready`.execute();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        query,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            try { query.cancel(); }
            catch { /* timeout remains authoritative */ }
            reject(new Error("DATABASE_PROBE_TIMEOUT"));
          }, this.#probeTimeoutMilliseconds);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#sql.end({ timeout: this.#closeTimeoutSeconds });
    }
    return this.#closePromise;
  }

  toJSON(): Readonly<{ redacted: true }> { return Object.freeze({ redacted: true }); }
  toString(): string { return "PostgresProductionApiDatabase(redacted)"; }
  [INSPECT](): string { return this.toString(); }
}

export function createPostgresProductionApiDatabase(
  sql: Sql,
  input: Readonly<{ closeTimeoutSeconds: number; probeTimeoutMilliseconds: number }>,
): ProductionApiDatabase {
  return new PostgresProductionApiDatabase(sql, input);
}

export async function openProductionApiDatabase(config: ProductionApiConfig): Promise<ProductionApiDatabase> {
  return createPostgresProductionApiDatabase(createProductionApiDatabase(config), {
    closeTimeoutSeconds: config.databasePolicy.closeTimeoutSeconds,
    probeTimeoutMilliseconds: config.serverPolicy.readinessProbeTimeoutMilliseconds,
  });
}
