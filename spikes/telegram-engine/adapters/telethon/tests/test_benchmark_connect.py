from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import TelegramAdapterError
from benchmark_connect import CANDIDATE, SCENARIO, run_connect_samples


class FakeAdapter:
    def __init__(self, *, fail: Exception | None = None) -> None:
        self.fail = fail
        self.connect_calls = 0
        self.disconnect_calls = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        if self.fail:
            raise self.fail

    async def disconnect(self) -> None:
        self.disconnect_calls += 1


class ConnectRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def test_success_emits_protocol_metadata_samples_and_hard_assertion(self) -> None:
        clocks = iter([0, 1_500_000, 2_000_000, 5_000_000])
        adapters: list[FakeAdapter] = []

        def create() -> FakeAdapter:
            adapter = FakeAdapter()
            adapters.append(adapter)
            return adapter

        result = await run_connect_samples(create, runs=2, clock_ns=lambda: next(clocks))

        self.assertTrue(result.passed)
        self.assertEqual(result.records[0]["type"], "metadata")
        self.assertEqual(result.records[0]["candidate"], CANDIDATE)
        self.assertEqual([row["value"] for row in result.records if row["type"] == "sample"], [1.5, 3.0])
        self.assertEqual(result.records[-1], {
            "type": "assertion",
            "candidate": CANDIDATE,
            "scenario": SCENARIO,
            "name": "all_iterations_passed",
            "passed": True,
            "hardGate": True,
        })
        self.assertEqual([(item.connect_calls, item.disconnect_calls) for item in adapters], [(1, 1), (1, 1)])

    async def test_failure_is_hard_assertion_without_raw_error(self) -> None:
        raw = TelegramAdapterError("FLOOD_WAIT", retryable=True, message="secret detail must not escape")
        result = await run_connect_samples(lambda: FakeAdapter(fail=raw), runs=1, clock_ns=lambda: 0)

        self.assertFalse(result.passed)
        failure = result.records[-1]
        self.assertEqual(failure["code"], "FLOOD_WAIT")
        self.assertFalse(failure["passed"])
        self.assertTrue(failure["hardGate"])
        self.assertNotIn("secret detail", str(failure))

    async def test_invalid_run_count_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            await run_connect_samples(FakeAdapter, runs=0)


if __name__ == "__main__":
    unittest.main()
