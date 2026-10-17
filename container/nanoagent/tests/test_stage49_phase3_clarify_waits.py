"""Stage 49 phase 3 — asking a question must not cost the agent its run.

`clarify` used to queue the question and return immediately; the answer arrived on a
LATER cycle through processFeedback, by which time the browser was closed and any
half-finished work was gone. So asking cost everything and guessing cost nothing, and
an agent facing that trade guesses — prod cycle `e1c1aecc` invented the contact email
`hello@nanocrew.ai` rather than asking which address to use. The bug was the incentive.

It now blocks on the answer the way `request_approval` already does, and hands the
reply back as the tool result so the run continues in the same cycle.
"""

from __future__ import annotations

import json

import pytest

from nanoagent.agent.tools import clarify as clarify_mod
from nanoagent.agent.tools.clarify import ClarifyTool


@pytest.fixture(autouse=True)
def _no_stop(monkeypatch):
    # The Stop check is its own HTTP call; these fakes model only the answer polls.
    async def never(*_a, **_k):
        return False
    monkeypatch.setattr(clarify_mod, "stop_requested", never)


class _Res:
    def __init__(self, status=200, payload=None, text=""):
        self.status_code = status
        self._payload = payload if payload is not None else {}
        self.text = text

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient. `gets` is the scripted poll sequence."""

    def __init__(self, gets, post=None, seen=None):
        self._gets = list(gets)
        self._post = post or _Res(201, {"id": "checkin-1"})
        self.seen = seen if seen is not None else {}

    def __call__(self, *a, **kw):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, json=None, **kw):
        self.seen["post_body"] = json
        return self._post

    async def get(self, url, **kw):
        self.seen.setdefault("polls", 0)
        self.seen["polls"] += 1
        return self._gets.pop(0) if self._gets else _Res(200, {"status": "pending"})


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    # No real waiting in tests — the poll interval is the only sleep in the loop.
    async def _no_sleep(_seconds):
        return None
    monkeypatch.setattr(clarify_mod.asyncio, "sleep", _no_sleep)


# ─── the behaviour this phase exists to create ────────────────────────────────

@pytest.mark.asyncio
async def test_it_waits_and_returns_the_answer(monkeypatch):
    """The whole phase: the reply comes back as the tool result, in the same cycle."""
    client = _FakeClient(gets=[
        _Res(200, {"status": "pending", "user_reply": None}),
        _Res(200, {"status": "responded", "user_reply": "Use you@example.com"}),
    ])
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Which email should I use?"))

    assert out["answered"] is True
    assert out["reply"] == "Use you@example.com"


@pytest.mark.asyncio
async def test_the_question_is_marked_live_with_a_deadline(monkeypatch):
    """The orchestrator decides whether a cycle is still listening by reading the
    deadline the asker wrote (isLiveClarifyAwaitingReply). Without it, the answer would
    start a second cycle to reply to a question the first is still sitting on."""
    seen: dict = {}
    client = _FakeClient(gets=[_Res(200, {"status": "responded", "user_reply": "yes"})], seen=seen)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    await ClarifyTool().execute(question="Proceed?")

    body = seen["post_body"]
    assert body["action_type"] == "clarify_live"
    payload = json.loads(body["action_payload"])
    assert payload["awaitUntil"] > 0


@pytest.mark.asyncio
async def test_a_timeout_forbids_inventing_the_value(monkeypatch):
    """The failure mode that started this stage was a fabricated email. An unanswered
    question must never read as permission to make one up."""
    monkeypatch.setattr(clarify_mod, "CLARIFY_TIMEOUT_S", 6)
    client = _FakeClient(gets=[_Res(200, {"status": "pending"})] * 10)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Which email?"))

    assert out["answered"] is False
    assert out["timed_out"] is True
    assert "do not invent" in out["message"].lower()


@pytest.mark.asyncio
async def test_it_stops_polling_once_answered(monkeypatch):
    """A long timeout must not mean a long wait after the answer has landed."""
    monkeypatch.setattr(clarify_mod, "CLARIFY_TIMEOUT_S", 300)
    seen: dict = {}
    client = _FakeClient(gets=[_Res(200, {"status": "responded", "user_reply": "go"})], seen=seen)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    await ClarifyTool().execute(question="Proceed?")

    assert seen["polls"] == 1


# ─── robustness of the wait ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_a_poll_blip_is_retried_not_read_as_no_answer(monkeypatch):
    """An orchestrator hiccup must not look like silence — that would send the agent
    straight back to guessing, which is the behaviour this phase removes."""
    client = _FakeClient(gets=[
        _Res(503, text="bad gateway"),
        _Res(200, {"status": "pending"}),
        _Res(200, {"status": "responded", "user_reply": "use the second one"}),
    ])
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Which one?"))

    assert out["answered"] is True
    assert out["reply"] == "use the second one"


@pytest.mark.asyncio
async def test_answered_with_an_empty_reply_does_not_wait_out_the_timeout(monkeypatch):
    monkeypatch.setattr(clarify_mod, "CLARIFY_TIMEOUT_S", 300)
    seen: dict = {}
    client = _FakeClient(gets=[_Res(200, {"status": "responded", "user_reply": "  "})], seen=seen)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Proceed?"))

    assert out["answered"] is True
    assert out["reply"] == ""
    assert seen["polls"] == 1


@pytest.mark.asyncio
async def test_a_failed_create_reports_rather_than_waiting(monkeypatch):
    client = _FakeClient(gets=[], post=_Res(500, text="boom"))
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Which email?"))

    assert out["queued"] is False
    assert "500" in out["error"]


@pytest.mark.asyncio
async def test_a_create_without_an_id_does_not_poll_forever(monkeypatch):
    seen: dict = {}
    client = _FakeClient(gets=[], post=_Res(201, {}), seen=seen)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    out = json.loads(await ClarifyTool().execute(question="Which email?"))

    assert out["queued"] is False
    assert seen.get("polls") is None


# ─── the tool must still tell the model not to invent things ──────────────────

def test_the_description_forbids_inventing_a_value():
    """The description is the only place the model learns when to reach for this. The
    fabricated-email bug is why it now names that case explicitly."""
    description = ClarifyTool().description.lower()
    assert "instead of inventing" in description
    assert "never make" in description


# ─── the tool has to be visible for any of the above to matter ────────────────

def test_clarify_is_advertised_rather_than_deferred():
    """Found live 2026-09-02, cycle `aecd554b`, and the reason the phase-3 machinery
    went unused on its first real test.

    With DEFERRED_TOOLS=on (the prod default) only `_CORE_TOOLS` is advertised; the rest
    must be discovered with `tool_search`. `clarify` was not in that set, so an agent
    told to ask rather than guess searched for `effector`, never learned `clarify`
    existed, and ended the cycle with its question written out in prose instead.

    The trigger for this tool is an internal state — "I was not given a value I need" —
    not a keyword anyone would think to search for. loop.py already records exactly this
    reasoning for `self_manage`. A deferred `clarify` is a `clarify` that never fires.
    """
    import re
    from pathlib import Path

    loop_py = Path(__file__).resolve().parents[1] / "nanoagent" / "agent" / "loop.py"
    body = loop_py.read_text(encoding="utf-8")
    core = re.search(r"_CORE_TOOLS = \{(.*?)\n            \}", body, re.S)
    assert core, "could not find _CORE_TOOLS in loop.py"
    assert '"clarify"' in core.group(1), "clarify must be advertised, not deferred"


@pytest.mark.asyncio
async def test_the_question_travels_structured_for_the_chat_card(monkeypatch):
    """Stage 60 phase 2. The chat renders option buttons from action_payload; a question
    that only carried rendered markdown drew as an approve/reject card instead."""
    seen: dict = {}
    client = _FakeClient(gets=[_Res(200, {"status": "responded", "user_reply": "1. LinkedIn"})], seen=seen)
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)

    await ClarifyTool().execute(
        question="Where should I look for leads?",
        options=[{"label": "LinkedIn", "detail": "your browser"}, {"label": "Job boards"}, {"detail": "no label"}],
        context="Read example.com",
    )

    payload = json.loads(seen["post_body"]["action_payload"])
    assert payload["question"] == "Where should I look for leads?"
    assert [o["label"] for o in payload["options"]] == ["LinkedIn", "Job boards"]
    assert payload["options"][0]["detail"] == "your browser"
    assert payload["context"] == "Read example.com"
    assert payload["multi_select"] is False
    assert payload["awaitUntil"] > 0



@pytest.mark.asyncio
async def test_stop_ends_the_wait(monkeypatch):
    """Stage 60 live test: Stop could not reach a run blocked on a question."""
    async def stopped(*_a, **_k):
        return True
    monkeypatch.setattr(clarify_mod, "stop_requested", stopped)
    client = _FakeClient(gets=[_Res(200, {"status": "pending", "user_reply": None})], seen={})
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", client)
    out = json.loads(await ClarifyTool().execute(question="Proceed?"))
    assert out["stopped"] is True and out["answered"] is False
