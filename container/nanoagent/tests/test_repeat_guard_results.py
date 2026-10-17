"""The repeated-call guard counts a repeat only when the result repeats too.

Live 2026-10-01: a five-step task — run `sleep 840; date -u` five times — was told on the
fourth call that it "called the exact same tool with the exact same arguments 3 times in a
row with no change in outcome", though every call had returned a new time. The agent took
the hint and abandoned the task. Polling a deploy, waiting on a job and paced loops all look
like that. A stuck call returns the same thing every time, and is still caught.
"""
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

from nanoagent.agent.loop import AgentLoop  # noqa: E402
from nanoagent.agent.tools.base import Tool  # noqa: E402
from nanoagent.bus.queue import MessageBus  # noqa: E402
from nanoagent.providers.base import LLMProvider, LLMResponse, ToolCallRequest  # noqa: E402

NUDGE = "exact same arguments"


class Clock(Tool):
    """Same arguments every time; a different answer every time unless frozen. Named `sleep`,
    which the per-run result cache never serves from cache — as with `exec` in the live case."""

    def __init__(self, frozen: bool):
        self.frozen = frozen
        self.calls = 0

    @property
    def name(self) -> str:
        return "sleep"

    @property
    def description(self) -> str:
        return "Wait, then report the time."

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {"wait": {"type": "integer"}}, "required": ["wait"]}

    async def execute(self, **kwargs) -> str:
        self.calls += 1
        return "07:00:00" if self.frozen else f"07:{self.calls:02d}:00"


class Scripted(LLMProvider):
    def __init__(self, responses):
        super().__init__(api_key="test")
        self._responses = list(responses)

    def get_default_model(self) -> str:
        return "scripted/test-model"

    async def chat(self, messages, tools=None, model=None, temperature=0.1, max_tokens=4096, on_token=None, **kwargs):
        if self._responses:
            return self._responses.pop(0)
        return LLMResponse(content="done", finish_reason="stop")


def _same_call(i: int) -> LLMResponse:
    return LLMResponse(content=None, finish_reason="tool_calls",
                       tool_calls=[ToolCallRequest(id=f"c{i}", name="sleep", arguments={"wait": 840})])


async def _run(frozen: bool, n: int):
    loop = AgentLoop(bus=MessageBus(), provider=Scripted([_same_call(i) for i in range(n)]),
                     workspace=Path(tempfile.mkdtemp()))
    clock = Clock(frozen)
    loop.tools.register(clock)
    final, _tools, messages, _usage, _record = await loop._run_agent_loop(
        [{"role": "user", "content": "Report the time five times."}], session_key="probe"
    )
    nudges = [m for m in messages if m.get("role") == "user" and NUDGE in str(m.get("content"))]
    return final, nudges, clock.calls


async def test_a_repeated_call_with_new_results_is_not_a_loop():
    final, nudges, calls = await _run(frozen=False, n=5)
    assert calls == 5
    assert nudges == []
    assert (final or "").strip() == "done"


async def test_a_repeated_call_with_the_same_result_is_still_caught():
    _final, nudges, calls = await _run(frozen=True, n=6)
    assert len(nudges) == 1
    assert calls == 5  # nudged at 3, aborted at 5 — the sixth never runs
