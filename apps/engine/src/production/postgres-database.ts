import postgres, { type Sql } from "postgres";

import type { ProductionEngineConfig } from "./config.ts";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface ProductionDatabase {
  client(): Sql;
  probe(): Promise<void>;
  close(): Promise<void>;
}

class PostgresProductionDatabase implements ProductionDatabase {
  readonly #sql: Sql;
  readonly #closeTimeoutSeconds: number;
  #closePromise: Promise<void> | null = null;

  constructor(sql: Sql, closeTimeoutSeconds: number) {
    this.#sql = sql;
    this.#closeTimeoutSeconds = closeTimeoutSeconds;
    Object.freeze(this);
  }

  client(): Sql { return this.#sql; }

  async probe(): Promise<void> {
    await this.#sql`select 1 as engine_database_ready`;
  }

  close(): Promise<void> {
    if (!this.#closePromise) {
      this.#closePromise = this.#sql.end({ timeout: this.#closeTimeoutSeconds });
    }
    return this.#closePromise;
  }

  toJSON(): Readonly<{ redacted: true }> { return Object.freeze({ redacted: true }); }
  toString(): string { return "PostgresProductionDatabase(redacted)"; }
  [INSPECT](): string { return this.toString(); }
}

export async function openPostgresProductionDatabase(config: ProductionEngineConfig): Promise<ProductionDatabase> {
  const policy = config.databasePolicy;
  const sql = postgres(config.databaseUrl(), {
    max: policy.maxConnections,
    connect_timeout: policy.connectTimeoutSeconds,
    idle_timeout: policy.idleTimeoutSeconds,
    max_lifetime: policy.maxLifetimeSeconds,
    prepare: policy.prepareStatements,
  });
  return new PostgresProductionDatabase(sql, policy.closeTimeoutSeconds);
}
