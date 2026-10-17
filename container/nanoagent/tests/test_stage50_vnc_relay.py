"""Stage 50 phase 3 — carrying RFB out of a container nothing can connect to.

The relay is a pipe, so the tests are about the two things a pipe can get wrong: what it
lets through, and when it opens and closes.

The one that needs saying out loud is the LATENESS of the RFB session. RFB is stateful
and positional — a connection opens with a version handshake and every byte after that
depends on the ones before. Connecting to x11vnc when the relay starts would begin that
handshake with nobody there, and the first real viewer would arrive mid-conversation and
see garbage. So the session is opened when the orchestrator says a viewer is actually
attached, and closed when they leave, so the next one starts clean.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from nanoagent.agent.effector.vnc_relay import VncRelay, _ws_url


class _FakeWs:
    """The orchestrator end, as far as the relay cares.

    `feed()` is what the orchestrator would send down; `sent` is what went up.
    """

    def __init__(self):
        self.sent: list = []
        self.closed = False
        self._inbox: asyncio.Queue = asyncio.Queue()

    async def send(self, data):
        self.sent.append(data)

    async def close(self):
        self.closed = True
        await self._inbox.put(None)

    def feed(self, message):
        self._inbox.put_nowait(message)

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self._inbox.get()
        if item is None:
            raise StopAsyncIteration
        return item


async def _echo_server():
    """Stands in for x11vnc: says hello like RFB does, then echoes what it is told."""
    got: list = []

    async def handle(reader, writer):
        writer.write(b"RFB 003.008\n")
        await writer.drain()
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            got.append(chunk)
    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1], got


def _relay_with(ws, port) -> VncRelay:
    relay = VncRelay("http://orchestrator.test", "tok", port)
    relay._ws = ws
    relay._pump = asyncio.create_task(relay._from_ws())
    return relay


# ─── where it dials ───────────────────────────────────────────────────────────

def test_the_url_is_its_own_path_not_the_cycle_channels():
    """A separate socket is the whole point: a framebuffer stream on the cycle channel
    would queue ahead of `release` and the interrupt that lets Stop reach a parked run."""
    assert _ws_url("http://host") == "ws://host/api/cycle-vnc/ws"
    assert _ws_url("https://host") == "wss://host/api/cycle-vnc/ws"
    assert _ws_url("https://host/") == "wss://host/api/cycle-vnc/ws"


def test_it_needs_a_real_cycle_to_exist(monkeypatch):
    monkeypatch.delenv("NanoCrew_HOST", raising=False)
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    assert VncRelay.from_env(5900) is None

    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    relay = VncRelay.from_env(5900)
    assert relay is not None and relay._vnc_port == 5900


# ─── the session opens late and closes clean ──────────────────────────────────

@pytest.mark.asyncio
async def test_nothing_touches_x11vnc_until_a_viewer_attaches():
    """The property that keeps the handshake intact."""
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        await asyncio.sleep(0.05)
        assert relay._writer is None, "no viewer, so there must be no RFB session"
        assert ws.sent == [], "and nothing to send upward"
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_attaching_opens_the_session_and_the_handshake_flows_up():
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)

        assert b"".join(ws.sent) == b"RFB 003.008\n"
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_the_viewers_bytes_reach_x11vnc():
    server, port, got = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)
        ws.feed(b"\x00\x01\x02")
        await asyncio.sleep(0.1)

        assert b"".join(got) == b"\x00\x01\x02"
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_detaching_closes_the_session_but_keeps_the_relay():
    """x11vnc keeps running and the relay stays dialled in; only the conversation ends,
    so the next viewer gets a fresh handshake rather than joining a used one."""
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)
        assert relay._writer is not None

        ws.feed(json.dumps({"t": "detach"}))
        await asyncio.sleep(0.1)

        assert relay._writer is None
        assert relay._ws is ws, "the relay itself must stay open for the next viewer"
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_attaching_twice_does_not_leave_two_sessions_open():
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)
        first = relay._writer

        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)

        assert relay._writer is not first, "a re-attach must be a fresh session"
        assert first.is_closing(), "and the old one must not be left open"
    finally:
        await relay.stop()
        server.close()


# ─── bytes with nowhere to go ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_bytes_arriving_with_no_session_are_dropped_not_buffered():
    """They belong to a conversation that has ended. Writing them into the next one
    would corrupt its handshake — the failure would look like a broken screen."""
    server, port, got = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed(b"stale-bytes")
        await asyncio.sleep(0.05)

        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)

        assert b"stale-bytes" not in b"".join(got)
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_an_unparseable_control_message_is_ignored():
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    try:
        ws.feed("not json at all")
        ws.feed(json.dumps({"t": "something-else"}))
        await asyncio.sleep(0.05)

        assert relay._writer is None   # and nothing raised
    finally:
        await relay.stop()
        server.close()


@pytest.mark.asyncio
async def test_an_unreachable_x11vnc_is_survivable():
    """The live view degrades to screenshots; the run carries on."""
    ws = _FakeWs()
    # Nothing is listening on this port.
    relay = _relay_with(ws, 1)
    try:
        ws.feed(json.dumps({"t": "attach"}))
        await asyncio.sleep(0.1)

        assert relay._writer is None
    finally:
        await relay.stop()


# ─── teardown ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stop_closes_everything_and_is_idempotent():
    server, port, _ = await _echo_server()
    ws = _FakeWs()
    relay = _relay_with(ws, port)
    ws.feed(json.dumps({"t": "attach"}))
    await asyncio.sleep(0.1)

    await relay.stop()
    await relay.stop()     # a teardown path may run twice; it must not raise

    assert relay._writer is None
    assert relay._ws is None
    assert ws.closed is True
    server.close()


@pytest.mark.asyncio
async def test_a_stopped_relay_does_not_redial():
    """A warm daemon runs many cycles in one process. A relay whose run has ended must
    stay ended rather than quietly reconnecting on the next thing that touches it."""
    relay = VncRelay("http://orchestrator.test", "tok", 5900)
    await relay.stop()

    assert await relay.start() is False
