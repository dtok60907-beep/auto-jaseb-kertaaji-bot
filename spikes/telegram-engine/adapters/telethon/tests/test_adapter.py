from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import (  # noqa: E402
    AdapterState,
    SessionConfig,
    TelegramAdapterError,
    TelethonAdapter,
    map_telegram_error,
)


class FakeClient:
    def __init__(self) -> None:
        self.authorized = True
        self.connect_calls = 0
        self.disconnect_calls = 0
        self.send_calls: list[tuple[Any, str, dict[str, Any]]] = []
        self.handlers: list[tuple[Any, Any]] = []
        self.connect_error: Exception | None = None
        self.disconnect_error: Exception | None = None
        self.send_error: Exception | None = None
        self.send_gate: asyncio.Event | None = None
        self.send_started: asyncio.Event | None = None
        self.active_sends = 0
        self.max_active_sends = 0

    async def connect(self) -> None:
        self.connect_calls += 1
        if self.connect_error:
            raise self.connect_error

    async def disconnect(self) -> None:
        self.disconnect_calls += 1
        if self.disconnect_error:
            raise self.disconnect_error

    async def is_user_authorized(self) -> bool:
        return self.authorized

    async def send_message(self, target: Any, text: str, **kwargs: Any) -> dict[str, Any]:
        if self.send_error:
            raise self.send_error
        self.active_sends += 1
        self.max_active_sends = max(self.max_active_sends, self.active_sends)
        try:
            if self.send_started:
                self.send_started.set()
            if self.send_gate:
                await self.send_gate.wait()
            self.send_calls.append((target, text, kwargs))
            return {"target": target, "text": text}
        finally:
            self.active_sends -= 1

    def add_event_handler(self, callback: Any, event: Any = None) -> None:
        self.handlers.append((callback, event))


class FloodWaitError(Exception):
    def __init__(self, seconds: int) -> None:
        self.seconds = seconds


class SessionRevokedError(Exception):
    pass


class ChatWriteForbiddenError(Exception):
    pass


class RPCError(Exception):
    pass


class AdapterTest(unittest.IsolatedAsyncioTestCase):
    async def test_connect_is_idempotent_and_authorized(self) -> None:
        client = FakeClient()
        adapter = TelethonAdapter(client)

        await adapter.connect()
        await adapter.connect()

        self.assertEqual(adapter.state, AdapterState.READY)
        self.assertEqual(client.connect_calls, 1)
        self.assertEqual(adapter.describe(), {"candidate": "telethon", "state": "READY"})

    async def test_connect_rejects_unauthorized_session(self) -> None:
        client = FakeClient()
        client.authorized = False
        adapter = TelethonAdapter(client)

        with self.assertRaises(TelegramAdapterError) as caught:
            await adapter.connect()

        self.assertEqual(caught.exception.code, "SESSION_NOT_AUTHORIZED")
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(adapter.state, AdapterState.FAILED)

    async def test_send_requires_ready_and_serializes_successful_send(self) -> None:
        client = FakeClient()
        adapter = TelethonAdapter(client)

        with self.assertRaises(TelegramAdapterError) as caught:
            await adapter.send_message("target", "halo")
        self.assertEqual(caught.exception.code, "ADAPTER_NOT_READY")

        await adapter.connect()
        result = await adapter.send_message("target", "halo", comment_to=42)
        self.assertEqual(result, {"target": "target", "text": "halo"})
        self.assertEqual(client.send_calls, [("target", "halo", {"comment_to": 42})])

    async def test_concurrent_sends_are_serialized_per_session(self) -> None:
        client = FakeClient()
        client.send_gate = asyncio.Event()
        client.send_started = asyncio.Event()
        adapter = TelethonAdapter(client)
        await adapter.connect()

        first = asyncio.create_task(adapter.send_message("target", "pertama"))
        await client.send_started.wait()
        second = asyncio.create_task(adapter.send_message("target", "kedua"))
        await asyncio.sleep(0)
        self.assertEqual(client.max_active_sends, 1)
        client.send_gate.set()
        await asyncio.gather(first, second)

        self.assertEqual(client.max_active_sends, 1)
        self.assertEqual([item[1] for item in client.send_calls], ["pertama", "kedua"])

    async def test_disconnect_is_idempotent(self) -> None:
        client = FakeClient()
        adapter = TelethonAdapter(client)

        await adapter.disconnect()
        await adapter.connect()
        await adapter.disconnect()
        await adapter.disconnect()

        self.assertEqual(adapter.state, AdapterState.DISCONNECTED)
        self.assertEqual(client.disconnect_calls, 1)

    async def test_send_error_is_mapped_without_exposing_raw_error(self) -> None:
        client = FakeClient()
        client.send_error = FloodWaitError(901)
        adapter = TelethonAdapter(client)
        await adapter.connect()

        with self.assertRaises(TelegramAdapterError) as caught:
            await adapter.send_message("target", "halo")

        self.assertEqual(caught.exception.public_dict(), {
            "code": "FLOOD_WAIT",
            "retryable": True,
            "retryAfterSeconds": 901,
        })

    async def test_receive_handler_is_registered_and_awaited(self) -> None:
        client = FakeClient()
        marker: list[Any] = []
        adapter = TelethonAdapter(client, new_message_event="NEW_MESSAGE")

        async def handler(event: Any) -> None:
            marker.append(event)

        bridge = adapter.add_new_message_handler(handler)
        await bridge({"id": 9})

        self.assertEqual(marker, [{"id": 9}])
        self.assertEqual(client.handlers, [(bridge, "NEW_MESSAGE")])

    async def test_cancellation_propagates_and_blocks_future_send(self) -> None:
        client = FakeClient()
        client.connect_error = asyncio.CancelledError()
        adapter = TelethonAdapter(client)

        with self.assertRaises(asyncio.CancelledError):
            await adapter.connect()

        self.assertEqual(adapter.state, AdapterState.FAILED)


class ErrorMappingTest(unittest.TestCase):
    def test_known_errors_have_stable_codes(self) -> None:
        cases = [
            (FloodWaitError(22), "FLOOD_WAIT", True),
            (SessionRevokedError(), "SESSION_REVOKED", False),
            (ChatWriteForbiddenError(), "CHAT_WRITE_FORBIDDEN", False),
            (RPCError(), "TELEGRAM_TRANSIENT", True),
            (RuntimeError("raw provider detail"), "TELEGRAM_UNKNOWN", False),
        ]
        for raw, code, retryable in cases:
            with self.subTest(code=code):
                mapped = map_telegram_error(raw)
                self.assertEqual(mapped.code, code)
                self.assertEqual(mapped.retryable, retryable)
                self.assertNotIn("raw provider detail", str(mapped))

    def test_session_config_is_redacted(self) -> None:
        config = SessionConfig(api_id=1, api_hash="super-secret-hash", session="super-secret-session")

        self.assertEqual(repr(config), "SessionConfig(redacted=True)")
        self.assertNotIn("super-secret", repr(config))
        with self.assertRaises(ValueError):
            SessionConfig(api_id=0, api_hash="x", session="x")


if __name__ == "__main__":
    unittest.main()
