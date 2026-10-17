"""Mid-run steering, one level up from where it used to stop.

stage45 item 5 built a mailbox for a note to reach a running agent: the dashboard drops
one in, the run drains it at its next turn boundary. That boundary only ever existed
inside effector's own turn loop. The DECISION that actually goes wrong first — what to
search for, where to navigate — is made by the outer loop, which never polled the
mailbox at all.

Measured live 2026-09-22: the owner asked to play "Sammi Meri Waar srivas" (a typo — the
song is just "Sammi Meri Waar"), realised it mid-cycle, and had nowhere to say so. By the
time effector started, the bad search was already the page on screen.

Two things matter here: the poll must happen at the SAME place `_check_interrupt` already
polls (so a note is never more than one iteration stale), and a note must become part of
`messages` — the real, growing conversation — not a value that has to be hand-carried and
re-shown the way effector's stateless per-turn prompt needs.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

from nanoagent.agent.loop import AgentLoop  # noqa: E402
from nanoagent.bus.queue import MessageBus  # noqa: E402
from nanoagent.providers.base import LLMProvider, LLMResponse  # noqa: E402

_ENV = {
    "AGENT_ID": "agent-abc",
    "CYCLE_ID": "cycle-xyz",
    "NanoCrew_HOST": "http://host.docker.internal:3002",
    "NANOCREW_CYCLE_TOKEN": "tok-123",
}


@pytest.fixture
def env(monkeypatch):
    for k, v in _ENV.items():
        monkeypatch.setenv(k, v)


class _UnusedProvider(LLMProvider):
    """Never actually called by these tests — just needs to satisfy AgentLoop's ctor."""

    def get_default_model(self) -> str:
        return "unused/test-model"

    async def chat(self, *a, **k):
        raise AssertionError("provider.chat should not be called in these tests")


def _loop() -> AgentLoop:
    return AgentLoop(
        bus=MessageBus(),
        provider=_UnusedProvider(api_key="test"),
        workspace=Path(tempfile.mkdtemp()),
    )


# ───────────────────────────────────────────────────────────── the fetch itself


async def test_no_env_no_call(monkeypatch):
    """Same posture as _check_interrupt: missing wiring is silence, not an error, and
    must not attempt a network call at all."""
    monkeypatch.delenv("CYCLE_ID", raising=False)
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    loop = _loop()
    assert await loop._check_steering() == []


async def test_notes_come_back_from_the_cycle_scoped_route(env, monkeypatch):
    captured = {}

    class FakeResp:
        def json(self):
            return {"notes": ["not srivas, just Sammi Meri Waar"]}

    async def fake_get(url, params=None, headers=None, timeout=None):
        captured["url"] = url
        captured["params"] = params
        captured["headers"] = headers
        return FakeResp()

    fake_client = MagicMock()
    fake_client.get = fake_get
    monkeypatch.setattr(
        "httpx.AsyncClient", lambda: fake_client,
    )

    notes = await _loop()._check_steering()
    assert notes == ["not srivas, just Sammi Meri Waar"]
    assert captured["params"] == {"cycleId": "cycle-xyz"}
    assert captured["headers"]["Authorization"] == "Bearer tok-123"
    assert captured["url"].endswith("/api/agents/agent-abc/self/steer")


async def test_a_malformed_response_is_treated_as_no_notes(env, monkeypatch):
    class FakeResp:
        def json(self):
            return {"not_notes": "garbage"}

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=FakeResp())
    monkeypatch.setattr("httpx.AsyncClient", lambda: fake_client)
    assert await _loop()._check_steering() == []


async def test_an_unreachable_orchestrator_is_silence_not_an_error(env, monkeypatch):
    fake_client = MagicMock()

    async def boom(*a, **k):
        raise ConnectionError("no route")

    fake_client.get = boom
    monkeypatch.setattr("httpx.AsyncClient", lambda: fake_client)
    assert await _loop()._check_steering() == []


async def test_at_most_five_notes(env, monkeypatch):
    class FakeResp:
        def json(self):
            return {"notes": [str(n) for n in range(12)]}

    fake_client = MagicMock()
    fake_client.get = AsyncMock(return_value=FakeResp())
    monkeypatch.setattr("httpx.AsyncClient", lambda: fake_client)
    assert len(await _loop()._check_steering()) == 5


# ─────────────────────────────────────────────────── wired into the real loop


class ScriptedProvider(LLMProvider):
    def __init__(self, responses):
        super().__init__(api_key="test")
        self._responses = list(responses)
        self.seen: list[list[dict]] = []

    def get_default_model(self) -> str:
        return "scripted/test-model"

    async def chat(self, messages, tools=None, model=None, temperature=0.1,
                   max_tokens=4096, on_token=None, **kwargs):
        self.seen.append(list(messages))
        if self._responses:
            return self._responses.pop(0)
        return LLMResponse(content="done", finish_reason="stop")


async def _run_turn(responses, notes_by_call):
    """notes_by_call: list of note-lists, one per _check_steering() call, extra calls
    get []. Mirrors how a note would arrive on turn 2 but not turn 1 or 3."""
    calls = {"n": 0}

    async def fake_check_steering(self):
        i = calls["n"]
        calls["n"] += 1
        return notes_by_call[i] if i < len(notes_by_call) else []

    from nanoagent.agent.loop import AgentLoop as _AL

    orig = _AL._check_steering
    _AL._check_steering = fake_check_steering
    try:
        ws = Path(tempfile.mkdtemp())
        loop = AgentLoop(bus=MessageBus(), provider=ScriptedProvider(responses), workspace=ws)
        final, _tools, messages, _usage, _record = await loop._run_agent_loop(
            [{"role": "user", "content": "play Sammi Meri Waar srivas"}], session_key="probe"
        )
        return final, messages, loop.provider
    finally:
        _AL._check_steering = orig


async def test_a_note_becomes_a_user_message_the_model_actually_sees():
    """The point of the whole change: by the SECOND model call, the correction is in
    the conversation the provider is handed — not queued somewhere that never reaches
    it."""
    final, messages, provider = await _run_turn(
        responses=[
            LLMResponse(content="Searching for it now.", finish_reason="stop"),
            LLMResponse(content="Got it, playing Sammi Meri Waar.", finish_reason="stop"),
        ],
        notes_by_call=[["not srivas, just Sammi Meri Waar"]],
    )
    assert any(
        m.get("role") == "user" and "not srivas" in str(m.get("content") or "")
        for m in messages
    )


async def test_no_note_no_extra_message():
    """The common case — nobody said anything — must add nothing to the conversation."""
    _final, messages, _provider = await _run_turn(
        responses=[LLMResponse(content="Playing it now.", finish_reason="stop")],
        notes_by_call=[[]],
    )
    assert not any(
        "[Note from your owner" in str(m.get("content") or "") for m in messages
    )


async def test_a_note_arrives_before_the_next_decision_not_after():
    """Checked at the SAME boundary as the interrupt flag, before that iteration's own
    provider call — so a note lands no later than the very next decision, not the one
    after that."""
    final, messages, provider = await _run_turn(
        responses=[LLMResponse(content="Playing Sammi Meri Waar.", finish_reason="stop")],
        notes_by_call=[["correction"]],
    )
    assert len(provider.seen) == 1
    assert any("correction" in str(m.get("content") or "") for m in provider.seen[-1])
