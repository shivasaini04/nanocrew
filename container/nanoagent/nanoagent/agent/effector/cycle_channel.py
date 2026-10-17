"""The cycle's end of the bidirectional channel to the orchestrator (phase 5.2).

The container has no inbound network path, so it dials out once and keeps the socket:
frames go up it, and — from phase 5.3 — human input comes down it.

**It is never load-bearing.** A frame is a nice-to-have view of a run, and a run must
never fail because nobody was watching it. Every failure here is swallowed at debug and
the caller falls back to the HTTP frame route, which is why `send_frame` reports whether
it delivered rather than raising.

Auth is the per-cycle token in a header, never the query string — `extractCycleToken`
(TS side) makes that rule explicit, because query strings land in access and proxy logs.
The token names both the agent and the cycle, so this end presents one secret and claims
nothing beside it.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Awaitable, Callable

from loguru import logger

# How long to wait for the handshake. Short: the channel is an optimisation, and a run
# must not spend meaningful time discovering that nobody is home.
_CONNECT_TIMEOUT_S = 5.0
# Backoff between reconnect attempts after the socket drops mid-run.
_RECONNECT_DELAY_S = 3.0


def _ws_url(host: str) -> str:
    """`https://host` → `wss://host/api/cycle-channel/ws` (and http → ws)."""
    base = host.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + "/api/cycle-channel/ws"
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + "/api/cycle-channel/ws"
    return "ws://" + base + "/api/cycle-channel/ws"


class CycleChannel:
    """One socket, opened lazily, reconnected on drop, silent on failure."""

    def __init__(self, host: str, token: str):
        self._url = _ws_url(host)
        self._token = token
        self._ws: Any = None
        self._lock = asyncio.Lock()
        self._reader: asyncio.Task | None = None
        self._closed = False
        # Set by the owner to receive inbound messages (phase 5.3 wires input here).
        self.on_message: Callable[[dict], Awaitable[None]] | None = None

    @classmethod
    def from_env(cls) -> "CycleChannel | None":
        """Build from the cycle's environment, or None when this is not a real cycle.

        Same contract as RemoteConfig.from_env: absent configuration is the ordinary
        case (a dev run, a test), not an error.
        """
        host = os.environ.get("NanoCrew_HOST")
        token = os.environ.get("NANOCREW_CYCLE_TOKEN")
        if not host or not token:
            return None
        return cls(host, token)

    async def _ensure(self) -> Any:
        """Connect if not already connected. None when it could not be established."""
        if self._closed:
            return None
        if self._ws is not None:
            return self._ws
        async with self._lock:
            if self._ws is not None or self._closed:
                return self._ws
            try:
                import websockets
            except ImportError:
                logger.debug("cycle channel: websockets is not installed — staying on HTTP")
                self._closed = True
                return None
            try:
                self._ws = await asyncio.wait_for(
                    websockets.connect(
                        self._url,
                        additional_headers={"X-Cycle-Token": self._token},
                        max_size=None,  # a frame is a whole-page JPEG data URL
                        open_timeout=_CONNECT_TIMEOUT_S,
                    ),
                    timeout=_CONNECT_TIMEOUT_S,
                )
            except Exception as err:  # noqa: BLE001
                logger.debug(f"cycle channel: could not connect ({err}) — staying on HTTP")
                self._ws = None
                return None
            logger.info("cycle channel: connected")
            self._reader = asyncio.create_task(self._read_loop())
            return self._ws

    async def _read_loop(self) -> None:
        """Deliver inbound messages to `on_message`. Ends when the socket does."""
        ws = self._ws
        if ws is None:
            return
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except Exception:  # noqa: BLE001
                    logger.debug("cycle channel: unparseable inbound message")
                    continue
                handler = self.on_message
                if handler is None:
                    continue
                try:
                    await handler(msg)
                except Exception as err:  # noqa: BLE001
                    # A bad handler must not close the channel the rest of the run needs.
                    logger.debug(f"cycle channel: handler raised — {err}")
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            logger.debug(f"cycle channel: read loop ended — {err}")
        finally:
            # Drop the socket so the next send reconnects rather than writing into a
            # closed one forever.
            self._ws = None

    async def send_json(self, message: dict) -> bool:
        """Send one message up the channel. False when it did not go.

        Never raises: every caller here is doing something optional (shipping a frame,
        announcing a takeover) and none of them should be able to fail a run.
        """
        ws = await self._ensure()
        if ws is None:
            return False
        try:
            await ws.send(json.dumps(message))
            return True
        except Exception as err:  # noqa: BLE001
            logger.debug(f"cycle channel: send failed ({err}) — dropping the socket")
            self._ws = None
            return False

    async def send_frame(self, data_url: str, url: str = "", title: str = "") -> bool:
        """True if the frame went up the channel. False means the caller should fall back."""
        return await self.send_json(
            {"t": "frame", "dataUrl": data_url, "url": url, "title": title}
        )

    async def close(self) -> None:
        self._closed = True
        reader, self._reader = self._reader, None
        if reader is not None:
            reader.cancel()
            try:
                await reader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        ws, self._ws = self._ws, None
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass


# ─── the per-cycle singleton ─────────────────────────────────────────────────

_current: CycleChannel | None = None
_current_token: str | None = None


async def current_channel() -> CycleChannel | None:
    """The channel for the cycle running right now, or None outside one.

    Keyed on the cycle token, not merely cached, because a warm daemon serves several
    cycles over its life and each gets a fresh one (`cycle-token.ts` mints per cycle and
    revokes at the end). A plain module-level singleton would carry cycle A's socket —
    and its now-revoked token — into cycle B, which is the exact shape of bug this repo
    keeps paying for with warm daemons. When the token changes, the old channel is closed
    and a new one takes its place.
    """
    global _current, _current_token

    token = os.environ.get("NANOCREW_CYCLE_TOKEN")
    if not token:
        # Not inside a real cycle. Drop anything left over from one.
        if _current is not None:
            await _current.close()
            _current, _current_token = None, None
        return None

    if _current is not None and _current_token == token:
        return _current

    if _current is not None:
        await _current.close()
        _current = None

    _current = CycleChannel.from_env()
    _current_token = token if _current is not None else None
    return _current


async def close_current_channel() -> None:
    """Tear down at the end of a cycle. Safe to call when there is nothing open."""
    global _current, _current_token
    channel, _current = _current, None
    _current_token = None
    if channel is not None:
        await channel.close()
