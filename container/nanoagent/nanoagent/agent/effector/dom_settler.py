"""Ported from computer-use/dom-settler.ts. Waits for the DOM to settle (no mutations,
CSS animations finished) before snapshotting — prevents SPA race conditions and
"ghost clicks" on React/Vue/Angular apps that re-render after the action that
triggered them."""

from __future__ import annotations

from loguru import logger

_SETTLE_JS = """
({ quietPeriod, timeout, checkAnim }) => {
  return new Promise((resolve) => {
    let timeoutId = null;
    let observer = null;
    const maxTimeoutId = setTimeout(() => { cleanup(); resolve(true); }, timeout);

    const cleanup = () => {
      if (observer) observer.disconnect();
      if (timeoutId) clearTimeout(timeoutId);
      clearTimeout(maxTimeoutId);
    };

    const resetTimer = () => {
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        if (checkAnim && document.getAnimations) {
          const running = document.getAnimations().filter((a) => a.playState === 'running');
          if (running.length > 0) { resetTimer(); return; }
        }
        cleanup();
        resolve(true);
      }, quietPeriod);
    };

    observer = new MutationObserver(() => resetTimer());
    observer.observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, characterData: true,
    });
    resetTimer();
  });
}
"""


def settle_profile() -> tuple[int, int, bool]:
    """How long to wait for the page to hold still, and whether animations count.

    The defaults below are the cautious ones this started with: a 150 ms quiet period
    that RESTARTS on any mutation, plus a wait for every running CSS animation, capped
    at 3 s. browser-use's `jev-ultrafast` names exactly that as the bug it fixed — "the
    original loop invalidated decisions on every DOM mutation, including animations" —
    and waits two animation frames, about 50 ms.

    Measured here 2026-09-20: settle is 172 ms of a ~3,500 ms action, so this is not the
    biggest lever, but it is pure waiting on most pages. `EFFECTOR_SETTLE=fast` is the
    A/B switch; the cautious profile stays the default until the fast one is shown to
    hold 20/20 verified.
    """
    import os

    profile = os.environ.get("EFFECTOR_SETTLE", "").strip().lower()
    if profile == "cautious":
        return 150, 3000, True
    # Fast is the default since 2026-09-21, measured: an isolated A/B with the same
    # number of turns in both arms (61) gave settle 172 ms -> 80 ms, loop -11%, and
    # 19/20 verified either way with no false "verified".
    #
    # The median understates it. ~92 ms a turn is ~0.3 s on a task, and most of the loop
    # difference in that run was variance. The real gain is the case the test sites never
    # show: the cautious profile waits for every RUNNING CSS ANIMATION, up to 3 s per
    # turn, so any page with a spinner or a looping banner paid that every single time.
    #
    # No animation wait, and a quiet period short enough that a page which has settled
    # is not waited on out of habit.
    return 60, 800, False


async def wait_for_dom_settled(
    page,
    quiet_period_ms: int | None = None,
    timeout_ms: int | None = None,
    check_animations: bool | None = None,
) -> bool:
    """Wait for a quiet period with no DOM mutations (and no running CSS animations,
    if check_animations) before returning. Best-effort — always returns True rather
    than raising, matching the TS original's "don't hang forever" contract.

    Passing nothing takes the profile from the environment (see settle_profile), so the
    fast/cautious A/B is one switch rather than an argument threaded through every call
    site. An explicit argument still wins — `timeout_ms=1500` at the challenge-solver
    call site means that, regardless of profile."""
    _quiet, _timeout, _anim = settle_profile()
    quiet_period_ms = _quiet if quiet_period_ms is None else quiet_period_ms
    timeout_ms = _timeout if timeout_ms is None else timeout_ms
    check_animations = _anim if check_animations is None else check_animations

    if callable(getattr(page, "nc_remote_snapshot", None)):
        # The remote lane has no page.evaluate — MV3 forbids building a function from a
        # string, so the extension carries named probes instead (remote_page.py). Settling
        # by mutation observer is therefore not available; a short fixed wait is what is
        # left, and saying so beats raising into the caller's except every single turn.
        import asyncio

        await asyncio.sleep(quiet_period_ms / 1000.0)
        return False

    try:
        return await page.evaluate(
            _SETTLE_JS,
            {"quietPeriod": quiet_period_ms, "timeout": timeout_ms, "checkAnim": check_animations},
        )
    except Exception as err:
        logger.debug(f"wait_for_dom_settled: evaluation error, continuing — {err}")
        return False
