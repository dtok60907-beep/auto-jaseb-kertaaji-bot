"""Explicit live connectivity smoke test for a dedicated Telegram test account.

This command never performs OTP login, sends no message, and prints no session/API hash.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

from adapter import SessionConfig, create_telethon_adapter


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} wajib diisi untuk smoke test akun uji.")
    return value


async def main() -> int:
    try:
        config = SessionConfig(
            api_id=int(required("TELEGRAM_TEST_API_ID")),
            api_hash=required("TELEGRAM_TEST_API_HASH"),
            session=required("TELEGRAM_TEST_SESSION"),
        )
        adapter = create_telethon_adapter(config)
        await adapter.connect()
        result = {"scenario": "connect_authorized_disconnect", "passed": True, **adapter.describe()}
        await adapter.disconnect()
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except Exception as error:
        code = getattr(error, "code", "SMOKE_SETUP_OR_CONNECT_FAILED")
        print(json.dumps({"scenario": "connect_authorized_disconnect", "passed": False, "code": code}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
