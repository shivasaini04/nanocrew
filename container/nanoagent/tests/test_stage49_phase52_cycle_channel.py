"""Phase 5.2 — the cycle's end of the bidirectional channel.

The container has no inbound network path, so it dials out once and keeps the socket.
Frames go up it; from 5.3 human input comes down it. Polling was the alternative and is
wrong for input: steering is per-turn, a mouse is per-event.

What matters most here is that the channel is **never load-bearing**. A frame is a
nice-to-have view of a run, and no run may fail, stall, or lose its live view because
nobody was watching or because the orchestrator was older than the agent.
"""

from __future__ import annotations

import json

import pytest

from nanoagent.agent.effector import cycle_channel as cc
from nanoagent.agent.effector.cycle_channel import CycleChannel, _ws_url


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok-A")
    cc._current = None
    cc._current_token = None


# ─── the url ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("host,expected", [
    ("https://nanocrew.example.com", "wss://nanocrew.example.com/api/cycle-channel/ws"),
    ("http://host.docker.internal:3002", "ws://host.docker.internal:3002/api/cycle-channel/ws"),
    ("https://nanocrew.example.com/", "wss://nanocrew.example.com/api/cycle-channel/ws"),
])
def test_ws_url_follows_the_scheme(host, expected):
    assert _ws_url(host) == expected


# ─── never load-bearing ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_channel_that_cannot_connect_reports_false_rather_than_raising():
    """The caller falls back to the HTTP frame route on False. If this raised, a run
    with no orchestrator socket would lose its live view instead of degrading."""
    channel = CycleChannel("http://nowhere.invalid", "tok")
    assert await channel.send_frame("data:image/jpeg;base64,QUJD") is False


@pytest.mark.asyncio
async def test_a_send_failure_drops_the_socket_so_the_next_one_reconnects():
    channel = CycleChannel("http://orchestrator.test", "tok")

    class DeadSocket:
        async def send(self, _payload):
            raise ConnectionResetError("socket went away mid-run")

    channel._ws = DeadSocket()
    assert await channel.send_frame("data:image/jpeg;base64,QUJD") is False
    assert channel._ws is None, "a dead socket must not be written to forever"


def test_from_env_returns_none_outside_a_cycle(monkeypatch):
    """A dev run or a test is the ordinary case, not an error."""
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    assert CycleChannel.from_env() is None


# ─── what it sends ────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_frame_goes_up_as_one_json_message():
    channel = CycleChannel("http://orchestrator.test", "tok")
    sent: list[str] = []

    class Socket:
        async def send(self, payload):
            sent.append(payload)

    channel._ws = Socket()
    assert await channel.send_frame("data:image/jpeg;base64,QUJD", "https://x.test/a", "A") is True

    assert json.loads(sent[0]) == {
        "t": "frame", "dataUrl": "data:image/jpeg;base64,QUJD",
        "url": "https://x.test/a", "title": "A",
    }


# ─── the warm-daemon trap ─────────────────────────────────────────────────────

def _tracked_channel(closed: list[str]):
    """A channel whose close() is observable, built from the current env token."""
    def factory():
        token = cc.os.environ.get("NANOCREW_CYCLE_TOKEN", "")
        ch = CycleChannel("http://orchestrator.test", token)

        async def close():
            closed.append(token)

        ch.close = close  # type: ignore[assignment]
        return ch
    return factory


@pytest.mark.asyncio
async def test_a_new_cycle_token_replaces_the_channel(monkeypatch):
    """The bug this repo keeps paying for with warm daemons.

    One daemon serves several cycles and each gets a fresh token, revoked when its cycle
    ends. A plain module-level singleton would carry cycle A's socket — and its
    now-revoked token — into cycle B, whose frames would be attributed to a finished
    cycle or refused outright.
    """
    closed: list[str] = []
    monkeypatch.setattr(CycleChannel, "from_env", staticmethod(_tracked_channel(closed)))

    first = await cc.current_channel()
    assert first is not None and first._token == "tok-A"

    # The same cycle asking again gets the same channel, not a socket per frame.
    assert await cc.current_channel() is first

    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok-B")
    second = await cc.current_channel()

    assert second is not first, "a new cycle must not inherit the previous cycle's socket"
    assert second is not None and second._token == "tok-B"
    assert closed == ["tok-A"], "the previous cycle's channel must be closed, not leaked"


@pytest.mark.asyncio
async def test_leaving_a_cycle_closes_the_channel(monkeypatch):
    closed: list[str] = []
    monkeypatch.setattr(CycleChannel, "from_env", staticmethod(_tracked_channel(closed)))

    assert await cc.current_channel() is not None
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)

    assert await cc.current_channel() is None
    assert closed == ["tok-A"]


# ─── inbound ──────────────────────────────────────────────────────────────────

class _ScriptedSocket:
    def __init__(self, messages):
        self._messages = messages

    def __aiter__(self):
        async def gen():
            for m in self._messages:
                yield m
        return gen()


@pytest.mark.asyncio
async def test_inbound_messages_reach_the_handler():
    """Phase 5.3 delivers input through this path."""
    channel = CycleChannel("http://orchestrator.test", "tok")
    seen: list[dict] = []

    async def handler(msg):
        seen.append(msg)

    channel.on_message = handler
    channel._ws = _ScriptedSocket([
        json.dumps({"t": "input", "kind": "mouse", "x": 10, "y": 20}),
        "not json at all",
        json.dumps({"t": "release"}),
    ])
    await channel._read_loop()

    assert seen == [{"t": "input", "kind": "mouse", "x": 10, "y": 20}, {"t": "release"}], \
        "a malformed message must be skipped, not end the channel"


@pytest.mark.asyncio
async def test_a_raising_handler_does_not_kill_the_channel():
    channel = CycleChannel("http://orchestrator.test", "tok")
    seen: list[dict] = []

    async def handler(msg):
        seen.append(msg)
        raise RuntimeError("handler is broken")

    channel.on_message = handler
    channel._ws = _ScriptedSocket([json.dumps({"t": "input"}), json.dumps({"t": "release"})])
    await channel._read_loop()

    assert len(seen) == 2, "the second message must still be delivered"
