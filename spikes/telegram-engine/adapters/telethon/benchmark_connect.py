"""One-scenario JSONL benchmark runner: connect -> authorized -> disconnect."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from adapter import SessionConfig, TelethonAdapter, create_telethon_adapter


SCENARIO = "connect_authorized_disconnect"
CANDIDATE = "telethon"
ADAPTER_VERSION = "Telethon==1.44.0"
MAX_RUNS = 1_000


@dataclass(frozen=True)
class RunResult:
    records: list[dict[str, Any]]
    passed: bool


def _metadata() -> dict[str, Any]:
    return {
        "type": "metadata",
        "candidate": CANDIDATE,
        "runtime": "python",
        "runtimeVersion": platform.python_version(),
        "adapterVersion": ADAPTER_VERSION,
        "scenarioSet": "connect-v1",
    }


def _failure_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else "BENCHMARK_CONNECT_FAILED"


async def run_connect_samples(
    create_adapter: Callable[[], TelethonAdapter],
    *,
    runs: int,
    clock_ns: Callable[[], int] = time.perf_counter_ns,
) -> RunResult:
    if not isinstance(runs, int) or not 1 <= runs <= MAX_RUNS:
        raise ValueError(f"runs must be an integer between 1 and {MAX_RUNS}")

    records: list[dict[str, Any]] = [_metadata()]
    for index in range(runs):
        adapter = create_adapter()
        started = clock_ns()
        try:
            await adapter.connect()
            await adapter.disconnect()
        except Exception as error:
            # Cleanup is best effort only. The hard assertion preserves the real failure.
            try:
                await adapter.disconnect()
            except Exception:
                pass
            records.append(
                {
                    "type": "assertion",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "name": "all_iterations_passed",
                    "passed": False,
                    "hardGate": True,
                    "iteration": index + 1,
                    "code": _failure_code(error),
                }
            )
            return RunResult(records=records, passed=False)

        elapsed_ms = max(0, clock_ns() - started) / 1_000_000
        records.append(
            {
                "type": "sample",
                "candidate": CANDIDATE,
                "scenario": SCENARIO,
                "sessions": 1,
                "metric": "latency",
                "value": elapsed_ms,
                "unit": "ms",
            }
        )

    records.append(
        {
            "type": "assertion",
            "candidate": CANDIDATE,
            "scenario": SCENARIO,
            "name": "all_iterations_passed",
            "passed": True,
            "hardGate": True,
        }
    )
    return RunResult(records=records, passed=True)


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} wajib diisi untuk benchmark akun uji.")
    return value


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=10)
    args = parser.parse_args(argv)
    try:
        config = SessionConfig(
            api_id=int(required("TELEGRAM_TEST_API_ID")),
            api_hash=required("TELEGRAM_TEST_API_HASH"),
            session=required("TELEGRAM_TEST_SESSION"),
        )
        result = await run_connect_samples(lambda: create_telethon_adapter(config), runs=args.runs)
    except Exception as error:
        result = RunResult(
            records=[
                _metadata(),
                {
                    "type": "assertion",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "name": "all_iterations_passed",
                    "passed": False,
                    "hardGate": True,
                    "iteration": 0,
                    "code": _failure_code(error),
                },
            ],
            passed=False,
        )

    for record in result.records:
        print(json.dumps(record, separators=(",", ":")))
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
