"""Stage 56 phase 1 — the container half of answering a teammate.

The orchestrator owns the protocol; this tool is a thin client. So what is worth testing
here is exactly what the client decides on its own, and each of these has a scar behind it:

  - **It refuses to lie when it cannot reach the orchestrator.** `self_report`'s equivalent
    guard exists because Finder, asked how many cycles it had run, counted files in its
    workspace and answered 210 when the real number was 458. A model with no channel does
    not report "no channel", it reports a plausible number — so the tool has to say so.

  - **It passes the orchestrator's errors through verbatim.** Mailer called
    `request_approval` with wrong arguments 174 times in eight days, 90 of them in one day,
    because the error it got back said "try a different approach" and it did — a new wrong
    shape each time. An error that names the missing field ends the loop; one that says
    "that failed" feeds it.

  - **It validates the verb locally**, so a typo costs no HTTP round trip and comes back
    with the list rather than a 422 the model has to interpret.
"""
from __future__ import annotations

import json

import pytest

from nanoagent.agent.tools.reply_to_handoff import ReplyToHandoffTool, REPLY_VERBS


@pytest.fixture()
def tool() -> ReplyToHandoffTool:
    return ReplyToHandoffTool()


@pytest.mark.asyncio
async def test_says_so_rather_than_pretending_when_there_is_no_cycle(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)

    out = await tool.execute(handoff_id="h1", performative="result", result="done")

    assert "token" in out.lower()
    # The instruction that matters: do not silently assume the reply went out.
    assert "assuming the reply was sent" in out


@pytest.mark.asyncio
async def test_rejects_an_unknown_verb_without_a_round_trip(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    out = await tool.execute(handoff_id="h1", performative="done", result="finished")

    # Names the alternatives. A model handed "invalid" tries another wrong shape.
    for verb in REPLY_VERBS:
        assert verb in out


@pytest.mark.asyncio
async def test_asks_for_the_id_rather_than_guessing_one(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    out = await tool.execute(performative="result", result="done")

    assert "handoff_id is required" in out
    assert "action='list'" in out


@pytest.mark.asyncio
async def test_sends_the_reply_to_the_self_scoped_route(tool, monkeypatch):
    """The route is under /self/ and bearer-authenticated, not the UUID-only handoff path.

    A reply is read back as fact by the sender and by change-impact measurement, so it must
    not be writable by anyone holding an agent id out of a log.
    """
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://orch:3002")

    seen: dict = {}

    class _Resp:
        status_code = 200
        text = '{"ok": true}'

        def json(self):
            return {"ok": True, "answered": "h1"}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None, timeout=None):
            seen["url"] = url
            seen["json"] = json
            seen["headers"] = headers
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _Client())

    out = await tool.execute(
        handoff_id="h1", performative="cannot",
        result="I did not send these.", reason="verify_email",
    )

    assert seen["url"] == "http://orch:3002/api/agents/agent-1/self/handoffs/h1/reply"
    assert seen["headers"]["Authorization"] == "Bearer tok"
    assert seen["json"] == {
        "performative": "cannot",
        "result": "I did not send these.",
        "reason": "verify_email",
    }
    assert json.loads(out)["ok"] is True


@pytest.mark.asyncio
async def test_passes_the_orchestrators_error_through_intact(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    class _Resp:
        status_code = 422
        text = "unused"

        def json(self):
            return {
                "error": "`reason` is required for \"cannot\" — name the tool you are missing.",
                "meaning": {"cannot": "I would, but I lack a tool, skill or access."},
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, *a, **k):
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _Client())

    out = await tool.execute(handoff_id="h1", performative="cannot", result="could not")

    # Verbatim, including the vocabulary crib — this is what stops the retry storm.
    assert "name the tool you are missing" in out
    assert "I would, but I lack a tool" in out


@pytest.mark.asyncio
async def test_list_reads_the_inbox_route(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://orch:3002")

    seen: dict = {}

    class _Resp:
        status_code = 200
        text = '{"owedByYou": []}'

        def json(self):
            return {"owedByYou": [], "awaitingAnswer": []}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None, timeout=None):
            seen["url"] = url
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _Client())

    await tool.execute(action="list")
    assert seen["url"] == "http://orch:3002/api/agents/agent-1/self/handoffs"


def test_is_advertised_not_deferred():
    """The trigger arrives in the cycle context, so the tool must be in front of the model.

    Stage 54 measured this exact failure: `self_report` was deferred, and it went uncalled
    until the prompt named it. An agent handed a message it cannot answer does not go
    looking for a reply tool — it does the work and says nothing, which is the silence this
    phase exists to end.
    """
    import inspect

    from nanoagent.agent import loop as loop_mod

    src = inspect.getsource(loop_mod)
    core = src.split("_CORE_TOOLS = {", 1)[1].split("}", 1)[0]
    assert '"reply_to_handoff"' in core


def _stub_post(monkeypatch, seen: dict):
    class _Resp:
        status_code = 200
        text = '{"ok": true}'

        def json(self):
            return {"ok": True}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None, timeout=None):
            seen["url"] = url
            seen["json"] = json
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _Client())


@pytest.mark.asyncio
async def test_accepts_the_verb_in_action(tool, monkeypatch):
    """The shape Mailer actually produced on the first live cycle, 2026-09-09.

    It wrote ``action="result"`` ten times — the natural reading, since `action` is the
    field that asks what you are doing — got ten schema errors, and retried all ten with
    ``action="reply", performative="result"``. Twenty calls for ten messages, roughly half
    the cycle. The model was not wrong; two enums that both answer "what am I doing" is a
    trap the schema set. Both shapes work now.
    """
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    seen: dict = {}
    _stub_post(monkeypatch, seen)

    await tool.execute(handoff_id="h1", action="result", result="Sent 24.")

    assert seen["url"].endswith("/self/handoffs/h1/reply")
    assert seen["json"]["performative"] == "result"


@pytest.mark.asyncio
async def test_the_original_shape_still_works(tool, monkeypatch):
    """Mailer has now learned `action='reply', performative='result'`. It must keep working."""
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    seen: dict = {}
    _stub_post(monkeypatch, seen)

    await tool.execute(handoff_id="h1", action="reply", performative="cannot",
                       result="I did not send these.", reason="verify_email")

    assert seen["json"]["performative"] == "cannot"
    assert seen["json"]["reason"] == "verify_email"


@pytest.mark.asyncio
async def test_explicit_performative_wins_over_a_verb_in_action(tool, monkeypatch):
    """The more specific field is never silently ignored."""
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    seen: dict = {}
    _stub_post(monkeypatch, seen)

    await tool.execute(handoff_id="h1", action="result", performative="cannot",
                       result="no", reason="verify_email")

    assert seen["json"]["performative"] == "cannot"


@pytest.mark.asyncio
async def test_a_missing_verb_names_both_places_it_can_go(tool, monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    out = await tool.execute(handoff_id="h1", result="done")

    assert "action" in out and "performative" in out
    for verb in REPLY_VERBS:
        assert verb in out


def test_the_schema_offers_the_verbs_where_a_model_looks_for_them(tool):
    """The fix is in the schema, not only in the parser.

    Tolerant parsing alone would still show the model an `action` enum of reply|list and a
    separate verb enum, i.e. the same trap, merely survivable. The verbs belong in the
    field that asks what you are doing.
    """
    action = tool.parameters["properties"]["action"]["enum"]
    for verb in REPLY_VERBS:
        assert verb in action
    assert "list" in action
