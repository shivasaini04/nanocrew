"""Batch classification must be fast AND unable to be quietly wrong.

Sorting fifty leads is fifty model calls today, 12-18 s apiece carrying 35-40K tokens the
job does not need. Jev answers the same fixed-choice question in ~0.35 s and takes many
questions per request, so fifty items become one call.

That trade is only worth making if a wrong label cannot pass for a real one. These tests
are mostly about the undecided bucket: every path where the classifier did not commit
must surface as `undecided`, never as a plausible-looking answer.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from nanoagent.agent.tools import classify as c
from nanoagent.agent.tools.classify import ClassifyTool

LABELS = {
    "hot": "asked for a call or pricing",
    "warm": "engaged but made no ask",
    "cold": "no sign of interest",
}
Q = "How interested is this lead?"


def run(tool, **kw):
    return json.loads(asyncio.run(tool.execute(**kw)))


def answers(*pairs):
    return {"answers": {f"i{n}": {"type": "choice", "choice": ch, "confidence": cf}
                        for n, (ch, cf) in enumerate(pairs)}}


class Response:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


@pytest.fixture
def key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    monkeypatch.delenv("JEV_CLASSIFY_MIN_CONF", raising=False)


def serve(monkeypatch, payload):
    import httpx

    monkeypatch.setattr(httpx, "post", lambda *a, **k: Response(payload))


# ──────────────────────────────────────────────── one call, many items

def test_every_item_becomes_its_own_question_in_one_request():
    body = c.build_request(["a", "b", "c"], LABELS, Q)
    assert set(body["questions"]) == {"i0", "i1", "i2"}
    assert body["questions"]["i1"]["criteria"] == LABELS


def test_answers_map_back_to_the_item_that_asked_them(key, monkeypatch):
    """Position is the only link between an item and its label. Getting this wrong would
    mislabel every row while looking perfectly well-formed."""
    serve(monkeypatch, answers(("cold", 0.95), ("hot", 0.97), ("warm", 0.91)))
    out = run(ClassifyTool(), items=["no thanks", "send pricing", "interesting"],
              labels=LABELS, question=Q)
    assert [r["label"] for r in out["results"]] == ["cold", "hot", "warm"]
    assert out["results"][1]["item"] == "send pricing"


def test_counts_summarise_the_batch(key, monkeypatch):
    serve(monkeypatch, answers(("hot", 0.9), ("hot", 0.9), ("cold", 0.9)))
    out = run(ClassifyTool(), items=["a", "b", "c"], labels=LABELS, question=Q)
    assert out["counts"] == {"hot": 2, "cold": 1}


# ───────────────────────────────────── the undecided bucket is the safety

def test_an_unsure_item_is_undecided_not_a_guess(key, monkeypatch):
    serve(monkeypatch, answers(("hot", 0.42)))
    row = run(ClassifyTool(), items=["maybe?"], labels=LABELS, question=Q)["results"][0]
    assert row["label"] == "undecided"
    assert row["best_guess"] == "hot", "the guess is offered, but never as the label"
    assert "0.42" in row["reason"]


def test_a_label_that_was_never_offered_is_refused(key, monkeypatch):
    """A well-formed choice question cannot produce this. If it ever does, the answer is
    not one the caller can act on, so it must not be handed back as one."""
    serve(monkeypatch, answers(("scorching", 0.99)))
    row = run(ClassifyTool(), items=["x"], labels=LABELS, question=Q)["results"][0]
    assert row["label"] == "undecided"
    assert "unknown label" in row["reason"]


def test_a_missing_answer_is_undecided(key, monkeypatch):
    """Three items sent, two answered. The third must not inherit a neighbour's label or
    silently vanish from the results."""
    serve(monkeypatch, answers(("hot", 0.9), ("cold", 0.9)))
    out = run(ClassifyTool(), items=["a", "b", "c"], labels=LABELS, question=Q)
    assert len(out["results"]) == 3
    assert out["results"][2]["label"] == "undecided"
    assert "no answer" in out["results"][2]["reason"]


def test_the_caller_is_told_to_read_the_undecided_ones(key, monkeypatch):
    serve(monkeypatch, answers(("hot", 0.3)))
    out = run(ClassifyTool(), items=["x"], labels=LABELS, question=Q)
    assert "undecided" in out["note"] and "best_guess" in out["note"]


def test_the_floor_can_be_raised_when_a_wrong_label_is_expensive(key, monkeypatch):
    serve(monkeypatch, answers(("hot", 0.85)))
    assert run(ClassifyTool(), items=["x"], labels=LABELS,
               question=Q)["results"][0]["label"] == "hot"
    assert run(ClassifyTool(), items=["x"], labels=LABELS, question=Q,
               min_confidence=0.95)["results"][0]["label"] == "undecided"


# ───────────────────────────────────────────────────────── refusing bad input

@pytest.mark.parametrize("kw,expect", [
    ({"items": [], "labels": LABELS, "question": Q}, "empty"),
    ({"items": ["a"], "labels": {"only": "one"}, "question": Q}, "at least 2"),
    ({"items": ["a"], "labels": LABELS, "question": "  "}, "`question` is required"),
    ({"items": ["a"], "labels": {f"l{n}": "x" for n in range(21)}, "question": Q}, "at most"),
])
def test_input_that_cannot_be_a_classification_is_refused(key, kw, expect):
    assert expect in asyncio.run(ClassifyTool().execute(**kw))


def test_undecided_cannot_be_used_as_a_label(key):
    """It is what this tool returns for a non-answer. Letting a caller also use it as a
    real label would make the two indistinguishable in the results."""
    out = asyncio.run(ClassifyTool().execute(
        items=["a"], labels={"undecided": "hmm", "sure": "yes"}, question=Q))
    assert "reserved" in out


# ────────────────────────────────────── failure never becomes a fake answer

def test_no_key_says_do_it_yourself(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    out = asyncio.run(ClassifyTool().execute(items=["a"], labels=LABELS, question=Q))
    assert "Error" in out and "yourself" in out


def test_an_unreachable_classifier_says_do_it_yourself(key, monkeypatch):
    import httpx

    def boom(*a, **k):
        raise httpx.ConnectError("no route")

    monkeypatch.setattr(httpx, "post", boom)
    out = asyncio.run(ClassifyTool().execute(items=["a"], labels=LABELS, question=Q))
    assert "Error" in out and "yourself" in out


def test_a_bad_status_never_returns_labels(key, monkeypatch):
    import httpx

    class Bad:
        status_code = 500

        @staticmethod
        def json():  # pragma: no cover - must never be reached
            raise AssertionError("a 500 body must not be read as answers")

    monkeypatch.setattr(httpx, "post", lambda *a, **k: Bad())
    assert "500" in asyncio.run(ClassifyTool().execute(items=["a"], labels=LABELS, question=Q))


# ─────────────────────────────────────────────────────────────── batch limits

def test_a_batch_past_the_limit_is_trimmed_and_said_so(key, monkeypatch):
    serve(monkeypatch, answers(*[("hot", 0.99)] * c._MAX_BATCH))
    out = run(ClassifyTool(), items=[f"lead {n}" for n in range(c._MAX_BATCH + 7)],
              labels=LABELS, question=Q)
    assert out["classified"] == c._MAX_BATCH
    assert "7 item(s) were not sent" in out["dropped"]


def test_blank_items_are_dropped_not_classified():
    assert set(c.build_request(["a", "   ", "b"], LABELS, Q)["questions"]) == {"i0", "i1"}


def test_a_long_item_is_trimmed_rather_than_refused():
    body = c.build_request(["x" * 9000], LABELS, Q)
    assert len(body["questions"]["i0"]["instructions"]) < 9000


# ─────────────────────────────────────────────────────────────── the floor env

@pytest.mark.parametrize("raw,expect", [
    (None, 0.7), ("", 0.7), ("nonsense", 0.7), ("2.5", 0.7), ("-1", 0.7), ("0.9", 0.9),
])
def test_an_empty_or_bogus_floor_means_the_default_not_zero(monkeypatch, raw, expect):
    """`-e JEV_CLASSIFY_MIN_CONF=` sets it to "". Reading that as 0.0 would accept every
    guess — the trap this codebase has hit four times, always by treating "set to
    nothing" as "set to off"."""
    if raw is None:
        monkeypatch.delenv("JEV_CLASSIFY_MIN_CONF", raising=False)
    else:
        monkeypatch.setenv("JEV_CLASSIFY_MIN_CONF", raw)
    assert c._floor() == expect


# ──────────────────────────────────────────────── the agent can actually reach it

def test_the_tool_is_registered_and_advertised():
    """A tool nothing registers is a file, not a capability. And a tool the model cannot
    see is reached only by guessing it exists: the trigger here is "score these leads",
    a job, not a tool name, so nothing would prompt a tool_search for it."""
    import re
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "nanoagent" / "agent" / "loop.py"
    text = src.read_text(encoding="utf-8")
    assert "self.tools.register(ClassifyTool())" in text, "registered nowhere"

    block = text[text.index("_CORE_TOOLS = {"):text.index("self.tools.enable_deferral")]
    block = "\n".join(line.split("#", 1)[0] for line in block.splitlines())
    assert "classify" in re.findall(r'"([a-z_0-9]+)"', block), "not advertised up front"


def test_the_labels_map_declares_its_value_type():
    """A bare {"type": "object"} tells a strict function-call validator nothing about
    what is inside. Gemini's is strict, and the other free-form string->string maps here
    (http_request.headers, request_approval.action_payload) all say so."""
    spec = ClassifyTool().parameters["properties"]["labels"]
    assert spec.get("additionalProperties") == {"type": "string"}
