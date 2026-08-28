from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import TelegramAdapterError
from behavior_resolve_targets import SCENARIO, run_resolve_targets


class FakeAdapter:
    def __init__(self, *, error: Exception | None = None) -> None:
        self.error = error
        self.connected = False
        self.disconnected = False

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnected = True

    async def resolve_target(self, target: str) -> dict[str, str]:
        if self.error:
            raise self.error
        return {"entityType": "Channel"}


class ResolveTargetsRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def test_success_emits_safe_assertions_without_raw_targets(self) -> None:
        clocks = iter([0, 1_000_000, 2_000_000, 4_000_000, 7_000_000, 10_000_000])
        adapter = FakeAdapter()
        result = await run_resolve_targets(
            lambda: adapter,
            {
                "public_group": "@public",
                "approval_group": "@approval",
                "discussion_channel": "@discussion",
            },
            clock_ns=lambda: next(clocks),
        )

        self.assertTrue(result.passed)
        self.assertTrue(adapter.connected)
        self.assertTrue(adapter.disconnected)
        self.assertEqual(result.records[0]["type"], "metadata")
        self.assertEqual(result.records[-1]["name"], "all_targets_resolved")
        self.assertEqual(result.records[-1]["passed"], True)
        self.assertEqual(
            [item["name"] for item in result.records if item["type"] == "assertion" and "targetRole" in item],
            ["public_group_resolved", "approval_group_resolved", "discussion_channel_resolved"],
        )
        self.assertNotIn("@public", str(result.records))
        self.assertEqual({item["scenario"] for item in result.records[1:]}, {SCENARIO})

    async def test_failure_is_hard_gate_without_raw_error(self) -> None:
        raw = TelegramAdapterError("TARGET_NOT_FOUND", retryable=False, message="raw target detail")
        result = await run_resolve_targets(
            lambda: FakeAdapter(error=raw),
            {
                "public_group": "@public",
                "approval_group": "@approval",
                "discussion_channel": "@discussion",
            },
            clock_ns=lambda: 0,
        )

        self.assertFalse(result.passed)
        self.assertEqual(result.records[-1]["code"], "TARGET_NOT_FOUND")
        self.assertTrue(result.records[-1]["hardGate"])
        self.assertNotIn("raw target detail", str(result.records))


if __name__ == "__main__":
    unittest.main()
