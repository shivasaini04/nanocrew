"""Stage 49 phase 1 — the action ledger must record who actually authorised a step.

Before this, `action_log.build_log_entry` hardcoded `approval_status="auto-approved"`,
so the HMAC-signed ledger — the artifact you would reach for to prove who authorised a
real-world action — described a human-approved click and an ungated one identically.

Proven live 2026-09-02, prod cycle `e1c1aecc`: the "Send it →" click on example.com's
contact form blocked for 2m53s, `escalation_approvals.67e91616` recorded
`decided_by: operator`, and the ledger beside it said `auto-approved`.

Closing that also required splitting the gate's blanket "denied" return into four
outcomes, which is a safety change in its own right — see the fail-closed tests below.
"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.action_log import build_log_entry
from nanoagent.agent.effector.escalation import (
    APPROVAL_APPROVED,
    APPROVAL_DENIED,
    APPROVAL_TIMED_OUT,
    APPROVAL_UNAVAILABLE,
    is_approved,
    ledger_status,
)
from nanoagent.agent.effector.types import Step, StepResult


# ─── the four outcomes ────────────────────────────────────────────────────────

def test_ledger_status_names_a_human_approval_as_such():
    """The whole point: an approval a person sat and gave is not 'auto-approved'."""
    assert ledger_status(APPROVAL_APPROVED) == "human-approved"


@pytest.mark.parametrize("decision", [APPROVAL_DENIED, APPROVAL_TIMED_OUT, APPROVAL_UNAVAILABLE])
def test_ledger_status_keeps_every_blocked_outcome_distinct(decision):
    """A refusal, a timeout and an unreachable gate are three different events. The
    old ledger called all three 'auto-approved'; collapsing them back into one label
    would lose the distinction the phase exists to create."""
    assert ledger_status(decision) == decision


def test_ledger_status_of_a_missing_decision_never_claims_approval():
    assert ledger_status(None) == APPROVAL_UNAVAILABLE


# ─── fail-closed: the safety half of this change ──────────────────────────────

@pytest.mark.parametrize(
    "decision",
    [APPROVAL_DENIED, APPROVAL_TIMED_OUT, APPROVAL_UNAVAILABLE, None, "", "pending", "yes", "APPROVED"],
)
def test_only_an_exact_approval_is_approved(decision):
    """Adding outcomes to the gate is only safe if every call site tests for approval
    rather than for the string "denied". `is_approved` is that test, so it must be
    exact — "APPROVED" and "yes" are not approvals."""
    assert not is_approved(decision)


def test_is_approved_accepts_the_real_approval():
    assert is_approved(APPROVAL_APPROVED)


@pytest.mark.asyncio
async def test_a_timed_out_approval_does_not_execute_the_step():
    """The regression this phase could have introduced, and the bug it fixes.

    Every gate used to read `if decision == "denied"`. Once a timeout stopped being
    spelled "denied", that comparison would have fallen through and executed the very
    dangerous step the gate was guarding — a fail-OPEN gate. This asserts the step is
    skipped and `execute_step` is never reached.
    """
    from nanoagent.agent.effector.executor import ExecutorOptions, execute_steps

    class FakePage:
        url = "https://checkout.example/pay"

    executed: list[Step] = []

    async def never_runs(step, page, options=None):
        executed.append(step)
        return StepResult(step=step.step, status="success")

    async def times_out(step, agent_id, run_id, page, snapshot=None):
        return APPROVAL_TIMED_OUT

    step = Step(step=1, action="click", target="Confirm payment", is_dangerous=True)

    with patch("nanoagent.agent.effector.executor.request_approval", times_out), \
         patch("nanoagent.agent.effector.executor.execute_step", never_runs):
        results = await execute_steps([step], FakePage(), ExecutorOptions())

    assert executed == [], "a timed-out approval must never execute the step"
    assert results[0].status == "skipped"


# ─── what lands in the log ────────────────────────────────────────────────────

def test_an_ungated_step_is_still_recorded_as_auto_approved():
    """Not every step is gated, and for one no gate looked at 'auto-approved' is the
    honest label — the default has to stay."""
    entry = build_log_entry(
        Step(step=1, action="type", target="@e9", text="hello"),
        StepResult(step=1, status="success"),
        run_id="r1", agent_id="a1",
    )
    assert entry.approval_status == "auto-approved"


def test_a_human_approved_step_is_recorded_as_human_approved():
    entry = build_log_entry(
        Step(step=7, action="click", target="Send it →", is_dangerous=True),
        StepResult(step=7, status="success"),
        run_id="r1", agent_id="a1",
        approval_status=ledger_status(APPROVAL_APPROVED),
    )
    assert entry.approval_status == "human-approved"


def test_a_blocked_step_can_be_written_to_the_log():
    """A gate that leaves no trace when it fires is not an audit trail. The blocked
    step never reaches execute_step, so react_loop writes this entry itself."""
    entry = build_log_entry(
        Step(step=7, action="click", target="Confirm payment", is_dangerous=True),
        StepResult(step=7, status="skipped", error="blocked"),
        run_id="r1", agent_id="a1",
        approval_status=ledger_status(APPROVAL_TIMED_OUT),
    )
    assert entry.approval_status == APPROVAL_TIMED_OUT
    assert entry.result["status"] == "skipped"


def test_credential_redaction_still_holds_with_an_approval_status():
    """The new parameter must not disturb the existing redaction contract — a
    credential-bearing step still logs the marker, never the plaintext."""
    entry = build_log_entry(
        Step(step=2, action="type", target="@pw", text="hunter2", credential_ref="linkedin:password"),
        StepResult(step=2, status="success"),
        run_id="r1", agent_id="a1",
        approval_status=ledger_status(APPROVAL_APPROVED),
    )
    assert entry.action["text"] == "[CREDENTIAL_REDACTED]"
    assert "hunter2" not in json.dumps(entry.action)
