"""Label many items at once, without spending a model call on each one.

WHY

Sorting fifty leads into hot/warm/cold, or fifty replies into interested/not-interested/
out-of-office, is a model call per item today: 12-18 s each, carrying 35-40K tokens of
tool schemas and conversation the classification does not need. Fifty of those is most of
an hour to answer a question that has three possible answers.

Jev answers exactly that shape of question — pick one option from a fixed list, with a
calibrated confidence — in ~0.35 s, and its API takes many questions in ONE request. So
fifty items become one call.

WHAT MAKES IT SAFE

A fast classifier that is quietly wrong is worse than no classifier, because nothing
downstream can tell. Two things prevent that:

  1. Every label carries the confidence it was given, and anything below the floor comes
     back as `undecided` rather than a guess. The caller sees which items Jev would not
     commit to and can judge those itself — the expensive path, for the few that need it.
  2. Labels are only ever ones the caller named. An answer outside the list is dropped.

So the worst case is "some items came back undecided", never "some items came back
wrong and nothing said so".
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

from nanoagent.agent.tools.base import Tool
from nanoagent.providers.relay_url import provider_url

# Through the key relay when there is one (providers/relay_url.py, stage 64 phase 2).
_DECISIONS_PATH = "/alpha/decisions"
_MODEL = os.environ.get("JEV_MODEL", "~typesafe/jev-latest")
_TIMEOUT_S = 30.0

# Items in one request. Jev takes many questions per call, but a request that carries a
# thousand of them is one failure away from losing the lot, and the whole batch shares a
# single timeout.
_MAX_BATCH = 50
# Each item's text. Enough for a lead record, an email body or a bio; past this the
# distinguishing detail is almost never at the end.
_MAX_ITEM_CHARS = 2000
_MAX_LABELS = 20

_DEFAULT_MIN_CONFIDENCE = 0.7
_UNDECIDED = "undecided"


def _floor() -> float:
    """Read at call time so a cycle can retune without a rebuild.

    Empty means the default: `-e JEV_CLASSIFY_MIN_CONF=` sets the variable to "", and
    reading that as 0.0 would accept every guess Jev makes. That misreading has bitten
    this codebase four times, always by treating "set to nothing" as "set to off".
    """
    raw = os.environ.get("JEV_CLASSIFY_MIN_CONF", "").strip()
    if not raw:
        return _DEFAULT_MIN_CONFIDENCE
    try:
        value = float(raw)
    except ValueError:
        return _DEFAULT_MIN_CONFIDENCE
    return value if 0.0 <= value <= 1.0 else _DEFAULT_MIN_CONFIDENCE


def build_request(items: list[str], labels: dict[str, str], question: str) -> dict | None:
    """One request carrying every item as its own question, or None if there is nothing
    to ask. Item i is question "i0", "i1", … so answers map back by position."""
    clean = [str(i)[:_MAX_ITEM_CHARS] for i in items[:_MAX_BATCH] if str(i).strip()]
    if not clean or len(labels) < 2:
        return None
    questions = {
        f"i{n}": {
            "type": "choice",
            "instructions": f"{question}\n\nThe item:\n{text}",
            "criteria": labels,
        }
        for n, text in enumerate(clean)
    }
    return {"model": _MODEL, "state": {"task": question}, "questions": questions}


def interpret(payload: dict, items: list[str], labels: dict[str, str],
              min_confidence: float) -> list[dict[str, Any]]:
    """Answers back to per-item results, in the order the items were given.

    An item Jev did not answer, answered below the floor, or answered with a label that
    was never offered all come back `undecided`. Each says which, because "Jev was
    unsure" and "Jev is misbehaving" call for different responses from the caller.
    """
    answers = payload.get("answers") or {}
    out: list[dict[str, Any]] = []
    for n, text in enumerate(items):
        answer = answers.get(f"i{n}") or {}
        choice = answer.get("choice")
        confidence = float(answer.get("confidence") or 0.0)
        row: dict[str, Any] = {
            "item": text[:120],
            "label": choice,
            "confidence": round(confidence, 3),
        }
        if not choice:
            row.update(label=_UNDECIDED, reason="no answer returned")
        elif choice not in labels:
            row.update(label=_UNDECIDED, reason=f"answered with an unknown label: {choice!r}")
        elif confidence < min_confidence:
            row.update(label=_UNDECIDED,
                       reason=f"only {confidence:.2f} sure, floor is {min_confidence:.2f}",
                       best_guess=choice)
        out.append(row)
    return out


class ClassifyTool(Tool):
    """Batch classification via Jev, with an explicit undecided bucket."""

    name = "classify"
    description = (
        "Sort many items into labels you define, in ONE fast call instead of reasoning "
        "about each one. Use this for lead scoring, email/reply triage, sentiment, "
        "spam-vs-real, topic tagging, or any job where every item gets one of a small "
        "fixed set of answers. Pass `items` (the texts) and `labels` (a map of "
        "label name -> what it means); you get back one row per item with its label and "
        "confidence. Items the classifier is not confident about come back as "
        "'undecided' with a best_guess — read those yourself rather than trusting the "
        "guess. Up to 50 items per call, ~1 second total. DO NOT use it for anything "
        "needing an explanation, a number, or free text — it can only choose between the "
        "labels you give it, and it never explains why."
    )
    parameters = {
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {"type": "string"},
                "description": "The texts to classify, up to 50. One string per item.",
            },
            "labels": {
                "type": "object",
                # Matches http_request.headers / request_approval.action_payload, the
                # other free-form string->string maps here. It also states that the
                # values are prose rather than nested structure, which strict
                # function-call schema validators (Gemini's among them) want to see.
                "additionalProperties": {"type": "string"},
                "description": (
                    "Map of label -> what that label means, e.g. "
                    '{"hot": "asked for a call or pricing", "warm": "engaged but no ask", '
                    '"cold": "no sign of interest"}. At least 2, at most 20. The meaning '
                    "matters as much as the name — it is what the classifier reads."
                ),
            },
            "question": {
                "type": "string",
                "description": (
                    "What is being decided, in one line, e.g. 'How interested is this "
                    "lead based on their reply?'"
                ),
            },
            "min_confidence": {
                "type": "number",
                "description": (
                    "Below this, an item is returned 'undecided' instead of labelled. "
                    "Defaults to 0.7. Raise it when a wrong label is expensive."
                ),
            },
        },
        "required": ["items", "labels", "question"],
    }

    async def execute(self, items: list[str] | None = None, labels: dict | None = None,
                      question: str = "", min_confidence: float | None = None,
                      **kwargs: Any) -> str:
        import asyncio

        items = list(items or [])
        labels = dict(labels or {})
        if not items:
            return "Error: `items` is empty — nothing to classify."
        if len(labels) < 2:
            return "Error: `labels` needs at least 2 options; classification with one label is not a decision."
        if len(labels) > _MAX_LABELS:
            return f"Error: {len(labels)} labels given, at most {_MAX_LABELS}. Group them, or classify in two passes."
        if _UNDECIDED in labels:
            return (
                f"Error: '{_UNDECIDED}' is reserved — it is what this tool returns for items "
                "below the confidence floor. Name that label something else."
            )
        if not question.strip():
            return "Error: `question` is required — it is what the classifier is being asked."

        key = os.environ.get("OPENROUTER_API_KEY", "")
        if not key:
            return (
                "Error: OPENROUTER_API_KEY is not set in this container, so the fast "
                "classifier is unavailable. Classify these items yourself instead."
            )

        floor = _floor() if min_confidence is None else float(min_confidence)
        body = build_request(items, labels, question)
        if body is None:
            return "Error: no usable items after trimming blanks."

        dropped = len(items) - len(body["questions"])
        sent = items[:len(body["questions"])]

        def post() -> Any:
            import httpx

            return httpx.post(provider_url("openrouter", _DECISIONS_PATH), headers={"Authorization": f"Bearer {key}"},
                              json=body, timeout=_TIMEOUT_S)

        t0 = time.monotonic()
        try:
            response = await asyncio.get_running_loop().run_in_executor(None, post)
        except Exception as err:  # noqa: BLE001 - the model can still do this itself
            return (
                f"Error: the fast classifier could not be reached ({str(err)[:150]}). "
                "Classify these items yourself instead."
            )
        elapsed = time.monotonic() - t0

        if response.status_code != 200:
            return (
                f"Error: the fast classifier returned HTTP {response.status_code}. "
                "Classify these items yourself instead."
            )

        rows = interpret(response.json(), sent, labels, floor)
        undecided = [r for r in rows if r["label"] == _UNDECIDED]
        counts: dict[str, int] = {}
        for row in rows:
            counts[row["label"]] = counts.get(row["label"], 0) + 1

        result: dict[str, Any] = {
            "classified": len(rows),
            "seconds": round(elapsed, 2),
            "counts": counts,
            "min_confidence": floor,
            "results": rows,
        }
        if undecided:
            result["note"] = (
                f"{len(undecided)} item(s) came back 'undecided' — the classifier was not "
                "confident enough. Read those yourself; do not use their best_guess as if "
                "it were a label."
            )
        if dropped:
            result["dropped"] = (
                f"{dropped} item(s) were not sent (blank, or past the {_MAX_BATCH}-item "
                "limit). Call again with the rest."
            )
        return json.dumps(result, indent=2)
