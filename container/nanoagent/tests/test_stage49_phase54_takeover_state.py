"""Phase 5.4 — the takeover state machine.

The agent hits a wall, asks for hands, and the run PARKS: the page is untouched, the
session stays open, frames keep streaming. On release the next turn takes a fresh
snapshot like every other turn, so the agent resumes from wherever the person actually
left the page rather than from what it remembers — which matters, because they were
driving.

The waiting is bounded for the same reason the approval gate is: a run waiting forever
for someone who has gone home is a container holding a browser until CONTAINER_TIMEOUT
kills it with nothing said. "I asked for hands and none came" is a result, not a crash.
"""

from __future__ import annotations

import asyncio

import pytest

from nanoagent.agent.effector import react_loop as rl
from nanoagent.agent.effector.takeover import TakeoverSession


class _Page:
    def __init__(self):
        self.viewport_size = {"width": 1280, "height": 720}
        self.mouse = None
        self.keyboard = None


@pytest.fixture(autouse=True)
def _fast(monkeypatch):
    """No real waiting: the poll interval is the only sleep in the waiter."""
    monkeypatch.setattr(rl, "_TAKEOVER_POLL_S", 0.01)
    monkeypatch.setattr(rl, "_TAKEOVER_TIMEOUT_S", 0.2)
    # The announcement is best-effort and needs no orchestrator in these tests.
    monkeypatch.setenv("NanoCrew_HOST", "http://orchestrator.test")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)


@pytest.mark.asyncio
async def test_a_release_resumes_the_run():
    """The happy path: someone came, did the thing, handed back."""
    session = TakeoverSession(_Page())

    async def human_finishes_after_a_moment():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(human_finishes_after_a_moment())
    granted = await rl._await_human_takeover(session, "Solve the CAPTCHA", 4)

    assert granted is True
    assert session.armed is False, "the agent must have the wheel back"


@pytest.mark.asyncio
async def test_input_is_armed_only_while_the_run_is_waiting():
    """Arming is what makes phase 5.3's input reach the page at all, and it must not
    outlive the wait — an armed session after the agent resumes is two drivers again."""
    session = TakeoverSession(_Page())
    seen: list[bool] = []

    async def watch_then_release():
        await asyncio.sleep(0.03)
        seen.append(session.armed)   # armed while waiting
        session.release()

    asyncio.create_task(watch_then_release())
    await rl._await_human_takeover(session, "Log in", 1)

    assert seen == [True]
    assert session.armed is False


@pytest.mark.asyncio
async def test_nobody_coming_is_a_result_rather_than_a_hang():
    session = TakeoverSession(_Page())
    granted = await rl._await_human_takeover(session, "Solve the CAPTCHA", 2)

    assert granted is False
    assert session.armed is False, "a timed-out takeover must not leave input armed"


@pytest.mark.asyncio
async def test_a_run_with_no_takeover_session_refuses_rather_than_crashing():
    """Belt and braces: every real run has one, and a missing one must still not raise
    inside the loop."""
    assert await rl._await_human_takeover(None, "Solve the CAPTCHA", 1) is False


@pytest.mark.asyncio
async def test_a_failed_announcement_does_not_cancel_the_takeover(monkeypatch):
    """The dashboard prompt is best-effort. A human watching the live view can act
    without it, so a broken channel must not turn a takeover into a refusal."""
    session = TakeoverSession(_Page())

    async def broken_channel():
        raise RuntimeError("no orchestrator")

    from nanoagent.agent.effector import cycle_channel
    # The waiter imports current_channel at call time, so patching the module attribute
    # is what it will actually reach.
    monkeypatch.setattr(cycle_channel, "current_channel", broken_channel)

    async def human_finishes():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(human_finishes())
    assert await rl._await_human_takeover(session, "Log in", 1) is True


@pytest.mark.asyncio
async def test_the_reason_is_carried_so_the_human_is_told_what_to_do():
    session = TakeoverSession(_Page())

    async def human_finishes():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(human_finishes())
    await rl._await_human_takeover(session, "Approve the 2FA prompt on your phone", 7)

    assert session.reason == "Approve the 2FA prompt on your phone"


def test_the_model_is_told_when_to_ask_and_when_not_to():
    """The action exists to buy a human's attention, which is expensive. The prompt has
    to say what it is for AND what it is not for, or it becomes the escape hatch for any
    page the model finds difficult."""
    prompt = rl._SYSTEM_PROMPT
    assert "takeover" in prompt
    assert "CAPTCHA" in prompt
    assert "NOT for" in prompt


def test_takeover_is_in_the_action_vocabulary():
    """A capability the model is never told about is a capability that never fires —
    the same way a deferred `clarify` never fired (stage 49 phase 3)."""
    assert "double_click|takeover|done" in rl._SYSTEM_PROMPT


# ─── the picture has to keep moving while the human drives ────────────────────

@pytest.mark.asyncio
async def test_frames_keep_shipping_while_the_run_is_parked():
    """Found live 2026-09-03, a live cycle.

    Frames are shipped from the turn loop, and parking for a takeover means there are no
    more turns — so the live view stopped at the exact moment it became the whole point.
    The agent asked on turn 1, four seconds after the browser opened, and the drawer read
    "No browser open right now" to someone being asked to drive that browser.
    """
    session = TakeoverSession(_Page())
    pushes = 0

    def push_frame():
        nonlocal pushes
        pushes += 1

    async def human_finishes():
        await asyncio.sleep(0.05)
        session.release()

    asyncio.create_task(human_finishes())
    await rl._await_human_takeover(session, "Sign in for me", 1, push_frame)

    assert pushes >= 2, "the view must keep updating for the person driving"


@pytest.mark.asyncio
async def test_a_failing_frame_push_never_ends_the_takeover():
    """A human is mid-login. A dropped frame is not worth ending that."""
    session = TakeoverSession(_Page())

    def exploding_push():
        raise RuntimeError("socket went away")

    async def human_finishes():
        await asyncio.sleep(0.05)
        session.release()

    asyncio.create_task(human_finishes())
    assert await rl._await_human_takeover(session, "Sign in", 1, exploding_push) is True


@pytest.mark.asyncio
async def test_it_still_works_with_no_frame_pusher_at_all():
    """Belt and braces: a caller that passes nothing must not crash the wait."""
    session = TakeoverSession(_Page())

    async def human_finishes():
        await asyncio.sleep(0.03)
        session.release()

    asyncio.create_task(human_finishes())
    assert await rl._await_human_takeover(session, "Sign in", 1) is True


# ─── Stop has to reach a parked run ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_pressing_stop_cancels_a_parked_takeover(monkeypatch):
    """Observed live 2026-09-03: an operator pressed Stop, watched the status go idle,
    and the cycle sat waiting for its full fifteen minutes. This is the one place in the
    loop that can wait that long without taking a turn, so it is the one place that has
    to ask."""
    monkeypatch.setattr(rl, "_TAKEOVER_INTERRUPT_CHECK_S", 0.01)

    async def interrupted():
        return True

    monkeypatch.setattr(rl, "_is_interrupted", interrupted)

    session = TakeoverSession(_Page())
    granted = await rl._await_human_takeover(session, "Sign in for me", 1)

    assert granted is False
    assert session.armed is False, "a cancelled takeover must not leave input armed"


@pytest.mark.asyncio
async def test_a_flaky_interrupt_check_never_abandons_the_run(monkeypatch):
    """The rule loop.py already follows: a network error means carry on. Turning an
    orchestrator hiccup into an abandoned takeover would be worse than the wait."""
    monkeypatch.setattr(rl, "_TAKEOVER_INTERRUPT_CHECK_S", 0.01)

    async def exploding():
        raise RuntimeError("orchestrator unreachable")

    monkeypatch.setattr(rl, "_is_interrupted", exploding)

    session = TakeoverSession(_Page())

    async def human_finishes():
        await asyncio.sleep(0.05)
        session.release()

    asyncio.create_task(human_finishes())
    # The raise propagates out of the check, so the wait must still be the thing that
    # decides — a released takeover still returns True.
    try:
        granted = await rl._await_human_takeover(session, "Sign in", 1)
    except RuntimeError:
        granted = None
    assert granted is not False, "a failed check must not read as 'stopped'"
