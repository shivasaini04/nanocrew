"""Stage 61 — TypeSafe Jev as Effector's per-step decider, via OpenRouter.

Jev does not generate text. It answers typed questions about a state and returns
calibrated probabilities (`POST /api/alpha/decisions`, model `~typesafe/jev-latest`).
That is exactly the shape of a browser step: which operation, and on which element.

The request follows Browser Use's `jev-ultrafast` pattern — operation and one target
head per operation in ONE request (speculative fan-out), then the head matching the
chosen operation is the one that executes. Two decisions, one round trip.

What Jev cannot do stays with the LLM: the text to type, a `browser_exec` script, an
extract schema, and anything the loop escalates. This module only answers "what next,
and on what".

Cost and latency come back on every call, so the caller can log what a step really cost.
"""

from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from loguru import logger
from nanoagent.providers.relay_url import provider_url

# Through the key relay when there is one (providers/relay_url.py, stage 64 phase 2).
_DECISIONS_PATH = "/alpha/decisions"
_MODEL = os.environ.get("JEV_MODEL", "~typesafe/jev-latest")
_TIMEOUT_S = 20.0
# Elements per target head. Jev Ultrafast sends the whole visible table; this caps the
# request so one enormous page cannot blow up latency or cost.
_MAX_OPTIONS = 60

# The operations Jev may choose. Everything else (browser_exec, extract, download,
# upload, takeover, select) needs text, a script or judgement and stays with the LLM —
# "other" is Jev's way of handing the turn over rather than guessing.
OPERATIONS: dict[str, str] = {
    "click": "click an element: a link, a button, a checkbox, a menu entry",
    "type": "type text into an input, textarea or search box",
    "select_combobox": "choose an option from a dropdown that filters as you type",
    "scroll": "scroll down to reveal more of the page",
    "wait": "wait for the page to finish loading or changing",
    "done": "the goal is already achieved on this page; stop",
    "other": "something else is needed: run a script, extract structured data, download a file, or ask a person",
}

_EL_RE = re.compile(r"^\s*\[(@e\d+)\]\s*(.*?)\s*(?:\(center:[^)]*\))?\s*$")
# Elements that can receive typing. Matched on the role words the DOM snapshot prints.
_TYPEABLE = re.compile(r"\b(input|textarea|textbox|searchbox|combobox|editable|contenteditable)\b", re.IGNORECASE)


@dataclass
class JevDecision:
    action: str
    target: str | None
    action_confidence: float
    target_confidence: float | None
    probabilities: dict[str, float] = field(default_factory=dict)
    seconds: float = 0.0
    cost: float = 0.0
    model: str = ""
    error: str | None = None


def parse_elements(summary: str) -> list[tuple[str, str]]:
    """(@ref, description) for every element in a snapshot summary."""
    out: list[tuple[str, str]] = []
    for line in (summary or "").splitlines():
        m = _EL_RE.match(line)
        if m:
            out.append((m.group(1), m.group(2)[:110]))
    return out


def _criteria(elements: list[tuple[str, str]]) -> dict[str, str]:
    return {ref: desc or "unlabelled element" for ref, desc in elements[:_MAX_OPTIONS]}


def page_text(summary: str) -> str:
    """What the page SAYS, with its controls removed.

    The snapshot summary is a header, then one line per interactive element, then the
    visible text. Sending the whole thing as `state.page` while ALSO sending the
    elements as criteria meant Jev read every control two or three times: once in the
    page, once in `click_target`, and again in `type_target`.

    Measured 2026-09-20: identical requests to the same model took 384 ms for us and
    178 ms for browser-use's `jev-ultrafast`, which sends the element table once. The
    difference was payload, not model.
    """
    keep, skipped = [], False
    for line in (summary or "").splitlines():
        if _EL_RE.match(line):
            skipped = True
            continue
        if line.strip() == "Interactive Elements:":
            skipped = True
            continue
        keep.append(line)
    text = "\n".join(keep)
    if skipped:
        # Collapse the blank run left where the element block was.
        text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def build_request(goal: str, summary: str, recent_actions: str, url: str = "") -> dict[str, Any] | None:
    """The one request, or None when the page has nothing to act on."""
    elements = parse_elements(summary)
    if not elements:
        return None
    typeable = [(r, d) for r, d in elements if _TYPEABLE.search(d)]

    questions: dict[str, Any] = {
        "operation": {
            "type": "choice",
            "instructions": "What single operation moves this goal forward from the page as it is now?",
            "criteria": OPERATIONS,
        },
        "click_target": {
            "type": "choice",
            "instructions": "Assuming the next operation is a click, which element should be clicked?",
            "criteria": _criteria(elements),
        },
    }
    if typeable:
        questions["type_target"] = {
            "type": "choice",
            "instructions": "Assuming the next operation is typing, which field should receive the text?",
            "criteria": _criteria(typeable),
        }
    return {
        "model": _MODEL,
        "state": {
            "goal": goal,
            "url": url,
            # The page's TEXT, not its controls — the controls are the criteria below.
            # See page_text() for why sending both cost us 2x the latency.
            "page": page_text(summary)[:6000],
            "element_count": len(elements),
            "recent_actions": recent_actions[:1500] or "none yet",
        },
        "questions": questions,
    }


def _answer(answers: dict[str, Any], key: str) -> tuple[str | None, float, dict[str, float]]:
    a = answers.get(key) or {}
    if a.get("type") != "choice":
        return None, 0.0, {}
    return a.get("choice"), float(a.get("confidence") or 0.0), dict(a.get("probabilities") or {})


def decide_sync(goal: str, summary: str, recent_actions: str, url: str = "",
                api_key: str | None = None) -> JevDecision:
    """One Jev decision. Never raises — an error comes back on the decision so the
    caller falls back to the LLM rather than failing the turn."""
    import httpx

    key = api_key if api_key is not None else os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        return JevDecision("other", None, 0.0, None, error="no OPENROUTER_API_KEY")
    body = build_request(goal, summary, recent_actions, url)
    if body is None:
        return JevDecision("other", None, 0.0, None, error="no elements on the page")

    t0 = time.monotonic()
    try:
        r = httpx.post(provider_url("openrouter", _DECISIONS_PATH), headers={"Authorization": f"Bearer {key}"}, json=body, timeout=_TIMEOUT_S)
        elapsed = time.monotonic() - t0
        if r.status_code != 200:
            return JevDecision("other", None, 0.0, None, seconds=elapsed,
                               error=f"HTTP {r.status_code}: {r.text[:200]}")
        payload = r.json()
    except Exception as err:  # noqa: BLE001
        return JevDecision("other", None, 0.0, None, seconds=time.monotonic() - t0, error=str(err)[:200])

    answers = payload.get("answers") or {}
    op, op_conf, op_probs = _answer(answers, "operation")
    if not op:
        return JevDecision("other", None, 0.0, None, seconds=elapsed, error="no operation in the answer")

    target, target_conf = None, None
    if op == "click":
        target, target_conf, _ = _answer(answers, "click_target")
    elif op in ("type", "select_combobox"):
        target, target_conf, _ = _answer(answers, "type_target")
        if target is None:  # no typeable field was offered
            target, target_conf, _ = _answer(answers, "click_target")

    return JevDecision(
        action=op, target=target, action_confidence=op_conf, target_confidence=target_conf,
        probabilities=op_probs, seconds=elapsed,
        cost=float((payload.get("usage") or {}).get("cost") or 0.0),
        model=str(payload.get("model") or ""),
    )


async def decide(goal: str, summary: str, recent_actions: str, url: str = "",
                 api_key: str | None = None) -> JevDecision:
    """decide_sync off the event loop — httpx here is blocking on purpose: one call, one
    short-lived connection, and no async client to keep alive across a cycle."""
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(
        None, decide_sync, goal, summary, recent_actions, url, api_key,
    )
