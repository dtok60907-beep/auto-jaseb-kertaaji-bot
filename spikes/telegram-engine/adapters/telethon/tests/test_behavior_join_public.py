from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import TelegramAdapterError  # noqa: E402
from behavior_join_public import SCENARIO, run_join_public  # noqa: E402


class FakeAdapter:
    def __init__(self, *, state: str = "JOINED", error: Exception | None = None) -> None:
        self.state = state
        self.error = error
        self.connected = False
        self.disconnected = False

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnected = True

    async def join_public_target(self, target: str) -> dict[str, str]:
        if self.error:
            raise self.error
        return {"state": self.state}


class JoinPublicRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def test_join_success_emits_safe_state_and_disconnects(self) -> None:
        adapter = FakeAdapter(state="JOINED")
        result = await run_join_public(lambda: adapter, "@public", clock_ns=lambda: 1_000_000)

        self.assertTrue(result.passed)
        self.assertTrue(adapter.connected)
        self.assertTrue(adapter.disconnected)
        self.assertEqual(result.records[-1]["name"], "public_join_succeeded")
        self.assertTrue(result.records[-1]["passed"])
        self.assertEqual(result.records[-1]["joinState"], "JOINED")
        self.assertNotIn("@public", str(result.records))
        self.assertEqual({item["scenario"] for item in result.records[1:]}, {SCENARIO})

    async def test_already_member_is_success(self) -> None:
        result = await run_join_public(lambda: FakeAdapter(state="ALREADY_MEMBER"), "@public", clock_ns=lambda: 0)

        self.assertTrue(result.passed)
        self.assertEqual(result.records[-1]["joinState"], "ALREADY_MEMBER")

    async def test_failure_is_hard_gate_without_raw_error(self) -> None:
        raw = TelegramAdapterError("JOIN_APPROVAL_REQUIRED", retryable=False, message="raw target detail")
        result = await run_join_public(lambda: FakeAdapter(error=raw), "@public", clock_ns=lambda: 0)

        self.assertFalse(result.passed)
        self.assertEqual(result.records[-1]["code"], "JOIN_APPROVAL_REQUIRED")
        self.assertTrue(result.records[-1]["hardGate"])
        self.assertNotIn("raw target detail", str(result.records))


if __name__ == "__main__":
    unittest.main()
