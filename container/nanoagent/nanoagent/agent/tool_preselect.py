"""Ask Jev which tools a task needs, before the big model has to go looking.

WHY

An agent owns 94 tools. 50 are advertised up front; the other 45 are hidden behind
`tool_search` to keep the prompt small — a good trade, with one cost that only shows up
in a trace. Reaching a hidden tool takes TWO model calls: one to ask for its schema, one
to use it. Measured on a live cycle 2026-09-21, each of those is 12-18 s carrying 35-40K
tokens, and `tool_search` ran twice before the agent could start work. That was ~28 s of
a 133 s cycle spent finding a tool rather than using it.

Picking one option from a fixed list, with a calibrated confidence, is exactly what Jev
does — the same shape as "which of these 46 page elements do I click", answered in
~0.35 s. So this asks Jev first and pre-activates what it names. The model then has the
tool in hand and never goes looking.

WHAT IT DOES NOT DO

It never removes or replaces anything. `tool_search` still exists and still works, so a
wrong guess costs a few hundred tokens of unused schema, never a turn and never a
capability. `none` is a real option, so declining is allowed and expected — most turns
need nothing from the hidden 45.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field

from loguru import logger
from nanoagent.providers.relay_url import provider_url

# Through the key relay when there is one (providers/relay_url.py, stage 64 phase 2).
_DECISIONS_PATH = "/alpha/decisions"
_MODEL = os.environ.get("JEV_MODEL", "~typesafe/jev-latest")
_TIMEOUT_S = 8.0

# Below this, the answer is not worth the tokens its schema would cost.
_MIN_CONFIDENCE = 0.8
# Options in one question. The 45 deferred tools fit comfortably; the cap is here so a
# future agent with hundreds cannot turn one look-ahead into a huge request.
_MAX_OPTIONS = 60
# One short line each. A tool's full description runs to paragraphs, and sending 45 of
# those would cost more than the call it is trying to save.
_DESC_CHARS = 110

_NONE = "none"


@dataclass
class Preselection:
    tools: list[str] = field(default_factory=list)
    confidence: float = 0.0
    seconds: float = 0.0
    skipped: str | None = None


def enabled() -> bool:
    """Read at call time so a cycle can turn it off without a rebuild.

    Empty means ON: `-e NANOCREW_JEV_TOOLS=` sets the variable to "", and reading that
    as "off" is the trap this codebase has hit four times now.
    """
    return os.environ.get("NANOCREW_JEV_TOOLS", "").strip().lower() not in ("off", "0", "false", "no")


def short_description(text: str) -> str:
    """The first sentence-ish of a tool's description, for the options list."""
    first = (text or "").strip().split("\n", 1)[0]
    return first[:_DESC_CHARS]


def task_text(messages: list[dict]) -> str:
    """What this turn is about: the last thing the user actually said.

    Deliberately not the whole context. Jev is answering "which tool does THIS need",
    and a transcript of previous work mostly adds noise about tools already used.
    """
    for message in reversed(messages or []):
        if message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return content[:1500]
        if isinstance(content, list):
            parts = [c.get("text", "") for c in content
                     if isinstance(c, dict) and c.get("type") == "text"]
            if parts:
                return " ".join(parts)[:1500]
    return ""


def build_request(task: str, candidates: dict[str, str]) -> dict | None:
    """The one request, or None when there is nothing to choose between."""
    options = dict(list(candidates.items())[:_MAX_OPTIONS])
    if not options or not task.strip():
        return None
    options[_NONE] = (
        "none of these — the task needs no tool beyond the ones already available"
    )
    return {
        "model": _MODEL,
        "state": {"task": task},
        "questions": {
            "tool": {
                "type": "choice",
                "instructions": (
                    "Which of these tools does this task need? These are tools NOT "
                    "currently loaded. Answer 'none' unless one is clearly required — "
                    "most tasks need none of them."
                ),
                "criteria": options,
            }
        },
    }


def preselect_sync(task: str, candidates: dict[str, str], api_key: str | None = None) -> Preselection:
    """One Jev call. Never raises: a failure here must cost nothing but its own latency."""
    import httpx

    if not enabled():
        return Preselection(skipped="turned off")
    key = api_key if api_key is not None else os.environ.get("OPENROUTER_API_KEY", "")
    if not key:
        return Preselection(skipped="no OPENROUTER_API_KEY")
    body = build_request(task, candidates)
    if body is None:
        return Preselection(skipped="nothing to choose between")

    t0 = time.monotonic()
    try:
        response = httpx.post(provider_url("openrouter", _DECISIONS_PATH), headers={"Authorization": f"Bearer {key}"},
                              json=body, timeout=_TIMEOUT_S)
        elapsed = time.monotonic() - t0
        if response.status_code != 200:
            return Preselection(seconds=elapsed, skipped=f"HTTP {response.status_code}")
        answer = (response.json().get("answers") or {}).get("tool") or {}
    except Exception as err:  # noqa: BLE001 - the model still has tool_search
        return Preselection(seconds=time.monotonic() - t0, skipped=str(err)[:120])

    choice = answer.get("choice")
    confidence = float(answer.get("confidence") or 0.0)
    if not choice or choice == _NONE:
        return Preselection(confidence=confidence, seconds=elapsed, skipped="answered none")
    if confidence < _MIN_CONFIDENCE:
        return Preselection(confidence=confidence, seconds=elapsed,
                            skipped=f"only {confidence:.2f} sure")
    if choice not in candidates:
        # Jev answered with something that is not on the list. Cannot happen with a
        # well-formed choice question, and is dropped rather than trusted if it does.
        return Preselection(confidence=confidence, seconds=elapsed, skipped="unknown tool named")
    return Preselection(tools=[choice], confidence=confidence, seconds=elapsed)


async def preselect(task: str, candidates: dict[str, str], api_key: str | None = None) -> Preselection:
    """preselect_sync off the event loop — one short-lived connection, as jev_policy does."""
    import asyncio

    return await asyncio.get_running_loop().run_in_executor(
        None, preselect_sync, task, candidates, api_key,
    )


async def activate_for(registry, messages: list[dict]) -> Preselection:
    """Pre-activate the tool this turn looks like it needs. Best-effort throughout.

    Returns what happened so the caller can log it — a preselection that never fires is
    worth noticing, and so is one that fires on every turn.
    """
    try:
        deferred = registry.deferred_names()
        if not deferred:
            return Preselection(skipped="deferral is off")
        candidates = registry.deferred_catalog()
        result = await preselect(task_text(messages), candidates)
        if result.tools:
            activated, unknown = registry.activate(result.tools)
            if activated:
                logger.info(
                    "Jev pre-loaded {} ({:.2f} sure, {:.0f} ms) — no tool_search needed",
                    ", ".join(activated), result.confidence, result.seconds * 1000,
                )
            if unknown:
                logger.debug("Jev named tools this agent does not have: {}", unknown)
        return result
    except Exception as err:  # noqa: BLE001
        logger.debug("tool preselection failed, carrying on — {}", err)
        return Preselection(skipped=str(err)[:120])
