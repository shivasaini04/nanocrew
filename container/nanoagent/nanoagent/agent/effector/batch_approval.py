"""Approved batches of sends on the user's own browser (stage 60 phase 3).

## The problem

Sending ten LinkedIn connection notes from the user's browser used to mean:

  * a hard ceiling of 3 external actions per browser task — and a `navigate` counted,
    so opening three profiles used the whole budget before anything was sent;
  * a separate approval card for every "Send" click (the danger gate);
  * a `takeover` pause before the first send, on top of both.

The person approved the same intent a dozen times, and the agent spent its budget on
reading.

## The shape now

The agent shows the whole list once — who, and the exact text — through
`request_batch_approval`. The orchestrator enforces a per-site daily limit on what can
be approved, and the person approves the list in the chat. From then on (for two hours,
across chat messages), that many send-shaped clicks on that site go through without
another card.

A grant covers *sending*: the words the danger gate treats as money or destruction —
pay, purchase, checkout, transfer, delete, remove, cancel — are never covered by it and
still ask every time.

## Not a security boundary

This is state inside the agent's own process. An agent that wanted to lie to itself
could. It exists so an honest agent stops asking the same question ten times and a
confused one still runs out of approved sends — the same "backstop, not the control"
role `_MAX_IDENTITY_ACTIONS` had. The control is the person reading the list, and the
daily limit, which lives on the orchestrator where the agent cannot touch it.
"""

from __future__ import annotations

import os
import re
import threading
import time
from dataclasses import dataclass, field
from urllib.parse import urlparse

# What a batch approval may cover. Everything else the danger gate matches keeps
# asking per action, batch or no batch.
_NEVER_COVERED = re.compile(r"pay|purchase|checkout|transfer|delete|remove|cancel", re.IGNORECASE)

# How long an approval stays usable. Every chat message is its own run, so an approval
# given in one message must still hold when the next message says "go on" — but not
# tomorrow, when the person has forgotten what they approved. The warm daemon is
# per-agent, so a grant never crosses to another agent.
GRANT_TTL_S = int(os.environ.get("BATCH_APPROVAL_TTL_S", 2 * 60 * 60))


@dataclass
class Grant:
    site: str
    batch_id: str
    approved: int
    used: int = 0
    items: list[dict] = field(default_factory=list)
    granted_at: float = field(default_factory=time.time)

    @property
    def remaining(self) -> int:
        if time.time() - self.granted_at > GRANT_TTL_S:
            return 0
        return max(0, self.approved - self.used)


_lock = threading.Lock()
_grants: dict[str, Grant] = {}


def site_of(url_or_host: str | None) -> str:
    """'https://www.linkedin.com/in/x' -> 'linkedin.com'. Empty string when unknown."""
    raw = (url_or_host or "").strip().lower()
    if not raw:
        return ""
    host = urlparse(raw).hostname if "://" in raw else raw.split("/")[0]
    host = (host or "").strip(".")
    parts = host.split(".")
    # Last two labels is right for linkedin.com, x.com, mail.google.com -> google.com.
    # Wrong for .co.uk-style suffixes, where it errs toward a BROADER site — acceptable
    # for a counter whose only job is to stop asking the same question twice.
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def grant(site: str, batch_id: str, approved: int, items: list[dict] | None = None) -> Grant:
    """Record an approval. A new batch for a site replaces the old one."""
    g = Grant(site=site_of(site), batch_id=batch_id, approved=max(0, int(approved)), items=list(items or []))
    with _lock:
        _grants[g.site] = g
    return g


def active(site: str) -> Grant | None:
    with _lock:
        g = _grants.get(site_of(site))
        return g if g and g.remaining > 0 else None


def covers(action_text: str) -> bool:
    """Can a batch approval stand in for the per-action gate on this action?"""
    return not _NEVER_COVERED.search(action_text or "")


def consume(site: str, action_text: str) -> Grant | None:
    """Use one approved send on `site`, if one is left and the action is coverable."""
    if not covers(action_text):
        return None
    with _lock:
        g = _grants.get(site_of(site))
        if not g or g.remaining <= 0:
            return None
        g.used += 1
        return g


def total_remaining() -> int:
    with _lock:
        return sum(g.remaining for g in _grants.values())


def clear() -> None:
    """Forget every grant (tests)."""
    with _lock:
        _grants.clear()


def prompt_note() -> str:
    """What the browser agent is told about approved sends, or '' when there are none."""
    with _lock:
        live = [g for g in _grants.values() if g.remaining > 0]
    if not live:
        return ""
    lines = ["", "APPROVED SENDS — the user already approved these in the chat:"]
    for g in live:
        lines.append(f"- {g.site}: {g.remaining} of {g.approved} sends left (batch {g.batch_id[:8]}).")
        for it in g.items[: g.approved]:
            who = str(it.get("to") or it.get("who") or "").strip()
            text = str(it.get("text") or "").strip()
            if who or text:
                lines.append(f"    · {who}: \"{text[:160]}\"")
    lines.append(
        "Send exactly these — same people, same words — without using takeover to ask "
        "again. Anything NOT on this list still needs asking first."
    )
    return "\n".join(lines)
