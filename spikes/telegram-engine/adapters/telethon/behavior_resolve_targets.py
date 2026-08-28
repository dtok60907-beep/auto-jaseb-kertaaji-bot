"""Resolve controlled Telegram targets without join/send side effects."""

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


SCENARIO = "resolve_controlled_targets"
CANDIDATE = "telethon"
ADAPTER_VERSION = "Telethon==1.44.0"
TARGET_ROLES = {
    "public_group": "TELEGRAM_TEST_PUBLIC_TARGET",
    "approval_group": "TELEGRAM_TEST_APPROVAL_TARGET",
    "discussion_channel": "TELEGRAM_TEST_DISCUSSION_CHANNEL",
}


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
        "scenarioSet": "behavior-resolve-v1",
    }


def failure_code(error: Exception) -> str:
    code = getattr(error, "code", None)
    return code if isinstance(code, str) and code else "TARGET_RESOLVE_FAILED"


async def run_resolve_targets(
    create_adapter: Callable[[], TelethonAdapter],
    targets: dict[str, str],
    *,
    clock_ns: Callable[[], int] = time.perf_counter_ns,
) -> RunResult:
    records: list[dict[str, Any]] = [metadata()]
    adapter = create_adapter()
    try:
        await adapter.connect()
        for role in TARGET_ROLES:
            target = targets.get(role, "").strip()
            if not target:
                raise RuntimeError(f"{TARGET_ROLES[role]} wajib diisi untuk behavior test.")
            started = clock_ns()
            resolved = await adapter.resolve_target(target)
            elapsed_ms = max(0, clock_ns() - started) / 1_000_000
            records.append(
                {
                    "type": "sample",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "sessions": 1,
                    "metric": "resolve_latency",
                    "value": elapsed_ms,
                    "unit": "ms",
                    "targetRole": role,
                    "entityType": resolved["entityType"],
                }
            )
            records.append(
                {
                    "type": "assertion",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "name": f"{role}_resolved",
                    "passed": True,
                    "hardGate": True,
                    "targetRole": role,
                    "entityType": resolved["entityType"],
                }
            )
    except Exception as error:
        records.append(
            {
                "type": "assertion",
                "candidate": CANDIDATE,
                "scenario": SCENARIO,
                "name": "all_targets_resolved",
                "passed": False,
                "hardGate": True,
                "code": failure_code(error),
            }
        )
        return RunResult(records=records, passed=False)
    finally:
        try:
            await adapter.disconnect()
        except Exception:
            pass

    records.append(
        {
            "type": "assertion",
            "candidate": CANDIDATE,
            "scenario": SCENARIO,
            "name": "all_targets_resolved",
            "passed": True,
            "hardGate": True,
        }
    )
    return RunResult(records=records, passed=True)


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
        targets = {role: required(name) for role, name in TARGET_ROLES.items()}
        result = await run_resolve_targets(lambda: create_telethon_adapter(config), targets)
    except Exception as error:
        result = RunResult(
            records=[
                metadata(),
                {
                    "type": "assertion",
                    "candidate": CANDIDATE,
                    "scenario": SCENARIO,
                    "name": "all_targets_resolved",
                    "passed": False,
                    "hardGate": True,
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
