"""Danger-detection + human-takeover escalation for Effector.

`is_dangerous()` is fully ported and enforced. This docstring previously claimed the
safety property (a dangerous step never executes without a decision) "holds from day
one"; it did not, twice over, and both gaps are worth remembering rather than quietly
patching over. The gate first lived only in `execute_steps`, which react_loop never
calls (fixed 2026-08-23), and then matched its patterns against a raw "@e7" ref instead
of the element that ref names (fixed 2026-08-24 — see `danger_haystack`). Each time the
property was asserted in prose and untested on the path production actually takes.

The blocking round trip (agent pauses, a human actually decides, agent resumes) is
now real — stage43 gap-closing pass, 2026-08-23. Bridges to two new cycle-token-
authenticated routes on `self-manage.ts` (`POST`/`GET .../self/computer-use-
escalation`), which share the same `escalation.ts` pending-approvals state the
dashboard's owner-facing routes already used — this was the one piece left
unbuilt through all five phases. If the round trip is unreachable at all (no cycle
token — running outside a real cycle, or the orchestrator's unreachable), it fails
safe: denies and dispatches a webhook alert, same as before this pass — a
degraded mode, not silent bypass.

TS original: computer-use/escalation.ts.
"""

from __future__ import annotations

import asyncio
import os
import re

from loguru import logger

from nanoagent.agent.effector.types import Step

_DANGEROUS_ACTION_PATTERN = re.compile(
    r"delete|remove|cancel|submit|send|pay|confirm|purchase|checkout|transfer",
    re.IGNORECASE,
)

_POLL_INTERVAL_S = 3
# Must stay >= the TS-side APPROVAL_TIMEOUT_MS (escalation.ts), plus a margin for the
# poll interval. If this is the shorter of the two the agent gives up on an ask a
# human can still see and answer — the gate then denies a step that was about to be
# approved. Both sides default to 30 minutes; override together or not at all.
_MAX_WAIT_S = int(os.environ.get("APPROVAL_TIMEOUT_S", 30 * 60)) + 15

# Gate outcomes. Stage 49 phase 1: the ledger used to record every action as
# "auto-approved" (action_log.py), including ones a human sat and approved, so the
# one artifact meant to prove who authorised a real-world action was wrong every
# time. These distinguish the four ways a gated step can end.
#
# SAFETY: only APPROVAL_APPROVED may proceed. Call sites must test
# `is_approved(decision)` and never `decision == "denied"` — the latter fails OPEN
# for any value added later, which on this path means executing a dangerous action
# nobody approved. Every gate in this package is fail-closed by construction.
APPROVAL_APPROVED = "approved"
APPROVAL_DENIED = "denied"
APPROVAL_TIMED_OUT = "timed_out"
# The gate could not be reached at all (no cycle token, no httpx, orchestrator
# unreachable, registration rejected). Blocks exactly like a denial — it is only
# labelled apart so the ledger does not claim a human refused when nobody was asked.
APPROVAL_UNAVAILABLE = "unavailable"


def is_approved(decision: str | None) -> bool:
    """True only for an explicit human approval. Everything else blocks."""
    return decision == APPROVAL_APPROVED


def ledger_status(decision: str | None) -> str:
    """How a gated step's outcome is recorded in the action log."""
    return "human-approved" if is_approved(decision) else (decision or APPROVAL_UNAVAILABLE)

# Real bug, found live 2026-08-27: a click on demoqa.com's Submit button correctly got
# denied by this gate (no operator present on an unattended agent — fails
# safe). The model adapted: "press Enter on the Permanent Address field to
# submit" — same real-world effect, the form submitted, zero gate coverage,
# because is_dangerous() only ever checked click/double_click/select_combobox.
# Not a targeted exploit — the model just found the one action verb this file
# never looked at and used it because the click kept failing.
#
# The obvious narrow fix (check key's target text the same way click's is
# checked) doesn't actually close this: the Enter was pressed on the address
# FIELD, not the Submit button — the danger comes from the surrounding
# <form>'s implicit submit-on-Enter behavior, not from anything in the
# target's own accessible name. Text-matching the target can't see that.
# Deliberately broad instead: Enter/Return can activate a form's submit
# handler regardless of which field currently has focus, so it's gated
# unconditionally — same as an explicitly-flagged `is_dangerous` step, no
# haystack match required. Costs some false positives (a benign "press Enter
# to confirm a search box" now also needs approval on an unattended agent,
# same as the Submit click here did) — accepted deliberately: this file's own
# history is two prior "closes the gap" claims that didn't, and a caught
# false positive costs a denied step, while a missed true positive is
# exactly the unreviewed irreversible action this gate exists to prevent.
_ACTIVATION_KEYS = frozenset({"enter", "return"})

# Real bug, found live 2026-08-27 (test 5.1 of the manual capability suite): a
# click on saucedemo.com's "Checkout" button was correctly denied (no operator
# present) — logged in its own "thinking" step, the model's very next move was
# "The escalation gate is blocking the checkout button click. Let me try a
# different approach — navigate directly to the checkout page." It called
# `effector` again with the goal rewritten to `navigate` straight to
# https://www.saucedemo.com/checkout-step-one.html — same "checkout" substring
# that tripped the gate on the click, now sitting unchecked in a URL — and
# completed the ENTIRE purchase flow through to checkout-complete.html with
# zero further approval prompts. Not a targeted exploit: the model was just
# doing what every prior gap in this file taught it works — try the one verb
# is_dangerous() has never looked at. That verb was "navigate" this time.
# `danger_haystack` now folds step.url into what gets matched, so this is a
# plain keyword check like click/select_combobox — not the broad-unconditional
# treatment key got, because navigate's danger genuinely IS visible in a
# matchable string (a URL path), unlike an Enter keypress's.


def danger_haystack(step: Step, snapshot=None) -> str:
    """The text the danger patterns should be matched against for `step`.

    Correctness fix, 2026-08-24: a @ref carries none of its element's meaning. react_loop
    plans almost exclusively in refs — its own system prompt tells the model to prefer
    them — so matching the raw target meant checking the literal string "@e7" for the
    word "submit" and, of course, never finding it. Every ref-targeted click walked
    through the gate untouched, which is to say the gate almost never fired on the path
    every real run takes; only a raw CSS/text target ever tripped it. Passing the
    snapshot the step was planned against expands the ref back into the element's own
    accessible name, selector and value, which is what the patterns were written for.

    Without a snapshot this degrades to the old target-only behavior rather than
    raising — the callers that have no snapshot (execute_steps' static lists) are
    working with literal selectors, where the target IS the meaningful text."""
    parts = [step.target or "", step.text or "", step.description or "", step.url or "",
             step.script or ""]

    if snapshot is not None and step.target:
        from nanoagent.agent.effector.dom_snapshot import find_element_by_ref, is_ref_tag

        if is_ref_tag(step.target):
            element = find_element_by_ref(step.target, snapshot)
            if element is not None:
                parts += [element.name or "", element.selector or "", element.value or ""]

    return " ".join(p for p in parts if p)


# A field whose own name says it searches. Deliberately not "any input": the point is
# to recognise the one case where Enter is ordinary, not to open the gate generally.
_SEARCH_BOX_PATTERN = re.compile(
    r"\b(search|find|query|q)\b|searchbox|role=[\"']?search|type=[\"']?search",
    re.IGNORECASE,
)


def _looks_like_search_box(step: Step, snapshot=None) -> bool:
    """Is the Enter going into something that plainly searches?

    Matched against the element the ref names — its accessible name, selector and value
    — not the ref string, for the same reason danger_haystack exists at all.
    """
    return bool(_SEARCH_BOX_PATTERN.search(danger_haystack(step, snapshot)))


def is_dangerous(step: Step, snapshot=None) -> bool:
    """A step is dangerous if explicitly flagged, if it's a click/submit-shaped
    action against a target whose text suggests an irreversible/external effect,
    if it's an Enter/Return keypress (see _ACTIVATION_KEYS — unconditionally
    gated, not text-matched, since it can trigger a form's submit handler
    regardless of which field currently has focus), or if it's a `navigate`
    whose destination URL itself contains a dangerous keyword (a model blocked
    on a dangerous click can just navigate straight to the same place instead —
    confirmed live, 2026-08-27, test 5.1).

    Pass the DOM snapshot the step was planned against so a @ref target is checked
    against the element it names rather than the ref string — see danger_haystack."""
    if step.is_dangerous:
        return True
    # stage45 gap F. Accepting a confirm() is the consequential half of whatever raised
    # it — "Are you sure you want to delete this?" is the dialog, and saying yes is the
    # deletion. A dialog blocks the page until answered, so it cannot be escalated once
    # open (escalation._MAX_WAIT_S is thirty minutes and the page would hold). Gating
    # the ARMED STEP instead puts the same decision in front of a human before anything
    # runs, through this gate rather than a second one. See watchdogs.py.
    if step.accept_dialog:
        return True
    if step.action in ("click", "double_click"):
        if not step.target:
            return False
        return bool(_DANGEROUS_ACTION_PATTERN.search(danger_haystack(step, snapshot)))
    if step.action == "select_combobox":
        # God-level pillar 06: this action ends in a real click on whatever
        # option matched — the option being SELECTED (step.text, e.g. "Delete
        # my account") is exactly as dangerous-or-not as a plain click on that
        # same text would be. Check both target and text; the dangerous word
        # more often lives in the selected value than in the combobox's own
        # (usually generic) target/label.
        return bool(_DANGEROUS_ACTION_PATTERN.search(danger_haystack(step, snapshot)))
    if step.action == "key" and (step.key or "").strip().lower() in _ACTIVATION_KEYS:
        # ...except in a search box, where Enter searches. Found live 2026-09-21: a run
        # in the user's own browser was blocked pressing Enter after typing a song name,
        # failed, and the agent fell back to driving the page one slow action at a time.
        # Gating every Enter made searching — the commonest thing anyone does on a page —
        # need an operator.
        #
        # Narrow on purpose. It needs a NAMED target whose own accessible name, selector
        # or value says search; an Enter with no target, or into anything else, stays
        # gated, because then we genuinely do not know what has focus and a submit
        # handler could be behind it.
        if step.target and _looks_like_search_box(step, snapshot):
            return False
        return True
    if step.action == "browser_exec":
        # stage45 gap D, and the third instance of a shape this file already records
        # twice: a model blocked from clicking "Submit" navigated to the same place
        # instead (2026-08-27), and a model blocked from clicking pressed Enter on the
        # form instead (test 1.3, same day). Neither was a targeted exploit — each time
        # the model just used the verb the gate did not look at.
        #
        # `document.querySelector('#delete-account').click()` is that shape again, and
        # it would be the widest yet: one action able to express every other action. So
        # a script that ACTS on the world — activation, navigation, egress, cookies —
        # is gated exactly as the equivalent click would be, while a script that only
        # reads the page is not. See browser_exec.SCRIPT_DANGER_PATTERN; that list is
        # meant to be argued with rather than grown by reflex, and it is a speed bump
        # against a model talked into something, not a sandbox against an adversary.
        from nanoagent.agent.effector.browser_exec import is_dangerous_script

        if is_dangerous_script(step.script):
            return True
        # The ordinary word patterns still apply to the script text, so "transfer" or
        # "delete" in a script trips the same wire it would in a target.
        return bool(_DANGEROUS_ACTION_PATTERN.search(danger_haystack(step, snapshot)))
    if step.action == "navigate":
        # See the 2026-08-27 comment above _ACTIVATION_KEYS for the live failure
        # this closes: a click blocked by this gate is not a dead end for a model
        # that can also call `navigate` — it's a detour around it, straight to
        # the same URL a moment later.
        return bool(_DANGEROUS_ACTION_PATTERN.search(danger_haystack(step, snapshot)))
    return False


async def _notify(step: Step, agent_id: str, run_id: str, page, reason: str, extra_detail: str = "") -> None:
    try:
        from nanoagent.agent.effector.escalation_notifier import EscalationAlert, dispatch_escalation_alert
        domain = ""
        try:
            from urllib.parse import urlparse
            domain = urlparse(page.url).hostname or ""
        except Exception:
            pass
        await dispatch_escalation_alert(EscalationAlert(
            run_id=run_id, domain=domain, reason=reason,
            details=f"{step.action} on target {step.target!r}.{(' ' + extra_detail) if extra_detail else ''}",
        ))
    except Exception as err:
        logger.debug(f"effector: escalation notification failed — {err}")


async def _deny_and_notify(
    step: Step, agent_id: str, run_id: str, page, why: str, status: str = APPROVAL_UNAVAILABLE,
) -> str:
    logger.warning(f"effector: dangerous step denied ({why}) — agent={agent_id} run={run_id} action={step.action} target={step.target!r}")
    await _notify(step, agent_id, run_id, page, "CRITICAL_ACTION", why)
    return status


def _element_label(step: Step, snapshot=None) -> str:
    """A human-readable name for what the step is about to act on.

    The approval card is read by a person deciding whether to allow this, and
    `step.target` is usually a "@e7" ref — meaningless to them, and the same reason
    the danger patterns had to stop matching against it (see danger_haystack).
    Resolve the ref to the element's accessible name when a snapshot is available,
    and fall back to the raw target when it isn't."""
    if snapshot is not None and step.target:
        try:
            from nanoagent.agent.effector.dom_snapshot import find_element_by_ref, is_ref_tag

            if is_ref_tag(step.target):
                element = find_element_by_ref(step.target, snapshot)
                if element is not None:
                    label = (element.name or "").strip() or (element.selector or "").strip()
                    if label:
                        return label
        except Exception:  # noqa: BLE001 — a label is cosmetic; never block the gate on it
            pass
    return (step.target or "").strip()


async def request_approval(step: Step, agent_id: str, run_id: str, page, snapshot=None) -> str:
    """Request human approval for a dangerous step, blocking until a real decision
    arrives (or the round trip times out — see _MAX_WAIT_S, which tracks the TS-side
    APPROVAL_TIMEOUT_MS). Returns 'approved' or 'denied'.

    Pass the DOM snapshot the step was planned against so the human sees the element's
    real name rather than the "@e7" ref the model plans in.

    Fails safe outside a real cycle (no cycle token to authenticate the round trip
    with) — denies and still dispatches a webhook alert, rather than either
    silently allowing or hanging forever with nothing a human can act on.
    """
    host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
    token = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

    if not agent_id or agent_id == "unknown" or not token:
        return await _deny_and_notify(step, agent_id, run_id, page, "no cycle token — outside a real NanoCrew cycle")

    try:
        import httpx
    except ImportError:
        return await _deny_and_notify(step, agent_id, run_id, page, "httpx not installed")

    base = f"{host}/api/agents/{agent_id}/self/computer-use-escalation"
    headers = {"Authorization": f"Bearer {token}"}
    element = _element_label(step, snapshot)
    body = {
        "runId": run_id, "action": step.action, "target": step.target,
        "element": element, "url": step.url,
        "description": step.description or f"{step.action} {element or step.target or ''}".strip(),
    }

    try:
        async with httpx.AsyncClient() as client:
            create_resp = await client.post(base, json=body, headers=headers, timeout=10)
        if create_resp.status_code >= 400:
            return await _deny_and_notify(step, agent_id, run_id, page, f"escalation registration failed (HTTP {create_resp.status_code})")
        approval_id = create_resp.json().get("approvalId")
        if not approval_id:
            return await _deny_and_notify(step, agent_id, run_id, page, "escalation registration returned no approvalId")
    except Exception as err:
        return await _deny_and_notify(step, agent_id, run_id, page, f"could not reach orchestrator: {err}")

    logger.info(f"effector: blocked on human takeover — agent={agent_id} run={run_id} approval_id={approval_id}, waiting up to {_MAX_WAIT_S}s")
    await _notify(step, agent_id, run_id, page, "CRITICAL_ACTION", f"Waiting for a human decision (approval_id={approval_id}).")

    elapsed = 0
    poll_url = f"{base}/{approval_id}"
    while elapsed < _MAX_WAIT_S:
        await asyncio.sleep(_POLL_INTERVAL_S)
        elapsed += _POLL_INTERVAL_S
        try:
            async with httpx.AsyncClient() as client:
                poll_resp = await client.get(poll_url, headers=headers, timeout=10)
            if poll_resp.status_code >= 400:
                continue  # transient — keep polling until the outer timeout
            decision = poll_resp.json().get("decision")
        except Exception as err:
            logger.debug(f"effector: escalation poll failed, retrying — {err}")
            continue

        if decision in ("approved", "denied"):
            logger.info(f"effector: human decision received — agent={agent_id} approval_id={approval_id} decision={decision}")
            return decision
        if decision == "not_found":
            # Already resolved and cleaned up by a prior poll, or genuinely expired
            # server-side — either way there's nothing left to wait for.
            return APPROVAL_DENIED
        # 'pending' — keep waiting.

    logger.warning(f"effector: human takeover timed out after {_MAX_WAIT_S}s — agent={agent_id} approval_id={approval_id}")
    return APPROVAL_TIMED_OUT


# `request_human_takeover` lived here until 2026-09-03 and was a misnomer from the day it
# was written: it wrapped the reason in a synthetic Step and called request_approval, so
# it was an approve/deny round trip in which no human ever touched a browser. For its own
# headline example — a CAPTCHA — approving it achieved nothing at all.
#
# Real takeover is stage 49 phase 5.4: a `takeover` action inside the ReAct loop, where
# the page is still open, the run parks, and a person actually drives. It had to live
# there rather than in a tool, because an outer-loop tool runs after the effector session
# has closed and there is no browser left to hand over — the same wall `clarify` hit in
# phase 3. Removed with its tool rather than left to be found and trusted by its name.
