"""Real bug found live, 2026-08-27, while confirming the Xvfb/DISPLAY fix
(browser_session.py, commit c0e35e7) via the manual capability test suite's
test 0.2: a click on demoqa.com's "Forms" homepage card resolved and dispatched
fine but had zero observable effect (the page never navigated — almost
certainly the site's known ad-overlay intercepting the click). Turn 1 recorded
it into the checkpoint's idempotency ledger as "executed" anyway (dispatching
without error is all execute_step checks). Every identical retry on turns 2,
3, 5, 6, 7 of the SAME live run was then silently vetoed by
is_action_already_executed — not attempted, not reported as a no-op, just
`status: "skipped"` with no signal telling the model *why* nothing was
happening. Mechanic gave up after 6 skipped turns and, on its next tool call,
worked around the actual capability being tested instead of exercising it —
see docs/research/digital-employee-engine/test/00-sanity.md's 0.2 scorecard.

Root cause: is_action_already_executed's own module docstring says its job is
"the same click/type resolved from a RESUMED run never fires twice" — i.e.
protect against re-firing an action from a PRIOR PROCESS ATTEMPT after a
crash+resume. The implementation didn't actually scope itself to that: it
checked the checkpoint's whole, continuously-growing ledger, which also
includes actions recorded earlier in the SAME live process's own current run —
so a live model's legitimate in-run retry of something that visibly didn't
work got treated identically to a genuine resumed-run duplicate.

Fix: `checkpoint.py`'s `is_action_already_executed` now takes an explicit
`prior_keys` parameter — the ledger snapshotted once, at load time, before this
process's own turns begin (`react_loop.py`'s `checkpoint_prior_keys`). Empty
for a fresh run (so nothing this run recorded can block a later retry within
the same run), the persisted ledger for a genuinely resumed one (so real
resume-duplication protection is untouched). `prior_keys=None` (the default)
preserves the old, whole-ledger behavior for direct/unit-level callers that
don't run the full react_loop integration — see test_effector_phase1.py's
and test_effector_phase12_idempotency_ref_recycling.py's existing tests,
unchanged by this fix.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.resilience.checkpoint import (
    RunCheckpoint,
    is_action_already_executed,
    record_executed_action,
)
from nanoagent.agent.effector.types import Step

from test_effector_phase0 import FakePage


# ─── Unit level: is_action_already_executed respects prior_keys ────────────────

def test_prior_keys_empty_means_nothing_this_run_recorded_can_block_a_retry():
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#forms-card")

    record_executed_action(checkpoint, step, "https://demoqa.com/")  # turn 1's record

    # Fresh run: prior_keys is empty (nothing existed before this process started).
    assert is_action_already_executed(checkpoint, step, "https://demoqa.com/", prior_keys=frozenset()) is False


def test_prior_keys_containing_the_action_still_blocks_a_genuine_resumed_duplicate():
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#forms-card")

    from nanoagent.agent.effector.resilience.checkpoint import compute_idempotency_key
    key = compute_idempotency_key(step, checkpoint.run_id, "https://demoqa.com/")

    # Resumed run: prior_keys is the ledger as it was BEFORE this process started.
    assert is_action_already_executed(
        checkpoint, step, "https://demoqa.com/", prior_keys=frozenset({key}),
    ) is True


def test_prior_keys_none_preserves_the_old_whole_ledger_check():
    """Backward compatibility for direct callers (see test_effector_phase1.py,
    test_effector_phase12_idempotency_ref_recycling.py, test_effector_phase16_
    atomic_combobox.py) that don't pass prior_keys at all."""
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#forms-card")
    record_executed_action(checkpoint, step, "https://demoqa.com/")

    assert is_action_already_executed(checkpoint, step, "https://demoqa.com/") is True


# ─── Integration level: execute_step actually re-attempts within a live run ────

@pytest.mark.asyncio
async def test_execute_step_retries_a_same_run_click_that_had_no_effect():
    """The exact bug scenario: turn 1's click was recorded, the page never
    changed, and the model (correctly) wants to try again on turn 2. Before the
    fix this returned status="skipped" without even dispatching. After the fix,
    with checkpoint_prior_keys empty (a fresh run), the click actually fires."""
    page = FakePage()
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#submit")  # a real element in FakePage
    record_executed_action(checkpoint, step, page.url)  # simulates turn 1 already having run

    opts = ExecutorOptions(
        checkpoint=checkpoint, checkpoint_prior_keys=frozenset(), require_approval=False,
    )
    result = await execute_step(step, page, opts)

    assert result.status == "success"  # actually attempted, not silently skipped
    assert page.actions == [("click", "#submit")]  # dispatched for real


@pytest.mark.asyncio
async def test_execute_step_still_skips_a_genuine_resumed_duplicate():
    """The flip side, so the fix doesn't overcorrect: an action that was already
    recorded in a PRIOR process attempt (present in checkpoint_prior_keys, the
    ledger as it existed before this process's own turns began) must still be
    skipped, not re-fired — that's the actual resume-safety guarantee."""
    page = FakePage()
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#submit")
    record_executed_action(checkpoint, step, page.url)

    from nanoagent.agent.effector.resilience.checkpoint import compute_idempotency_key
    key = compute_idempotency_key(step, checkpoint.run_id, page.url)

    opts = ExecutorOptions(
        checkpoint=checkpoint, checkpoint_prior_keys=frozenset({key}), require_approval=False,
    )
    result = await execute_step(step, page, opts)

    assert result.status == "skipped"
    assert page.actions == []  # never dispatched — genuine duplicate stays blocked


@pytest.mark.asyncio
async def test_execute_step_defaults_to_the_old_strict_behavior_when_prior_keys_unset():
    """A caller that doesn't set checkpoint_prior_keys at all (the pre-fix
    ExecutorOptions default) must see zero behavior change from before."""
    page = FakePage()
    checkpoint = RunCheckpoint(run_id="run-1", agent_id="agent-1", goal="click the forms card")
    step = Step(step=1, action="click", target="#submit")
    record_executed_action(checkpoint, step, page.url)

    opts = ExecutorOptions(checkpoint=checkpoint, require_approval=False)  # checkpoint_prior_keys=None
    result = await execute_step(step, page, opts)

    assert result.status == "skipped"
    assert page.actions == []
