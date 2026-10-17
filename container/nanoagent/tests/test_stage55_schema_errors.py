"""A schema error must tell the model the right call, not send it looking for another one.

Mailer called `request_approval` with the wrong argument names 174 times in eight days —
90 in a single day — and every failure answered "[Analyze the error above and try a
different approach.]". It did exactly that: invented a new shape each time, never the
documented one, burning whole cycles on a call it was one field away from getting right.

A parameter error is the single case where "try something else" is the wrong instruction.
The approach was right; the names were not.
"""
from __future__ import annotations

import pytest

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


class _Approval(Tool):
    """Same shape as the real request_approval."""

    @property
    def name(self) -> str:
        return "request_approval"

    @property
    def description(self) -> str:
        return "Submit a draft for human review."

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {
                "report_md": {"type": "string"},
                "action_type": {"type": "string"},
                "action_payload": {"type": "object"},
            },
            "required": ["report_md", "action_type"],
        }

    async def execute(self, **kwargs):
        return "submitted"


@pytest.fixture()
def reg() -> ToolRegistry:
    r = ToolRegistry()
    r.register(_Approval())
    return r


@pytest.mark.asyncio
async def test_names_the_required_parameters(reg):
    # Mailer's real failing call: invented argument names.
    out = await reg.execute("request_approval", {"action": "send_email", "details": "..."})

    assert "report_md" in out
    assert "action_type" in out
    assert "REQUIRED" in out


@pytest.mark.asyncio
async def test_shows_what_was_sent_and_what_was_ignored(reg):
    out = await reg.execute("request_approval", {"action": "send_email", "details": "..."})

    assert "You sent" in out
    assert "action" in out and "details" in out
    assert "ignored" in out.lower()


@pytest.mark.asyncio
async def test_does_not_tell_it_to_try_a_different_approach(reg):
    """The whole bug. This instruction is what produced 90 retries in one day."""
    out = await reg.execute("request_approval", {"action": "send_email"})

    assert "try a different approach" not in out.lower()
    assert "same tool" in out.lower()


@pytest.mark.asyncio
async def test_a_correct_call_still_just_works(reg):
    out = await reg.execute("request_approval", {"report_md": "## Draft", "action_type": "send_email"})
    assert out == "submitted"


@pytest.mark.asyncio
async def test_other_failures_keep_the_original_hint(reg):
    """Only SCHEMA errors change. A tool that runs and fails may well need another approach."""
    class _Boom(Tool):
        @property
        def name(self) -> str: return "boom"
        @property
        def description(self) -> str: return "always fails"
        @property
        def parameters(self) -> dict: return {"type": "object", "properties": {}}
        async def execute(self, **kwargs): raise RuntimeError("nope")

    reg.register(_Boom())
    out = await reg.execute("boom", {})
    assert "try a different approach" in out.lower()
