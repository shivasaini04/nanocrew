"""Stage 61 — Jev as the per-step decider (effector/jev_policy.py) and the confidence gate
in react_loop. Offline: the Decisions API is replaced by a fake response.

Measured on 60 recorded decisions before this was wired: operation agreement 39/60, but
when the operation agreed the element matched 25/26 (24/24 when Jev was confident about
the element), at 0.36 s median against ~1.5 s for the LLM. So the gate executes Jev only
when it is sure, and hands every other turn to the LLM.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from nanoagent.agent.effector import jev_policy as jp

SUMMARY = """Page URL: https://books.example/
Interactive Elements:
  [@e1] a "Travel" (center: 100,200)
  [@e2] input type="text" "Search books" (center: 300,50)
  [@e3] button "Go" (center: 400,50)
"""


def test_the_request_asks_for_the_operation_and_a_target_per_operation():
    body = jp.build_request("find travel books", SUMMARY, "none yet", "https://books.example/")
    qs = body["questions"]
    assert set(qs) == {"operation", "click_target", "type_target"}
    assert set(qs["click_target"]["criteria"]) == {"@e1", "@e2", "@e3"}
    # Only the text input can receive typing.
    assert set(qs["type_target"]["criteria"]) == {"@e2"}
    assert body["model"].endswith("jev-latest") or "jev" in body["model"]
    assert body["state"]["goal"] == "find travel books"


def test_a_page_with_no_elements_asks_nothing():
    assert jp.build_request("g", "Page URL: x\nInteractive Elements:\n", "", "") is None


def test_no_key_is_an_error_not_a_guess(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    d = jp.decide_sync("g", SUMMARY, "", "")
    assert d.action == "other" and d.error and "OPENROUTER_API_KEY" in d.error


def _fake_post(answers, status=200, cost=0.00002):
    class R:
        status_code = status
        text = json.dumps({"answers": answers})

        def json(self):
            return {"answers": answers, "usage": {"cost": cost}, "model": "typesafe/jev-1.13"}
    def post(*a, **kw):
        return R()
    return post


def test_a_click_answer_carries_the_element_and_its_confidence():
    answers = {
        "operation": {"type": "choice", "choice": "click", "confidence": 0.93, "probabilities": {"click": 0.93}},
        "click_target": {"type": "choice", "choice": "@e1", "confidence": 0.88, "probabilities": {"@e1": 0.88}},
    }
    with patch("httpx.post", _fake_post(answers)):
        d = jp.decide_sync("g", SUMMARY, "", "", api_key="k")
    assert (d.action, d.target) == ("click", "@e1")
    assert d.action_confidence == 0.93 and d.target_confidence == 0.88
    assert d.cost > 0 and d.model.startswith("typesafe/")


def test_typing_takes_the_type_head_not_the_click_head():
    answers = {
        "operation": {"type": "choice", "choice": "type", "confidence": 0.9},
        "click_target": {"type": "choice", "choice": "@e3", "confidence": 0.9},
        "type_target": {"type": "choice", "choice": "@e2", "confidence": 0.9},
    }
    with patch("httpx.post", _fake_post(answers)):
        d = jp.decide_sync("g", SUMMARY, "", "", api_key="k")
    assert (d.action, d.target) == ("type", "@e2")


def test_an_http_error_is_handed_back_not_raised():
    class R:
        status_code = 500
        text = "upstream down"
    with patch("httpx.post", lambda *a, **kw: R()):
        d = jp.decide_sync("g", SUMMARY, "", "", api_key="k")
    assert d.action == "other" and "500" in d.error


async def _run_loop(tmp_path, monkeypatch, jev_decision, script, jev_decisions=None):
    from nanoagent.agent.tools.effector import EffectorTool
    from test_effector_phase0 import FakeSession, ScriptedProvider

    monkeypatch.setenv("EFFECTOR_DECIDER", "jev")
    provider = ScriptedProvider(script)

    queue = list(jev_decisions or [])

    async def fake_decide(goal, summary, recent, url, api_key=None):
        # A real decider sees a changed page each turn; a stub that repeats one answer
        # would only exercise the anti-loop guard.
        return queue.pop(0) if queue else jev_decision

    # react_loop imports `decide` at call time, so patching the module attribute lands.
    monkeypatch.setattr(jp, "decide", fake_decide)
    tool = EffectorTool(workspace=tmp_path, provider=provider, model="fake/p",
                        decision_provider=provider, decision_model="fake/d", require_approval=False)
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        out = json.loads(await tool.execute(goal="do it", session_domain="example.test"))
    return out, provider


@pytest.mark.asyncio
async def test_a_confident_jev_click_is_the_one_executed(tmp_path, monkeypatch):
    """Both deciders are asked at once, so the LLM is still CALLED — what Jev saves is the
    wait. The step that runs is Jev's, and the record says so."""
    jd = jp.JevDecision(action="click", target="@e1", action_confidence=0.95, target_confidence=0.92,
                        seconds=0.3, model="typesafe/jev-1.13")
    unsure = jp.JevDecision(action="click", target="@e1", action_confidence=0.2, target_confidence=0.2)
    out, provider = await _run_loop(tmp_path, monkeypatch, unsure, [
        {"thought": "llm would have said done", "action": "done"},
    ], jev_decisions=[jd])
    assert out["success"] is True
    from nanoagent.agent.effector.decision_log import read_records
    decisions = [r for r in read_records(tmp_path) if r["type"] == "decision"]
    assert decisions[0]["model"].startswith("typesafe/")
    assert decisions[0]["action"]["action"] == "click"
    assert [t["action"] for t in out["turns"]][0] == "click"
    from nanoagent.agent.effector.decision_log import read_records
    models = [r["model"] for r in read_records(tmp_path) if r["type"] == "decision"]
    assert models[0].startswith("typesafe/")


@pytest.mark.asyncio
async def test_an_unsure_jev_answer_is_handed_to_the_llm(tmp_path, monkeypatch):
    jd = jp.JevDecision(action="click", target="@e1", action_confidence=0.41, target_confidence=0.9)
    out, provider = await _run_loop(tmp_path, monkeypatch, jd, [
        {"thought": "llm decides", "action": "done"},
    ])
    assert out["success"] is True and provider.calls == 1
    from nanoagent.agent.effector.decision_log import read_records
    assert [r["model"] for r in read_records(tmp_path) if r["type"] == "decision"] == ["fake/d"]


@pytest.mark.asyncio
async def test_jev_never_calls_the_run_finished(tmp_path, monkeypatch):
    """`done` ends the run and triggers verification and extraction — that stays with the
    LLM even when Jev is confident."""
    jd = jp.JevDecision(action="done", target=None, action_confidence=0.99, target_confidence=None)
    out, provider = await _run_loop(tmp_path, monkeypatch, jd, [{"thought": "llm", "action": "done"}])
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_jev_may_type_because_a_small_model_supplies_the_words(tmp_path, monkeypatch):
    """Jev generates no text, so this used to go to the full LLM — which then re-picked
    the field Jev had already chosen. Stage 62 pairs it with one narrow text question
    (field_text.py), the way browser-use's jev-ultrafast does, so a typing turn is Jev's
    plus a short helper call rather than a whole decision.

    The helper call is why the provider is used at all here: this asserts the loop still
    SUCCEEDS with Jev choosing the field, not that no model was consulted."""
    jd = jp.JevDecision(action="type", target="@e1", action_confidence=0.99, target_confidence=0.99)
    out, provider = await _run_loop(tmp_path, monkeypatch, jd, [
        {"text": "Delhi"},
        {"thought": "done", "action": "done"},
    ])
    assert out["success"] is True


@pytest.mark.asyncio
async def test_a_stalled_loop_goes_back_to_the_llm(tmp_path, monkeypatch):
    """The anti-loop nudge lives in the LLM prompt. If Jev kept answering while nothing
    progressed, nobody would ever read it."""
    jd = jp.JevDecision(action="click", target="@e1", action_confidence=0.99, target_confidence=0.99)
    out, provider = await _run_loop(tmp_path, monkeypatch, jd, [
        {"thought": "llm breaks the loop", "action": "done"},
    ])
    # Jev clicked while it was progressing; once it stopped progressing the LLM was asked.
    assert provider.calls >= 1
    assert out["turns_executed"] >= 1
