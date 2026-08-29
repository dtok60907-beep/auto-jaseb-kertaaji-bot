import {
  TeleprotoProductionAdapter,
  TeleprotoSessionConfig,
} from "../teleproto-adapter.ts";
import type { TelegramRuntimeAdapterFactory } from "./contracts.ts";

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class TeleprotoRuntimeAdapterFactory implements TelegramRuntimeAdapterFactory {
  readonly apiId: number;
  readonly operationTimeoutMilliseconds: number;
  #apiHash: string;

  constructor(input: Readonly<{
    apiId: number;
    apiHash: string;
    operationTimeoutMilliseconds?: number;
  }>) {
    const operationTimeoutMilliseconds = input.operationTimeoutMilliseconds ?? 30_000;
    if (!Number.isInteger(input.apiId) || input.apiId <= 0) throw new TypeError("INVALID_TELEGRAM_API_ID");
    if (typeof input.apiHash !== "string" || !input.apiHash.trim()) throw new TypeError("INVALID_TELEGRAM_API_HASH");
    if (!Number.isInteger(operationTimeoutMilliseconds) || operationTimeoutMilliseconds < 1 || operationTimeoutMilliseconds > 120_000) {
      throw new TypeError("INVALID_OPERATION_TIMEOUT");
    }
    this.apiId = input.apiId;
    this.operationTimeoutMilliseconds = operationTimeoutMilliseconds;
    this.#apiHash = input.apiHash.trim();
    Object.freeze(this);
  }

  create(input: Parameters<TelegramRuntimeAdapterFactory["create"]>[0]): TeleprotoProductionAdapter {
    const config = new TeleprotoSessionConfig({
      apiId: this.apiId,
      apiHash: this.#apiHash,
      session: input.session,
    });
    return new TeleprotoProductionAdapter(config.createClientPort(), {
      operationTimeoutMs: this.operationTimeoutMilliseconds,
    });
  }

  toJSON(): Readonly<{ redacted: true; apiId: number; operationTimeoutMilliseconds: number }> {
    return Object.freeze({
      redacted: true,
      apiId: this.apiId,
      operationTimeoutMilliseconds: this.operationTimeoutMilliseconds,
    });
  }

  toString(): string {
    return `TeleprotoRuntimeAdapterFactory(redacted, apiId=${this.apiId})`;
  }

  [INSPECT](): string {
    return this.toString();
  }
}
