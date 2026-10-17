"""Carry RFB out of a container nothing can connect to (stage 50 phase 3).

x11vnc is listening on 127.0.0.1 inside the container (phase 2) and the person who wants
to watch it is in a browser somewhere else. The container has no inbound network path —
no published ports, nothing listening that the outside world can reach — so the only way
those two ever meet is if the container dials OUT and carries the bytes itself.

That is all this is: a pipe with an authenticated far end.

    x11vnc 127.0.0.1:PORT  <--TCP-->  this  <--WebSocket-->  orchestrator  -->  noVNC

## Why a second socket instead of the cycle channel

`cycle_channel.py` already dials out and is already authenticated, so reusing it looks
free. It is not:

- It carries JSON text; this carries binary, at volume.
- The cycle channel carries `release` and the interrupt that lets Stop reach a parked
  run. Putting a pixel stream on the same socket means those queue behind a
  framebuffer update — the one message that must never be slow, delayed by the one
  stream that is allowed to be.

So: same auth (the per-cycle token, in a header, never the query string), same dial-out
shape, different socket.

## Why the RFB session is opened late

RFB is stateful and one-to-one: a connection begins with a version handshake and every
byte after that is positional. Opening the TCP side at relay startup would start that
handshake with nobody on the other end, and the first real viewer would arrive
mid-conversation.

So the orchestrator says when someone is actually there. Text frames are control
(`attach`/`detach`), binary frames are RFB. A viewer attaching opens a fresh session; a
viewer leaving closes it, so the next one starts clean.

## It is never load-bearing

Same contract as everything else in this package: a live view is a nice-to-have, and a
run must never fail because nobody could watch it. Every failure here is swallowed at
debug and leaves the screenshot path exactly as it was.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from loguru import logger

_CONNECT_TIMEOUT_S = 5.0
# One TCP read. Framebuffer updates are large and bursty; too small a buffer turns one
# update into many WebSocket frames for no benefit.
_READ_CHUNK = 64 * 1024


def _ws_url(host: str) -> str:
    """`https://host` -> `wss://host/api/cycle-vnc/ws` (and http -> ws)."""
    base = host.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + "/api/cycle-vnc/ws"
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + "/api/cycle-vnc/ws"
    return "ws://" + base + "/api/cycle-vnc/ws"


class VncRelay:
    """One outbound socket, and at most one RFB session hanging off it."""

    def __init__(self, host: str, token: str, vnc_port: int):
        self._url = _ws_url(host)
        self._token = token
        self._vnc_port = vnc_port
        self._ws: Any = None
        self._pump: asyncio.Task | None = None
        # The live RFB session, when a viewer is attached.
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._to_ws: asyncio.Task | None = None
        self._closed = False

    @classmethod
    def from_env(cls, vnc_port: int) -> "VncRelay | None":
        """Build from the cycle's environment, or None outside a real cycle."""
        host = os.environ.get("NanoCrew_HOST")
        token = os.environ.get("NANOCREW_CYCLE_TOKEN")
        if not host or not token:
            return None
        return cls(host, token, vnc_port)

    async def start(self) -> bool:
        """Dial out and wait for a viewer. False when the socket could not be opened."""
        if self._closed or self._ws is not None:
            return self._ws is not None
        try:
            import websockets
        except ImportError:
            logger.debug("vnc relay: websockets is not installed")
            return False
        try:
            self._ws = await asyncio.wait_for(
                websockets.connect(
                    self._url,
                    additional_headers={"X-Cycle-Token": self._token},
                    max_size=None,          # framebuffer updates are large
                    open_timeout=_CONNECT_TIMEOUT_S,
                ),
                timeout=_CONNECT_TIMEOUT_S,
            )
        except Exception as err:  # noqa: BLE001
            logger.debug(f"vnc relay: could not connect ({err})")
            self._ws = None
            return False

        logger.info("vnc relay: connected, waiting for a viewer")
        self._pump = asyncio.create_task(self._from_ws())
        return True

    # ── the two directions ───────────────────────────────────────────────────

    async def _from_ws(self) -> None:
        """Orchestrator -> here. Text is control, binary is RFB."""
        ws = self._ws
        if ws is None:
            return
        try:
            async for message in ws:
                if isinstance(message, str):
                    await self._control(message)
                    continue
                writer = self._writer
                if writer is None:
                    # Bytes with no session open. Dropping is correct: they belong to a
                    # conversation that has ended, and writing them into the next one
                    # would corrupt its handshake.
                    continue
                try:
                    writer.write(message)
                    await writer.drain()
                except Exception as err:  # noqa: BLE001
                    logger.debug(f"vnc relay: write to x11vnc failed — {err}")
                    await self._detach()
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            logger.debug(f"vnc relay: socket ended — {err}")
        finally:
            await self._detach()
            self._ws = None

    async def _control(self, raw: str) -> None:
        try:
            kind = json.loads(raw).get("t")
        except Exception:  # noqa: BLE001
            return
        if kind == "attach":
            await self._attach()
        elif kind == "detach":
            await self._detach()

    async def _attach(self) -> None:
        """A viewer arrived: open a fresh RFB session and start pumping it upward."""
        await self._detach()          # never two sessions on one relay
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", self._vnc_port),
                timeout=_CONNECT_TIMEOUT_S,
            )
        except Exception as err:  # noqa: BLE001
            logger.debug(f"vnc relay: could not reach x11vnc — {err}")
            self._reader = self._writer = None
            return
        logger.info("vnc relay: viewer attached")
        self._to_ws = asyncio.create_task(self._to_socket())

    async def _to_socket(self) -> None:
        """x11vnc -> orchestrator, as binary frames."""
        reader, ws = self._reader, self._ws
        if reader is None or ws is None:
            return
        try:
            while True:
                chunk = await reader.read(_READ_CHUNK)
                if not chunk:
                    break             # x11vnc closed the session
                await ws.send(chunk)
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            logger.debug(f"vnc relay: read from x11vnc ended — {err}")

    async def _detach(self) -> None:
        """Close the RFB session, leaving the relay open for the next viewer."""
        task, self._to_ws = self._to_ws, None
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        writer, self._writer = self._writer, None
        self._reader = None
        if writer is not None:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:  # noqa: BLE001
                pass

    async def stop(self) -> None:
        """Tear everything down. Idempotent — it runs on a teardown path."""
        self._closed = True
        # Grab the socket BEFORE cancelling the pump. `_from_ws` clears `self._ws` in
        # its finally, so cancelling first loses the only handle and the socket is never
        # closed — it would then linger into the next cycle on a warm daemon, which is
        # the exact leak this module's docstring warns about. Found by its own test.
        ws, self._ws = self._ws, None
        pump, self._pump = self._pump, None
        if pump is not None:
            pump.cancel()
            try:
                await pump
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        await self._detach()
        if ws is not None:
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass
