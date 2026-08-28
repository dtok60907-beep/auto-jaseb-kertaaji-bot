"""Thin, testable lifecycle adapter around Telethon.

This is benchmark infrastructure only. It deliberately owns no durable jobs,
database access, OTP flow, or production session storage.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Protocol


class AdapterState(StrEnum):
    NEW = "NEW"
    CONNECTING = "CONNECTING"
    READY = "READY"
    DISCONNECTING = "DISCONNECTING"
    DISCONNECTED = "DISCONNECTED"
    FAILED = "FAILED"


@dataclass(frozen=True, repr=False)
class SessionConfig:
    """Input for a live test session. repr intentionally hides all fields."""

    api_id: int
    api_hash: str
    session: str

    def __post_init__(self) -> None:
        if not isinstance(self.api_id, int) or self.api_id <= 0:
            raise ValueError("api_id must be a positive integer")
        if not self.api_hash.strip():
            raise ValueError("api_hash is required")
        if not self.session.strip():
            raise ValueError("session is required")

    def __repr__(self) -> str:
        return "SessionConfig(redacted=True)"


class ClientProtocol(Protocol):
    async def connect(self) -> Any: ...

    async def disconnect(self) -> Any: ...

    async def is_user_authorized(self) -> bool: ...

    async def get_entity(self, entity: Any) -> Any: ...

    async def __call__(self, request: Any) -> Any: ...

    async def send_message(self, entity: Any, message: str, **kwargs: Any) -> Any: ...

    def add_event_handler(self, callback: Callable[[Any], Awaitable[None]], event: Any = None) -> Any: ...


class TelegramAdapterError(RuntimeError):
    """Stable engine-facing error. Original exception is retained but never serialized."""

    def __init__(
        self,
        code: str,
        *,
        retryable: bool,
        message: str,
        retry_after_seconds: int | None = None,
        cause: Exception | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.retry_after_seconds = retry_after_seconds
        self.__cause__ = cause

    def public_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "retryable": self.retryable,
            "retryAfterSeconds": self.retry_after_seconds,
        }


def _class_names(error: Exception) -> set[str]:
    return {item.__name__ for item in type(error).__mro__}


def _positive_seconds(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        seconds = int(value)  # Telethon exposes FloodWaitError.seconds.
    except (TypeError, ValueError):
        return None
    return seconds if seconds > 0 else None


def map_telegram_error(error: Exception) -> TelegramAdapterError:
    """Map library-specific errors to the stable benchmark error contract."""

    if isinstance(error, TelegramAdapterError):
        return error

    names = _class_names(error)
    if "FloodWaitError" in names:
        return TelegramAdapterError(
            "FLOOD_WAIT",
            retryable=True,
            message="Telegram meminta jeda sebelum aksi berikutnya.",
            retry_after_seconds=_positive_seconds(getattr(error, "seconds", None)),
            cause=error,
        )
    if names & {
        "AuthKeyUnregisteredError",
        "SessionRevokedError",
        "SessionExpiredError",
        "UserDeactivatedError",
        "UserDeactivatedBanError",
    }:
        return TelegramAdapterError(
            "SESSION_REVOKED",
            retryable=False,
            message="Sesi Telegram tidak lagi valid dan perlu dihubungkan ulang.",
            cause=error,
        )
    if "AuthKeyDuplicatedError" in names:
        return TelegramAdapterError(
            "SESSION_CONFLICT",
            retryable=False,
            message="Sesi Telegram terdeteksi dipakai di runtime lain.",
            cause=error,
        )
    if names & {"ChatWriteForbiddenError", "UserBannedInChannelError", "ChannelPrivateError"}:
        return TelegramAdapterError(
            "CHAT_WRITE_FORBIDDEN",
            retryable=False,
            message="Akun tidak diizinkan menulis di target ini.",
            cause=error,
        )
    if names & {"UsernameNotOccupiedError", "ChannelInvalidError", "PeerIdInvalidError"}:
        return TelegramAdapterError(
            "TARGET_NOT_FOUND",
            retryable=False,
            message="Target Telegram tidak ditemukan atau tidak valid.",
            cause=error,
        )
    if "InviteRequestSentError" in names:
        return TelegramAdapterError(
            "JOIN_APPROVAL_REQUIRED",
            retryable=False,
            message="Permintaan join sudah dikirim dan menunggu persetujuan admin grup.",
            cause=error,
        )
    if "RPCError" in names or isinstance(error, (TimeoutError, ConnectionError, OSError)):
        return TelegramAdapterError(
            "TELEGRAM_TRANSIENT",
            retryable=True,
            message="Koneksi Telegram sementara bermasalah. Sistem dapat mencoba lagi.",
            cause=error,
        )
    return TelegramAdapterError(
        "TELEGRAM_UNKNOWN",
        retryable=False,
        message="Aksi Telegram gagal dengan alasan yang belum diklasifikasikan.",
        cause=error,
    )


MessageHandler = Callable[[Any], Awaitable[None]]


def _default_join_request(entity: Any) -> Any:
    from telethon.tl.functions.channels import JoinChannelRequest

    return JoinChannelRequest(entity)


class TelethonAdapter:
    """Serializes lifecycle and send calls around one Telethon client session."""

    def __init__(
        self,
        client: ClientProtocol,
        *,
        new_message_event: Any = None,
        join_request_factory: Callable[[Any], Any] = _default_join_request,
    ) -> None:
        self._client = client
        self._new_message_event = new_message_event
        self._join_request_factory = join_request_factory
        self._state = AdapterState.NEW
        self._lock = asyncio.Lock()

    @property
    def state(self) -> AdapterState:
        return self._state

    def describe(self) -> dict[str, str]:
        """Safe diagnostics only; never include phone/session/API hash."""

        return {"candidate": "telethon", "state": self._state.value}

    async def connect(self) -> None:
        async with self._lock:
            if self._state is AdapterState.READY:
                return
            self._state = AdapterState.CONNECTING
            try:
                await self._client.connect()
                if not await self._client.is_user_authorized():
                    raise TelegramAdapterError(
                        "SESSION_NOT_AUTHORIZED",
                        retryable=False,
                        message="Session benchmark belum terautentikasi.",
                    )
            except asyncio.CancelledError:
                # Connection state is ambiguous after cancellation; do not allow sends.
                self._state = AdapterState.FAILED
                raise
            except Exception as error:
                self._state = AdapterState.FAILED
                raise map_telegram_error(error) from error
            self._state = AdapterState.READY

    async def disconnect(self) -> None:
        async with self._lock:
            if self._state in {AdapterState.NEW, AdapterState.DISCONNECTED}:
                self._state = AdapterState.DISCONNECTED
                return
            self._state = AdapterState.DISCONNECTING
            try:
                await self._client.disconnect()
            except asyncio.CancelledError:
                # We cannot prove whether transport cleanup completed.
                self._state = AdapterState.FAILED
                raise
            except Exception as error:
                self._state = AdapterState.FAILED
                raise map_telegram_error(error) from error
            self._state = AdapterState.DISCONNECTED

    async def send_message(self, target: Any, text: str, **kwargs: Any) -> Any:
        if not isinstance(text, str) or not text.strip():
            raise ValueError("text is required")
        async with self._lock:
            if self._state is not AdapterState.READY:
                raise TelegramAdapterError(
                    "ADAPTER_NOT_READY",
                    retryable=True,
                    message="Koneksi Telegram belum siap.",
                )
            try:
                return await self._client.send_message(target, text, **kwargs)
            except asyncio.CancelledError:
                # A cancelled send has ambiguous external side effects; engine must reconcile.
                self._state = AdapterState.FAILED
                raise
            except Exception as error:
                raise map_telegram_error(error) from error

    async def resolve_target(self, target: str) -> dict[str, str]:
        if not isinstance(target, str) or not target.strip():
            raise ValueError("target is required")
        async with self._lock:
            if self._state is not AdapterState.READY:
                raise TelegramAdapterError(
                    "ADAPTER_NOT_READY",
                    retryable=True,
                    message="Koneksi Telegram belum siap.",
                )
            try:
                entity = await self._client.get_entity(target)
            except asyncio.CancelledError:
                self._state = AdapterState.FAILED
                raise
            except Exception as error:
                raise map_telegram_error(error) from error
        return {"entityType": type(entity).__name__}

    async def join_public_target(self, target: str) -> dict[str, str]:
        if not isinstance(target, str) or not target.strip():
            raise ValueError("target is required")
        async with self._lock:
            if self._state is not AdapterState.READY:
                raise TelegramAdapterError(
                    "ADAPTER_NOT_READY",
                    retryable=True,
                    message="Koneksi Telegram belum siap.",
                )
            try:
                entity = await self._client.get_entity(target)
                await self._client(self._join_request_factory(entity))
                return {"state": "JOINED"}
            except asyncio.CancelledError:
                self._state = AdapterState.FAILED
                raise
            except Exception as error:
                if "UserAlreadyParticipantError" in _class_names(error):
                    return {"state": "ALREADY_MEMBER"}
                raise map_telegram_error(error) from error

    def add_new_message_handler(self, handler: MessageHandler) -> Callable[[Any], Awaitable[None]]:
        """Register one async handler without exposing the raw session/client."""

        if not callable(handler):
            raise TypeError("handler must be callable")

        async def bridge(event: Any) -> None:
            await handler(event)

        if self._new_message_event is None:
            self._client.add_event_handler(bridge)
        else:
            self._client.add_event_handler(bridge, self._new_message_event)
        return bridge


def create_telethon_adapter(config: SessionConfig) -> TelethonAdapter:
    """Build a real Telethon client only when a live benchmark is explicitly run."""

    try:
        from telethon import TelegramClient, events
        from telethon.sessions import StringSession
    except ImportError as error:  # pragma: no cover - depends on optional live dependency.
        raise RuntimeError("Telethon belum diinstal. Install dependency pinned sebelum live smoke test.") from error

    client = TelegramClient(
        StringSession(config.session),
        config.api_id,
        config.api_hash,
        connection_retries=5,
        request_retries=2,
        sequential_updates=True,
    )
    # Do not silently sleep inside the library. Engine policy records/retries this state.
    client.flood_sleep_threshold = 0
    return TelethonAdapter(client, new_message_event=events.NewMessage())
