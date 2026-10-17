"""stage45 gap F: the two watchdogs — `effector/watchdogs.py`.

Both holes `01-gaps.md` named are about *invisibility*, not about the browser
misbehaving, so that is what these tests are about.

**Crash.** `resilience/checkpoint.py` could already resume an interrupted run. But
`list_interrupted_checkpoints()` returns status in ("running", "paused", "takeover"),
and the loop's only failure status was "failed" — so a crash, the one failure resume
exists for, wrote the single status that made the run unresumable. The recovery
machinery was complete and unreachable.

**Dialogs.** A dismissed `confirm()` cancels the action that raised it, and the page
then looks untouched. The loop saw "click -> success" over an unchanged page and the
model clicked again.

Not tested here: that Chromium actually emits `page.on("crash")`, and that a real
`confirm()` blocks a real page. Both are in the live harness — see
`docs/research/stage45/08-watchdogs.md`.
"""

from __future__ import annotations

import asyncio

import pytest

from nanoagent.agent.effector.escalation import is_dangerous
from nanoagent.agent.effector.types import Step
from nanoagent.agent.effector.watchdogs import (
    CrashWatchdog,
    DialogWatchdog,
    looks_like_a_dead_browser,
)


# ── fakes ────────────────────────────────────────────────────────────────────


class FakeDialog:
    def __init__(self, dialog_type="confirm", message="Are you sure?"):
        self.type = dialog_type
        self.message = message
        self.outcome: str | None = None

    async def accept(self, *_a):
        self.outcome = "accepted"

    async def dismiss(self):
        self.outcome = "dismissed"


class FakeEmitter:
    """Anything with .on() — a page, a context, a browser."""

    def __init__(self, supported=("crash", "close", "disconnected")):
        self.handlers: dict[str, list] = {}
        self.supported = supported

    def on(self, event, handler):
        if event not in self.supported:
            raise ValueError(f"unsupported event {event}")
        self.handlers.setdefault(event, []).append(handler)

    def emit(self, event, *args):
        for h in self.handlers.get(event, []):
            h(*args)


# ── dialogs: the default stays safe ──────────────────────────────────────────


def test_a_confirm_is_dismissed_when_nothing_reviewed_an_accept():
    """The old handler's reasoning, preserved: there is no reviewed decision behind an
    accept, so dismiss is the only safe default."""
    w = DialogWatchdog()
    d = FakeDialog("confirm", "Delete this account?")
    asyncio.run(w.handle(d))
    assert d.outcome == "dismissed"


def test_an_alert_is_still_accepted_because_there_is_nothing_to_decide():
    w = DialogWatchdog()
    d = FakeDialog("alert", "Saved.")
    asyncio.run(w.handle(d))
    assert d.outcome == "accepted"


@pytest.mark.parametrize("kind", ["confirm", "prompt", "beforeunload"])
def test_every_consequential_dialog_type_is_dismissed_by_default(kind):
    w = DialogWatchdog()
    d = FakeDialog(kind, "well?")
    asyncio.run(w.handle(d))
    assert d.outcome == "dismissed"


# ── dialogs: the visibility that was missing ─────────────────────────────────


def test_a_dismissed_dialog_is_recorded_so_the_loop_can_tell_the_model():
    """The actual gap. Without this the model sees an unchanged page and no reason for
    it, so it retries the same click forever."""
    w = DialogWatchdog()
    asyncio.run(w.handle(FakeDialog("confirm", "Delete this account?")))

    drained = w.drain()
    assert len(drained) == 1
    assert drained[0].to_dict() == {
        "type": "confirm",
        "message": "Delete this account?",
        "action": "dismissed",
        "armed": False,
    }


def test_drain_returns_only_what_is_new_since_the_last_drain():
    """The loop drains per step, so a dialog is reported on the turn it happened rather
    than re-reported on every later turn."""
    w = DialogWatchdog()
    asyncio.run(w.handle(FakeDialog("confirm", "one")))
    assert [d.message for d in w.drain()] == ["one"]
    assert w.drain() == []

    asyncio.run(w.handle(FakeDialog("confirm", "two")))
    assert [d.message for d in w.drain()] == ["two"]
    assert len(w.records()) == 2


def test_a_page_looping_dialogs_cannot_grow_the_record_without_bound():
    w = DialogWatchdog()
    for i in range(400):
        asyncio.run(w.handle(FakeDialog("confirm", f"m{i}")))
    assert len(w.records()) == 200
    assert w.records()[-1].message == "m399"


def test_a_handler_that_would_throw_never_escapes():
    """A raise out of the dialog callback leaves the page blocked forever."""
    class Exploding(FakeDialog):
        async def dismiss(self):
            raise RuntimeError("already handled")

    w = DialogWatchdog()
    asyncio.run(w.handle(Exploding()))  # must not raise


# ── dialogs: the reviewed way to say yes ─────────────────────────────────────


def test_an_armed_watchdog_accepts_and_says_it_was_armed():
    w = DialogWatchdog()
    w.arm()
    d = FakeDialog("confirm", "Delete this account?")
    asyncio.run(w.handle(d))

    assert d.outcome == "accepted"
    assert w.drain()[0].armed is True


def test_arming_is_dangerous_so_a_human_reviews_it_first():
    """Accepting a confirm() is the consequential half of whatever raised it. The gate
    cannot run when the dialog is already open — the page is blocked and
    escalation._MAX_WAIT_S is thirty minutes — so the ARMED STEP is what gets gated."""
    armed = Step(step=1, action="click", target="@e1", accept_dialog=True)
    plain = Step(step=1, action="click", target="@e1")
    assert is_dangerous(armed) is True
    assert is_dangerous(plain) is False


def test_disarm_stops_the_next_dialog_being_accepted():
    w = DialogWatchdog()
    w.arm()
    w.disarm()
    d = FakeDialog("confirm", "Delete?")
    asyncio.run(w.handle(d))
    assert d.outcome == "dismissed"


def test_the_executor_disarms_even_when_the_step_blows_up():
    """An arming that survived a failed step would accept the NEXT step's dialog —
    one nobody reviewed. That is exactly what dismiss-by-default exists to prevent, so
    the disarm is in a finally."""
    from nanoagent.agent.effector.executor import ExecutorOptions, execute_step

    class ExplodingPage:
        url = "https://example.test/"

        def locator(self, *_a, **_kw):
            raise RuntimeError("boom")

    w = DialogWatchdog()
    opts = ExecutorOptions(require_approval=False, dialog_watchdog=w)
    result = asyncio.run(
        execute_step(
            Step(step=1, action="click", target="#nope", accept_dialog=True),
            ExplodingPage(), opts,
        )
    )
    assert result.status == "failed"
    assert w.armed is False


def test_a_dialog_during_a_step_reaches_the_step_result():
    """How the model finds out. The executor drains into the step's data."""
    from nanoagent.agent.effector.executor import ExecutorOptions, execute_step

    w = DialogWatchdog()

    class PageThatAsks:
        url = "https://example.test/"

        def locator(self, *_a, **_kw):
            raise RuntimeError("nothing to click")

    asyncio.run(w.handle(FakeDialog("confirm", "Delete?")))
    w.drain()  # the loop already reported that one

    opts = ExecutorOptions(require_approval=False, dialog_watchdog=w)
    asyncio.run(w.handle(FakeDialog("confirm", "Really delete?")))
    result = asyncio.run(
        execute_step(Step(step=1, action="wait", duration=0), PageThatAsks(), opts)
    )
    assert result.data["dialogs"][0]["message"] == "Really delete?"


# ── crash: detection ─────────────────────────────────────────────────────────


def test_the_watchdog_binds_what_it_is_given_and_says_how_much():
    """`attached_to` exists because a watchdog that silently bound nothing looks exactly
    like one that never saw a crash."""
    w = CrashWatchdog()
    page, context, browser = FakeEmitter(), FakeEmitter(("close",)), FakeEmitter(("disconnected",))
    bound = w.attach(page=page, context=context, browser=browser)
    assert bound == 4
    assert w.attached_to == [
        "page.crash", "page.close", "context.close", "browser.disconnected",
    ]
    assert w.crashed is False


def test_an_unsupported_event_is_skipped_rather_than_fatal():
    """Engines differ, and a missing event must not take the session down."""
    w = CrashWatchdog()
    assert w.attach(page=FakeEmitter(supported=())) == 0
    assert w.attached_to == []


def test_attaching_to_nothing_is_fine():
    assert CrashWatchdog().attach() == 0


@pytest.mark.parametrize("source,event", [("page", "crash"), ("page", "close")])
def test_a_crash_event_is_noticed(source, event):
    w = CrashWatchdog()
    page = FakeEmitter()
    w.attach(page=page)
    page.emit(event)
    assert w.crashed is True
    assert w.reason == f"{source}.{event}"


def test_the_first_event_wins_because_a_crash_cascades():
    """renderer dies -> page closes -> context closes. The first one describes what
    actually happened; the rest are consequences."""
    w = CrashWatchdog()
    page = FakeEmitter()
    w.attach(page=page)
    page.emit("crash")
    page.emit("close")
    assert w.reason == "page.crash"


@pytest.mark.parametrize(
    "message",
    [
        "Target crashed",
        "Target closed",
        "Browser has been closed",
        "page has been closed",
        "Protocol error: Connection closed",
    ],
)
def test_playwrights_own_words_for_a_dead_browser_are_recognised(message):
    """The second opinion. An event can be missed — registered after the fact, or an
    engine that does not emit it — while the very next call still fails with this text,
    and mistaking a dead browser for a bad page is what marks a resumable run
    unresumable."""
    assert looks_like_a_dead_browser(RuntimeError(message)) is True


@pytest.mark.parametrize(
    "message",
    [
        "Timeout 30000ms exceeded waiting for selector '#submit'",
        "strict mode violation: locator resolved to 3 elements",
        "net::ERR_NAME_NOT_RESOLVED",
        "ReferenceError: foo is not defined",
    ],
)
def test_an_ordinary_page_problem_is_not_a_dead_browser(message):
    """The expensive direction to get wrong: calling a normal failure a crash would
    park runs as 'resumable' that should have been reported as failed."""
    assert looks_like_a_dead_browser(RuntimeError(message)) is False


def test_note_records_a_crash_seen_some_other_way():
    w = CrashWatchdog()
    w.note("exception: Target crashed")
    assert w.crashed is True
    w.note("something later")
    assert w.reason == "exception: Target crashed"


# ── crash: the status that made resume unreachable ───────────────────────────


def test_paused_is_resumable_and_failed_is_not():
    """The fact the whole crash half turns on. If this ever changes, the loop's choice
    of "paused" for a crash needs to change with it."""
    from nanoagent.agent.effector.resilience.checkpoint import list_interrupted_checkpoints
    import inspect

    src = inspect.getsource(list_interrupted_checkpoints)
    assert '"paused"' in src
    assert '"failed"' not in src


def test_the_loop_persists_a_crash_as_resumable_not_failed():
    """Asserted against the source because the branch lives inline in a 900-line
    function. The behaviour it guards: a crash writes "paused" (which
    list_interrupted_checkpoints returns) rather than "failed" (which it does not)."""
    import inspect

    from nanoagent.agent.effector import react_loop

    src = inspect.getsource(react_loop.run_react_loop)
    helper = src[src.index("def _crash_status_and_error"):]
    helper = helper[: helper.index("for turn_num in range")]
    assert 'return "paused"' in helper
    assert "_browser_is_gone(err)" in helper


# ── the loop must ACT on a crash, not just record it ─────────────────────────


def test_the_loop_bails_out_at_the_top_of_a_turn_when_the_browser_is_gone():
    """Found by a real agent cycle, 2026-09-02, and not by any harness.

    The watchdog detected `page.crash` correctly and the run then hung for 23 minutes
    until it was killed. Detection was PASSIVE: `_browser_is_gone()` was only consulted
    inside exception handlers, and the next call did not raise — it was
    `capture_dom_snapshot` -> CDP `Runtime.evaluate` on a crashed target, and a CDP send
    has no timeout.

    Bounding `__aexit__` (the original gap-F fix) was necessary and not sufficient: the
    hang was inside the loop, long before teardown. Asserted against the source because
    the check lives inline in a 900-line function with no seam.
    """
    import inspect

    from nanoagent.agent.effector import react_loop

    src = inspect.getsource(react_loop.run_react_loop)
    head = src[src.index("for turn_num in range("):]
    head = head[: head.index("# Start of the turn")]

    # The check happens BEFORE anything touches the page for this turn.
    assert "_browser_is_gone()" in head
    assert 'status="paused"' in head          # resumable, not failed
    assert "browser_crashed=True" in head     # and the caller is told which it was
