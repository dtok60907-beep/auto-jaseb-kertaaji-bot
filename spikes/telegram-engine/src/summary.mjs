const HARD_COUNTERS = new Set(["event_loss", "duplicate_side_effect"]);

export function quantile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (percentile < 0 || percentile > 1) throw new RangeError("percentile must be between 0 and 1");
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function requireString(value, field, line) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`line ${line}: ${field} must be a non-empty string`);
  }
  return value;
}

export function parseJsonLines(input) {
  const records = [];
  for (const [index, raw] of input.split(/\r?\n/).entries()) {
    const value = raw.trim();
    if (!value) continue;
    let record;
    try {
      record = JSON.parse(value);
    } catch {
      throw new Error(`line ${index + 1}: invalid JSON`);
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new Error(`line ${index + 1}: record must be an object`);
    }
    requireString(record.type, "type", index + 1);
    requireString(record.candidate, "candidate", index + 1);
    records.push({ ...record, _line: index + 1 });
  }
  if (records.length === 0) throw new Error("benchmark input is empty");
  return records;
}

export function summarize(records) {
  const candidates = new Map();

  for (const record of records) {
    const state = candidates.get(record.candidate) ?? {
      metadata: [],
      assertions: [],
      metrics: new Map(),
      invalid: [],
    };
    candidates.set(record.candidate, state);

    if (record.type === "metadata") {
      state.metadata.push(record);
      continue;
    }

    if (record.type === "assertion") {
      if (typeof record.passed !== "boolean") {
        state.invalid.push(`line ${record._line}: assertion.passed must be boolean`);
        continue;
      }
      state.assertions.push(record);
      continue;
    }

    if (record.type === "sample") {
      if (typeof record.value !== "number" || !Number.isFinite(record.value)) {
        state.invalid.push(`line ${record._line}: sample.value must be finite number`);
        continue;
      }
      if (typeof record.sessions !== "number" || !Number.isInteger(record.sessions) || record.sessions < 1) {
        state.invalid.push(`line ${record._line}: sample.sessions must be a positive integer`);
        continue;
      }
      const metric = requireString(record.metric, "metric", record._line);
      const scenario = requireString(record.scenario, "scenario", record._line);
      const unit = requireString(record.unit, "unit", record._line);
      const key = JSON.stringify([scenario, record.sessions, metric, unit]);
      const group = state.metrics.get(key) ?? { scenario, sessions: record.sessions, metric, unit, values: [] };
      group.values.push(record.value);
      state.metrics.set(key, group);
      continue;
    }

    state.invalid.push(`line ${record._line}: unknown record type ${record.type}`);
  }

  const output = {};
  for (const [candidate, state] of candidates) {
    const hardFailures = state.assertions
      .filter((item) => item.hardGate === true && item.passed === false)
      .map((item) => `${item.scenario}:${item.name}`);

    for (const group of state.metrics.values()) {
      if (HARD_COUNTERS.has(group.metric) && group.values.some((value) => value > 0)) {
        hardFailures.push(`${group.scenario}:${group.metric}>0`);
      }
    }

    if (state.metadata.length !== 1) {
      state.invalid.push(`candidate requires exactly one metadata record; found ${state.metadata.length}`);
    }

    output[candidate] = {
      eligible: state.invalid.length === 0 && hardFailures.length === 0,
      metadata: state.metadata[0] ?? null,
      invalid: state.invalid,
      hardFailures: [...new Set(hardFailures)].sort(),
      assertions: {
        total: state.assertions.length,
        passed: state.assertions.filter((item) => item.passed).length,
        failed: state.assertions.filter((item) => !item.passed).length,
      },
      metrics: [...state.metrics.values()]
        .map((group) => ({
          scenario: group.scenario,
          sessions: group.sessions,
          metric: group.metric,
          unit: group.unit,
          samples: group.values.length,
          min: Math.min(...group.values),
          p50: quantile(group.values, 0.5),
          p95: quantile(group.values, 0.95),
          p99: quantile(group.values, 0.99),
          max: Math.max(...group.values),
        }))
        .sort((a, b) => a.scenario.localeCompare(b.scenario) || a.sessions - b.sessions || a.metric.localeCompare(b.metric)),
    };
  }

  return output;
}
