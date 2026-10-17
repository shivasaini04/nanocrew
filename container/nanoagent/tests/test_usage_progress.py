"""The per-call usage event carries everything the orchestrator prices a cycle from.

Since 2026-10-01 the orchestrator writes a running cycle's cost into its row after every
model call (src/agents/live-spend.ts) — the only record of spend a cycle that dies before
its final result block ever leaves, and what a daily budget is checked against mid-run.
That event used to carry token totals only, so the provider's own billed figure and the
cache split never reached it: a cycle on OpenRouter would have been priced from the
table, and a DeepSeek cycle as if nothing had hit the cache.
"""
import json
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

import nanoagent.agent.loop as loop_mod  # noqa: E402
from nanoagent.agent.loop import AgentLoop  # noqa: E402
from nanoagent.bus.queue import MessageBus  # noqa: E402
from nanoagent.providers.base import LLMProvider, LLMResponse  # noqa: E402


class OneReply(LLMProvider):
    def __init__(self, usage):
        super().__init__(api_key="test")
        self._usage = usage

    def get_default_model(self) -> str:
        return "scripted/test-model"

    async def chat(self, messages, tools=None, model=None, temperature=0.1,
                   max_tokens=4096, on_token=None, **kwargs):
        return LLMResponse(content="Done.", finish_reason="stop", usage=dict(self._usage))


async def test_usage_event_carries_cost_fields(monkeypatch, capsys):
    monkeypatch.setattr(loop_mod, "_PROGRESS_ACTIVE", True)
    usage = {
        "prompt_tokens": 1200, "completion_tokens": 80, "total_tokens": 1280,
        "prompt_cache_hit_tokens": 1000, "prompt_cache_miss_tokens": 200,
        "reported_cost_usd": 0.0042,
        "reported_cost_prompt_tokens": 1200, "reported_cost_completion_tokens": 80,
    }
    loop = AgentLoop(bus=MessageBus(), provider=OneReply(usage), workspace=Path(tempfile.mkdtemp()))
    await loop._run_agent_loop([{"role": "user", "content": "hi"}], session_key="probe")

    events = [
        json.loads(line[len("NANOBOT_PROGRESS:"):])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("NANOBOT_PROGRESS:")
    ]
    usage_events = [e for e in events if e.get("type") == "usage"]
    assert usage_events, "no usage event was emitted"
    last = usage_events[-1]
    # What the dashboard's live token counter reads.
    assert last["total_tokens"] == 1280
    # What the orchestrator prices the running cycle from.
    assert last["reported_cost_usd"] == pytest.approx(0.0042)
    assert last["reported_cost_prompt_tokens"] == 1200
    assert last["reported_cost_completion_tokens"] == 80
    assert last["prompt_cache_hit_tokens"] == 1000
    assert last["prompt_tokens"] == 1200
    assert last["completion_tokens"] == 80


async def test_a_long_tool_call_beats_then_goes_quiet_at_the_cap(monkeypatch, capsys):
    """Proof of life while one tool call runs (the liveness watchdog ends a silent cycle),
    stopping at the cap so a call that truly hangs still goes silent and is ended."""
    import asyncio
    monkeypatch.setattr(loop_mod, "_PROGRESS_ACTIVE", True)

    async with loop_mod._ToolHeartbeat(every_s=0.02, cap_s=0.1):
        await asyncio.sleep(0.3)

    beats = [
        json.loads(line[len("NANOBOT_PROGRESS:"):])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("NANOBOT_PROGRESS:")
    ]
    assert 2 <= len(beats) <= 6, beats  # beat while under the cap, then nothing
    assert all(b["type"] == "heartbeat" and "tool" not in b for b in beats)


async def test_heartbeat_stops_when_the_tool_returns(monkeypatch, capsys):
    import asyncio
    monkeypatch.setattr(loop_mod, "_PROGRESS_ACTIVE", True)
    async with loop_mod._ToolHeartbeat(every_s=0.02, cap_s=10):
        await asyncio.sleep(0.05)
    capsys.readouterr()
    await asyncio.sleep(0.1)
    assert "NANOBOT_PROGRESS" not in capsys.readouterr().out
