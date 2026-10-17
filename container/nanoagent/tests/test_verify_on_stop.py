"""Verify-on-stop, driven through the real loop.

Stage 42 item #8, wiring cover. ``test_verification.py`` proves the policy in
isolation; this proves the loop actually consults it at the moment the model tries
to finish, spends exactly one extra iteration, and then gets out of the way.

Needs the full agent runtime, so it skips on a bare checkout and runs in the
container — same posture as ``tests/test_truncated_response.py``.
"""
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

from nanoagent.agent.loop import AgentLoop  # noqa: E402
from nanoagent.bus.queue import MessageBus  # noqa: E402
from nanoagent.providers.base import LLMProvider, LLMResponse, ToolCallRequest  # noqa: E402


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


def write_call(path, body="x = 1", cid="c1"):
    return ToolCallRequest(
        id=cid, name="write_file", arguments={"path": path, "content": body}
    )


async def run_turn(responses):
    ws = Path(tempfile.mkdtemp())
    loop = AgentLoop(bus=MessageBus(), provider=ScriptedProvider(responses), workspace=ws)
    final, _tools, messages, _usage, _record = await loop._run_agent_loop(
        [{"role": "user", "content": "Add a constant."}], session_key="probe"
    )
    return final, messages, loop.provider


def nudge_count(messages):
    return sum(
        1 for m in messages
        if m.get("role") == "user" and "Before you finish" in str(m.get("content") or "")
    )


async def test_finishing_right_after_a_code_edit_is_nudged_once():
    final, messages, provider = await run_turn([
        LLMResponse(content=None, tool_calls=[write_call("mod.py")]),
        LLMResponse(content="Done, it works."),          # tries to stop, unverified
        LLMResponse(content="Ran the tests: 3 passed."),  # answers after the nudge
    ])

    assert nudge_count(messages) == 1
    assert "mod.py" in str(messages)
    assert final == "Ran the tests: 3 passed."
    assert len(provider.seen) == 3, "exactly one extra round trip"


async def test_the_nudge_never_fires_twice():
    """Bounded follow-up, not a standoff: if it stops again, that answer stands."""
    final, messages, provider = await run_turn([
        LLMResponse(content=None, tool_calls=[write_call("mod.py")]),
        LLMResponse(content="Done."),
        LLMResponse(content="Still done, I cannot run tests here."),
    ])

    assert nudge_count(messages) == 1
    assert final == "Still done, I cannot run tests here."


async def test_a_doc_only_turn_finishes_immediately():
    final, messages, provider = await run_turn([
        LLMResponse(content=None, tool_calls=[write_call("NOTES.md", "# notes")]),
        LLMResponse(content="Updated the notes."),
    ])

    assert nudge_count(messages) == 0
    assert final == "Updated the notes."
    assert len(provider.seen) == 2


async def test_a_turn_with_no_edits_finishes_immediately():
    final, messages, provider = await run_turn([LLMResponse(content="Nothing to change.")])

    assert nudge_count(messages) == 0
    assert final == "Nothing to change."
    assert len(provider.seen) == 1
