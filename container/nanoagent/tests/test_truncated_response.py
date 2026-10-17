"""A truncated response must not be passed off as a finished answer.

Stage 42 item #9, loop-level cover for the branch that consumes
``LLMResponse.finish_reason``. Every provider sets that field; until stage 42
nothing read it, so a response cut off at ``max_tokens`` was returned as though the
model had stopped because it was done.

Unlike ``test_repetition_guard.py`` (pure, runs anywhere) this drives the real
``AgentLoop`` against a scripted provider, so it needs the full agent runtime —
loguru, litellm and the provider stack. It skips where that isn't installed and
runs inside the container image, same constraint as ``test_context_messages.py``.
"""
import tempfile
from pathlib import Path

import pytest

pytest.importorskip("loguru", reason="needs the full agent runtime (container image)")

from nanoagent.agent.loop import AgentLoop  # noqa: E402
from nanoagent.bus.queue import MessageBus  # noqa: E402
from nanoagent.providers.base import LLMProvider, LLMResponse  # noqa: E402

# 120 identical lines: what a model in an echo loop produces when it burns its
# whole output budget. Long enough to clear the guard's length floor.
REPETITIVE = "Let me verify that once more to be sure.\n" * 120

COHERENT = (
    "Here is the tracker summary. Of the 43 rows pulled this week, 9 carry a named "
    "contact and the remainder fall back to a role address. The LinkedIn keyword bank "
    "is close to exhausted, so the next sweep will lean on YC unless new keywords are "
    "supplied. Two rows failed to sync because their first field was renamed upstream, "
    "and I have left them in place rather than guessing at the mapping. The bounce rate "
    "on guessed role addresses remains higher than on firstname addresses, and"
)


class ScriptedProvider(LLMProvider):
    """Returns pre-baked responses in order."""

    def __init__(self, responses):
        super().__init__(api_key="test")
        self._responses = list(responses)
        self.calls = 0

    def get_default_model(self) -> str:
        return "scripted/test-model"

    async def chat(self, messages, tools=None, model=None, temperature=0.1,
                   max_tokens=4096, on_token=None, **kwargs):
        self.calls += 1
        if self._responses:
            return self._responses.pop(0)
        return LLMResponse(content="(scripted provider exhausted)", finish_reason="stop")


async def run_turn(responses):
    loop = AgentLoop(
        bus=MessageBus(),
        provider=ScriptedProvider(responses),
        workspace=Path(tempfile.mkdtemp()),
    )
    final, _tools, messages, _usage, _record = await loop._run_agent_loop(
        [{"role": "user", "content": "Summarise the tracker."}], session_key="probe"
    )
    return final, messages, loop.provider.calls


async def test_a_repetition_loop_never_reaches_the_user():
    final, messages, calls = await run_turn([
        LLMResponse(content=REPETITIVE, finish_reason="length"),
        LLMResponse(content="I got stuck repeating myself and did not finish.",
                    finish_reason="stop"),
    ])

    assert "Let me verify that once more" not in (final or "")
    assert calls == 2, "the grace call should have supplied the answer instead"


async def test_the_discarded_response_never_enters_history():
    """The cost half: history is resent on every later iteration of the turn."""
    _final, messages, _calls = await run_turn([
        LLMResponse(content=REPETITIVE, finish_reason="length"),
        LLMResponse(content="recovered", finish_reason="stop"),
    ])

    assistant_text = "".join(
        str(m.get("content") or "") for m in messages if m.get("role") == "assistant"
    )
    assert "Let me verify that once more" not in assistant_text


async def test_a_coherent_truncation_is_kept_but_marked_once_continuing_is_used_up():
    final, _messages, calls = await run_turn(
        [LLMResponse(content=COHERENT, finish_reason="length")] * 5
    )

    assert calls == 5, "cut off four more times after being told — then handed back"
    assert COHERENT[:60] in final, "the real content must survive"
    assert "cut off at the 4096-token" in final


async def test_a_reply_that_ran_out_of_room_before_acting_is_continued():
    """Measured 2026-09-29: a reasoning model spent its whole 8,192-token budget thinking
    on the first call, wrote nothing, called no tool — and the turn ended there."""
    final, messages, calls = await run_turn([
        LLMResponse(content="", finish_reason="length"),
        LLMResponse(content="Done: the summary is in report.md.", finish_reason="stop"),
    ])

    assert calls == 2
    assert final.strip() == "Done: the summary is in report.md."
    told = [m for m in messages if m.get("role") == "user" and "output limit" in str(m.get("content"))]
    assert told and "whole reply thinking" in told[0]["content"]


async def test_partial_text_stays_in_history_when_continued():
    final, messages, calls = await run_turn([
        LLMResponse(content=COHERENT, finish_reason="length"),
        LLMResponse(content="finished", finish_reason="stop"),
    ])

    assert calls == 2 and final.strip() == "finished"
    assistant_text = "".join(str(m.get("content") or "") for m in messages if m.get("role") == "assistant")
    assert COHERENT[:60] in assistant_text


async def test_a_normal_response_is_untouched():
    final, _messages, calls = await run_turn(
        [LLMResponse(content=COHERENT, finish_reason="stop")]
    )

    assert final.strip() == COHERENT.strip()
    assert calls == 1, "no grace call for a healthy turn"


async def test_repetitive_but_complete_output_is_still_delivered():
    """The guard is gated on truncation, not on content alone — a model that
    repeats itself and then stops normally has still said its piece."""
    final, _messages, _calls = await run_turn(
        [LLMResponse(content=REPETITIVE, finish_reason="stop")]
    )

    assert final.strip() == REPETITIVE.strip()


async def test_a_caller_can_ask_once_for_what_finishing_needs():
    """Stage 57 workers: stopping without report_result gets one nudge, then the turn ends."""
    loop = AgentLoop(bus=MessageBus(), provider=ScriptedProvider([
        LLMResponse(content="Plan: I will now write the module.", finish_reason="stop"),
        LLMResponse(content="Still just talking.", finish_reason="stop"),
    ]), workspace=Path(tempfile.mkdtemp()))
    asked = []
    loop.stop_check = lambda: (asked.append(1) or "[System: call report_result]")
    final, _tools, messages, _usage, _record = await loop._run_agent_loop(
        [{"role": "user", "content": "Do the task."}], session_key="probe"
    )
    assert len(asked) == 1, "asked once, never in a loop"
    assert loop.provider.calls == 2
    assert final.strip() == "Still just talking."
    assert any(m.get("role") == "user" and "report_result" in str(m.get("content")) for m in messages)


async def test_no_stop_check_means_no_extra_call():
    final, _messages, calls = await run_turn([LLMResponse(content=COHERENT, finish_reason="stop")])
    assert calls == 1


async def test_an_empty_reply_is_continued_not_summarised():
    """Measured 2026-09-29 (docs 20): an empty reply went straight to the grace call's
    "final summary", and the agent reported that no work had been done — on turn two."""
    final, messages, calls = await run_turn([
        LLMResponse(content="", finish_reason="stop"),
        LLMResponse(content="The tracker has 43 rows.", finish_reason="stop"),
    ])
    assert calls == 2
    assert final.strip() == "The tracker has 43 rows."
    told = [m for m in messages if m.get("role") == "user" and "reply was empty" in str(m.get("content"))]
    assert len(told) == 1


async def test_empty_replies_still_reach_the_grace_call_in_the_end():
    final, _messages, calls = await run_turn([
        LLMResponse(content="", finish_reason="stop"),
        LLMResponse(content="", finish_reason="stop"),
        LLMResponse(content="", finish_reason="stop"),
        LLMResponse(content="Summary: nothing was done; the request needs a file I cannot see.", finish_reason="stop"),
    ])
    assert calls == 4, "two continues, then the grace call"
    assert "nothing was done" in final


async def test_a_tool_call_cut_off_at_the_limit_is_not_run():
    """Measured 2026-09-30 (docs 21): a truncated shell command ran and failed on an
    unterminated quote; a truncated write_file lost its path. Nothing that the model did
    not finish writing may run."""
    from nanoagent.providers.base import ToolCallRequest

    ws = Path(tempfile.mkdtemp())
    cut = LLMResponse(
        content=None, finish_reason="length",
        tool_calls=[ToolCallRequest(id="c1", name="write_file", arguments={"path": "big.py", "content": "x = 1\n" * 10})],
    )
    loop = AgentLoop(bus=MessageBus(), provider=ScriptedProvider([
        cut, LLMResponse(content="Wrote it in parts instead.", finish_reason="stop"),
    ]), workspace=ws)
    final, _tools, messages, _usage, _record = await loop._run_agent_loop(
        [{"role": "user", "content": "Write big.py."}], session_key="probe"
    )
    assert not (ws / "big.py").exists(), "a cut-off call must not run"
    results = [m for m in messages if m.get("role") == "tool"]
    assert results and "cut off at the" in str(results[0].get("content"))
    assert final.strip() == "Wrote it in parts instead."



async def test_the_call_after_a_runaway_gets_a_small_reply_budget():
    """docs 21, bench 3: at long context GLM ignored the reasoning cap and low effort and ran to
    32,768 again — four minutes a time. The recovery call's own budget is the hard bound."""
    seen: list = []

    class Recording(ScriptedProvider):
        async def chat(self, messages, tools=None, model=None, temperature=0.1,
                       max_tokens=4096, on_token=None, **kwargs):
            seen.append(max_tokens)
            return await super().chat(messages, tools, model, temperature, max_tokens, on_token, **kwargs)

    loop = AgentLoop(bus=MessageBus(), provider=Recording([
        LLMResponse(content="", finish_reason="length"),
        LLMResponse(content="done", finish_reason="stop"),
    ]), workspace=Path(tempfile.mkdtemp()), max_tokens=32768)
    await loop._run_agent_loop([{"role": "user", "content": "Go."}], session_key="probe")
    assert seen == [32768, 8192]


async def test_a_long_turn_is_told_to_save_its_work(monkeypatch):
    """docs 21: 106 minutes, two timeouts, no partial answer ever written — nothing kept."""
    from nanoagent.agent import loop as loop_mod
    from nanoagent.providers.base import ToolCallRequest

    monkeypatch.setattr(loop_mod, "_CHECKPOINT_EVERY_S", 0)
    step = LLMResponse(content=None, finish_reason="tool_calls",
                       tool_calls=[ToolCallRequest(id="c1", name="list_dir", arguments={"path": "."})])
    final, messages, calls = await run_turn([step, LLMResponse(content="done", finish_reason="stop")])
    told = [m for m in messages if "Runtime reminder" in str(m.get("content"))]
    assert len(told) == 1 and final.strip() == "done"
    # 2026-10-01: as a "[System: …]" user turn it read as a new task and derailed a long run.
    # It rides on the tool result instead, and says the task is unchanged.
    assert told[0]["role"] == "tool"
    assert "Your task has not changed" in told[0]["content"]
    assert not [m for m in messages if m.get("role") == "user" and "Runtime reminder" in str(m.get("content"))]


async def test_a_short_turn_is_not_interrupted():
    from nanoagent.providers.base import ToolCallRequest

    step = LLMResponse(content=None, finish_reason="tool_calls",
                       tool_calls=[ToolCallRequest(id="c1", name="list_dir", arguments={"path": "."})])
    _final, messages, _calls = await run_turn([step, LLMResponse(content="done", finish_reason="stop")])
    assert not [m for m in messages if "Runtime reminder" in str(m.get("content"))]
