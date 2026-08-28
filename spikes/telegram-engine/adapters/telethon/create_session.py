"""Create a Telethon StringSession locally without persisting credentials."""

import asyncio
import os
from getpass import getpass

from telethon import TelegramClient
from telethon.sessions import StringSession


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Missing environment variable: {name}")
    return value


async def main() -> None:
    api_id = required_env("TELEGRAM_TEST_API_ID")
    api_hash = required_env("TELEGRAM_TEST_API_HASH")

    client = TelegramClient(StringSession(), int(api_id), api_hash)
    try:
        await client.start(
            phone=lambda: input("Nomor Telegram (+62...): "),
            code_callback=lambda: input("OTP Telegram: "),
            password=lambda: getpass("Password 2FA: "),
        )
        print("\nSALIN BARIS INI KE spikes/telegram-engine/.env:")
        print("TELETHON_TEST_SESSION=" + client.session.save())
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
