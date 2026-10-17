"""
The invariant that every message in the history must be sendable.

Regression cover for prod job_1784282660066_09749629 (2026-07-17), where one degenerate
model turn — no content, no tool calls — was appended to the history and permanently
poisoned the session: the OpenAI-compatible schema requires an assistant message to carry
content or tool_calls, so DeepSeek rejected every subsequent request with
"Invalid assistant message: content or tool_calls must be set". Including the grace call
whose only job was to recover from that empty turn.
"""
import tempfile
from pathlib import Path

import pytest

from nanoagent.agent.context import ContextBuilder


@pytest.fixture
def ctx():
    with tempfile.TemporaryDirectory() as d:
        yield ContextBuilder(workspace=Path(d))


def test_empty_turn_is_not_appended(ctx):
    """The exact shape that poisoned the prod session: no content, no tool calls."""
    messages = [{"role": "user", "content": "build me a page"}]
    out = ctx.add_assistant_message(messages, None)
    assert out == [{"role": "user", "content": "build me a page"}]


@pytest.mark.parametrize("content", [None, ""])
def test_no_content_and_no_tool_calls_is_dropped(ctx, content):
    assert ctx.add_assistant_message([], content, tool_calls=None) == []
    assert ctx.add_assistant_message([], content, tool_calls=[]) == []


def test_reasoning_alone_does_not_make_a_message_sendable(ctx):
    """
    A reasoning-only turn is still unsendable — the API counts content and tool_calls,
    not reasoning_content. Dropping loses nothing an answer depended on: the model
    thought and then said nothing.
    """
    assert ctx.add_assistant_message([], None, reasoning_content="thinking hard") == []


def test_tool_calls_without_content_are_kept(ctx):
    """
    The common healthy case — DeepSeek emits content=None whenever it calls a tool, and
    that is valid because tool_calls is set. A guard that dropped these would break every
    tool-using turn, so this is the line the fix must not cross.
    """
    calls = [{"id": "c1", "type": "function", "function": {"name": "write_file", "arguments": "{}"}}]
    out = ctx.add_assistant_message([], None, tool_calls=calls)
    assert out == [{"role": "assistant", "content": None, "tool_calls": calls}]


def test_content_without_tool_calls_is_kept(ctx):
    out = ctx.add_assistant_message([], "Here is your page.")
    assert out == [{"role": "assistant", "content": "Here is your page."}]


def test_every_assistant_message_left_in_history_is_sendable(ctx):
    """
    The property itself, stated once over the whole surface: whatever the model returns,
    the history never accumulates a message the API will reject. This is what makes the
    grace call survivable.
    """
    messages: list[dict] = [{"role": "user", "content": "go"}]
    calls = [{"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{}"}}]
    for content, tool_calls in [
        ("answered", None),
        (None, calls),
        (None, None),        # the degenerate turn
        ("", None),          # empty string variant
        ("done", calls),
    ]:
        messages = ctx.add_assistant_message(messages, content, tool_calls=tool_calls)

    assistants = [m for m in messages if m["role"] == "assistant"]
    assert len(assistants) == 3, "the two content-less, tool-call-less turns must be dropped"
    for m in assistants:
        assert m.get("content") or m.get("tool_calls"), f"unsendable message in history: {m}"
