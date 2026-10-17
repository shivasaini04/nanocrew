"""Stage 63 phase 1 — pre-load the tool a turn needs, instead of hunting for it.

An agent owns 94 tools; 45 are hidden behind `tool_search` to keep the prompt small.
Reaching one costs TWO model calls at 12-18 s each — measured live 2026-09-21, ~28 s of
a 133 s cycle. Jev picks from a fixed list in ~0.35 s, which is the same question.

The rule these tests hold to: this may only ever ADD a tool the model could have found
itself. It must never remove one, never block a turn, and never fail loudly.
"""

from __future__ import annotations

import pytest

from nanoagent.agent import tool_preselect as tp


class FakeRegistry:
    def __init__(self, deferred: dict[str, str]):
        self._deferred = deferred
        self.activated: list[str] = []

    def deferred_names(self):
        return list(self._deferred)

    def deferred_catalog(self):
        return dict(self._deferred)

    def activate(self, names):
        known = [n for n in names if n in self._deferred]
        unknown = [n for n in names if n not in self._deferred]
        self.activated.extend(known)
        return (known, unknown)


CATALOG = {
    "read_image": "Look at an image file and describe what it shows.",
    "gmail_send": "Send an email from the user's Gmail account.",
    "sql_query": "Run a read-only SQL query against a database.",
}


def user(text):
    return [{"role": "user", "content": text}]


# ─────────────────────────────────────────────────────────── the question asked

def test_the_request_offers_every_hidden_tool_plus_none():
    body = tp.build_request("look at this screenshot", CATALOG)
    criteria = body["questions"]["tool"]["criteria"]
    assert set(criteria) == set(CATALOG) | {"none"}


def test_none_is_a_real_option_and_the_expected_answer():
    """Most turns need nothing from the hidden 45. A picker that always picks is worse
    than useless — it puts an unused schema in every prompt."""
    body = tp.build_request("say hello", CATALOG)
    assert "none" in body["questions"]["tool"]["criteria"]
    assert "Answer 'none' unless" in body["questions"]["tool"]["instructions"]


def test_descriptions_are_cut_to_one_short_line():
    """A tool's real description runs to paragraphs. Forty-five of those would cost
    more than the round trip this is meant to save."""
    long = "First line about the tool.\n\n" + ("x" * 5000)
    assert tp.short_description(long) == "First line about the tool."
    assert len(tp.short_description("y" * 5000)) <= 110


def test_no_request_when_there_is_nothing_to_choose_between():
    assert tp.build_request("do a thing", {}) is None
    assert tp.build_request("", CATALOG) is None


# ──────────────────────────────────────────────────────── what counts as an answer

def answer(monkeypatch, choice, confidence):
    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {"answers": {"tool": {"type": "choice", "choice": choice,
                                         "confidence": confidence}}}

    monkeypatch.setattr(tp, "_MIN_CONFIDENCE", 0.8, raising=False)
    import httpx

    monkeypatch.setattr(httpx, "post", lambda *a, **k: Response())


def test_a_confident_answer_is_taken(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    answer(monkeypatch, "read_image", 0.95)
    out = tp.preselect_sync("look at this screenshot", CATALOG)
    assert out.tools == ["read_image"]


def test_an_unsure_answer_is_dropped(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    answer(monkeypatch, "read_image", 0.55)
    out = tp.preselect_sync("look at this screenshot", CATALOG)
    assert out.tools == []
    assert "0.55" in (out.skipped or "")


def test_none_means_load_nothing(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    answer(monkeypatch, "none", 0.99)
    assert tp.preselect_sync("say hello", CATALOG).tools == []


def test_a_tool_that_does_not_exist_is_ignored(monkeypatch):
    """A well-formed choice question cannot produce this, and it is dropped rather than
    trusted if it ever does."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    answer(monkeypatch, "launch_missiles", 0.99)
    assert tp.preselect_sync("do it", CATALOG).tools == []


# ─────────────────────────────────────────────────── it can never break a turn

@pytest.mark.asyncio
async def test_a_dead_jev_costs_nothing_but_its_own_latency(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    import httpx

    def boom(*a, **k):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(httpx, "post", boom)
    registry = FakeRegistry(CATALOG)
    out = await tp.activate_for(registry, user("look at this"))
    assert out.tools == [] and registry.activated == []


@pytest.mark.asyncio
async def test_no_api_key_is_a_quiet_no_op(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    registry = FakeRegistry(CATALOG)
    assert (await tp.activate_for(registry, user("x"))).tools == []
    assert registry.activated == []


@pytest.mark.asyncio
async def test_nothing_happens_when_deferral_is_off(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    registry = FakeRegistry({})
    out = await tp.activate_for(registry, user("x"))
    assert out.skipped == "deferral is off"


@pytest.mark.asyncio
async def test_a_confident_answer_reaches_the_registry(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    answer(monkeypatch, "gmail_send", 0.92)
    registry = FakeRegistry(CATALOG)
    await tp.activate_for(registry, user("email the report to Priya"))
    assert registry.activated == ["gmail_send"]


# ───────────────────────────────────────────────────────────── the off switch

@pytest.mark.parametrize("value,on", [
    (None, True), ("", True), ("on", True), ("anything", True),
    ("off", False), ("0", False), ("false", False), ("no", False),
])
def test_empty_means_on_not_off(monkeypatch, value, on):
    """`-e NANOCREW_JEV_TOOLS=` sets it to "". Reading that as "off" is the trap this
    codebase has now hit four times; only an explicit word turns it off."""
    if value is None:
        monkeypatch.delenv("NANOCREW_JEV_TOOLS", raising=False)
    else:
        monkeypatch.setenv("NANOCREW_JEV_TOOLS", value)
    assert tp.enabled() is on


def test_turned_off_makes_no_call(monkeypatch):
    monkeypatch.setenv("NANOCREW_JEV_TOOLS", "off")
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    import httpx

    def fail(*a, **k):
        raise AssertionError("made a call while switched off")

    monkeypatch.setattr(httpx, "post", fail)
    assert tp.preselect_sync("x", CATALOG).skipped == "turned off"


# ──────────────────────────────────────────────────────── what the task text is

def test_the_task_is_the_last_thing_the_user_said():
    messages = [
        {"role": "user", "content": "find me a flight"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "actually, read this screenshot"},
    ]
    assert tp.task_text(messages) == "actually, read this screenshot"


def test_structured_user_content_is_read_too():
    messages = [{"role": "user", "content": [{"type": "text", "text": "read this image"}]}]
    assert tp.task_text(messages) == "read this image"


def test_no_user_message_yields_nothing_to_ask_about():
    assert tp.task_text([{"role": "assistant", "content": "hi"}]) == ""
    assert tp.task_text([]) == ""
