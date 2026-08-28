"""Join one controlled public Telegram target and report only safe state."""

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


SCENARIO = "join_public_target"
CANDIDATE = "telethon"
ADAPTER_VERSION = "Telethon==1.44.0"


@dataclass(frozen=True)
class RunResult:
    records: list[dict[str, Any]]
    passed: bool


def metadata() -> dict[str, Any]:
    return {
        "type": "metadata",
        "candidate": CANDIDATE,
        "runtime": "python",
        "runtimeVersion": platform.python_version(),
        "adapterVersion": ADAPTER_VERSION,
        "scenarioSet": "behavior-public-join-v1",
    }


def failure_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else "PUBLIC_JOIN_FAILED"


async def run_join_public(
    create_adapter: Callable[[], TelethonAdapter],
    target: str,
    *,
    clock_ns: Callable[[], int] = time.perf_counter_ns,
) -> RunResult:
    records: list[dict[str, Any]] = [metadata()]
    adapter = create_adapter()
    try:
        await adapter.connect()
        started = clock_ns()
        result = await adapter.join_public_target(target)
        elapsed_ms = max(0, clock_ns() - started) / 1_000_000
        state = result["state"]
        records.append(
            {
                "type": "sample",
                "candidate": CANDIDATE,
                "scenario": SCENARIO,
                "sessions": 1,
                "metric": "join_latency",
                "value": elapsed_ms,
                "unit": "ms",
                "targetRole": "public_group",
                "joinState": state,
            }
        )
        records.append(
            {
                "type": "assertion",
                "candidate": CANDIDATE,
                "scenario": SCENARIO,
                "name": "public_join_succeeded",
                "passed": state in {"JOINED", "ALREADY_MEMBER"},
                "hardGate": True,
                "targetRole": "public_group",
                "joinState": state,
            }
        )
        return RunResult(records=records, passed=state in {"JOINED", "ALREADY_MEMBER"})
    except Exception as error:
        records.append(
            {
                "type": "assertion",
                "candidate": CANDIDATE,
                "scenario": SCENARIO,
                "name": "public_join_succeeded",
                "passed": False,
                "hardGate": True,
                "targetRole": "public_group",
                "code": failure_code(error),
            }
        )
        return RunResult(records=records, passed=False)
    finally:
        try:
            await adapter.disconnect()
        except Exception:
            pass


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} wajib diisi untuk behavior test akun uji.")
    return value


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args(argv)
    try:
        config = SessionConfig(
            api_id=int(required("TELEGRAM_TEST_API_ID")),
            api_hash=required("TELEGRAM_TEST_API_HASH"),
            session=required("TELEGRAM_TEST_SESSION"),
        )
        target = required("TELEGRAM_TEST_PUBLIC_TARGET")
        result = await run_join_public(lambda: create_telethon_adapter(config), target)
    except Exception as error:
        result = RunResult(
            records=[
                metadata(),
                {
                    "type": "assertion",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "name": "public_join_succeeded",
                    "passed": False,
                    "hardGate": True,
                    "targetRole": "public_group",
                    "code": failure_code(error),
                },
            ],
            passed=False,
        )

    for record in result.records:
        print(json.dumps(record, separators=(",", ":")))
    return 0 if result.passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
