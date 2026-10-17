"""Keep a launched browser alive between Effector runs, instead of paying for one every time.

WHY THIS EXISTS

Measured on prod, 2026-09-20, over 20 live baseline runs: a task took 18,477 ms end to
end, of which 5,552 ms was `session` (starting the browser) and 1,124 ms was teardown.
Six and a half seconds — 36% of the task — was a browser opening and closing, not work.

The same image, timed directly:

    chromium  cold launch 1.64 s | first page 1.00 s | fresh context+tab on a warm
              browser 193 ms
    camoufox  cold launch 3.38 s | first page 2.31 s | fresh context+tab 883 ms

So the fix is not a faster launch, it is not launching. browser-use's `jev-ultrafast`
reaches ~7 s on Google Flights partly because its clock never contains a launch at all:
`ensure_daemon()` keeps the browser up and each run opens a background tab. cua-driver
does the same thing with a background daemon. This module is that, for us.

WHAT IS POOLED, AND WHAT IS NOT

The browser process and the Playwright driver. **Never a context.** Every run still gets
a `new_context()` of its own, which is what carries cookies, storage, the device profile,
the proxy, the timezone and the user agent. Two runs sharing a context would share a
login; two runs sharing a browser share nothing but the executable.

That split is also why Chromium pools cleanly and Camoufox does not: on the Chromium path
everything domain-specific (`storage_state`, `user_agent`, `proxy`, `locale`,
`timezone_id`) is a `new_context()` argument, so one browser serves every domain. The
native engine takes the device profile and geo as *launch* options, so a warm one is
only reusable by a run that resolved the identical fingerprint. Pooling it is a separate
change; `EffectorSession` asks for a pooled browser on the Chromium path only.

SAFETY

- An entry is health-checked (`is_connected()`) before it is handed out. A browser that
  died while idle is dropped and a cold one is built, rather than failing the run.
- The caller reports a crash back (`release(..., discard=True)`), which retires the entry
  even if other runs are still holding it — a crashed browser must not be lent again.
- Entries are reference-counted. Idle ones are closed once `EFFECTOR_WARM_TTL_S` passes;
  a held one is never closed underneath its user.
- `EFFECTOR_WARM_BROWSER=0` turns the whole thing off and restores cold launches, which
  is the rollback if a warm browser ever misbehaves in production.

The pool is per process. A warm `NanoCrew-daemon-*` container keeps it between cycles;
a one-shot cycle process gets the cold path exactly as before, minus nothing.
"""

from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from loguru import logger

# How long an idle browser is kept before it is closed. Long enough to cover the gap
# between two tool calls in one cycle and between two cycles of a busy agent; short
# enough that an idle daemon is not holding a browser's RSS for the rest of the day.
_TTL_S = float(os.environ.get("EFFECTOR_WARM_TTL_S", "300"))
# Distinct warm browsers. One is the useful case (an agent working one lane); the cap
# exists so a run that keeps producing new keys cannot accumulate processes.
_MAX_ENTRIES = int(os.environ.get("EFFECTOR_WARM_MAX", "2"))
# Retire a browser after this many runs even if it stays healthy. Long-lived Chromium
# processes accumulate memory across contexts, and a cheap periodic restart is a better
# trade than discovering the ceiling in production.
_MAX_USES = int(os.environ.get("EFFECTOR_WARM_MAX_USES", "25"))
# Floor on how often the idle sweeper wakes. A browser lingering a few seconds past its
# TTL costs nothing; a timer spinning every few milliseconds in a long-lived daemon does.
_SWEEP_MIN_S = 5.0


def warm_enabled() -> bool:
    """Read at call time, not import time: the baseline harness toggles this per arm."""
    return os.environ.get("EFFECTOR_WARM_BROWSER", "1").strip().lower() not in ("0", "false", "no", "off")


@dataclass
class PooledBrowser:
    """What a factory returns, and what the pool hands back out."""

    browser: Any
    playwright: Any = None
    close: Callable[[], Awaitable[None]] | None = None
    key: str = ""
    uses: int = 0
    refs: int = 0
    idle_since: float = field(default_factory=time.monotonic)
    retired: bool = False


@dataclass
class BrowserLease:
    """One run's borrow of a pooled browser.

    Separate from `PooledBrowser` because two runs can hold the same browser at once,
    and `cold` is a fact about the BORROW, not about the browser: the run that launched
    it paid ~1.6 s and the one that joined a moment later paid nothing. A single shared
    flag made the second run overwrite the first one's timing story.
    """

    browser: Any
    playwright: Any
    cold: bool
    entry: PooledBrowser | None = None


_entries: dict[str, PooledBrowser] = {}
_lock = asyncio.Lock()
_sweeper_task: asyncio.Task | None = None


async def _close_entry(entry: PooledBrowser, why: str) -> None:
    entry.retired = True
    _entries.pop(entry.key, None)
    try:
        if entry.close is not None:
            await asyncio.wait_for(entry.close(), timeout=20)
        else:
            if entry.browser is not None:
                await asyncio.wait_for(entry.browser.close(), timeout=10)
            if entry.playwright is not None:
                await asyncio.wait_for(entry.playwright.stop(), timeout=10)
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector pool: closing a {why} browser raised — {err}")
    else:
        logger.debug(f"effector pool: closed a {why} browser ({entry.uses} runs)")


def _alive(entry: PooledBrowser) -> bool:
    if entry.retired or entry.browser is None:
        return False
    try:
        # Playwright exposes this as a method; a stub in tests may expose a bool.
        connected = entry.browser.is_connected
        return bool(connected() if callable(connected) else connected)
    except Exception:  # noqa: BLE001
        return False


async def _sweep() -> None:
    """Close idle entries past their TTL."""
    now = time.monotonic()
    for entry in list(_entries.values()):
        if entry.refs == 0 and (now - entry.idle_since) > _TTL_S:
            await _close_entry(entry, "idle")


async def _sweeper() -> None:
    """Close idle browsers on a timer, not only when someone asks for one.

    Sweeping on acquire alone is enough for a script that keeps working, and wrong for
    the thing this pool actually lives in: a warm `NanoCrew-daemon-*` is ONE long-lived
    Python process fed a JSON line per cycle (src/agents/daemon-pool.ts), so an agent
    that does one browser task and then spends the day on email would hold a browser's
    ~250 MB until its container was removed — there would never be another acquire to
    trigger the sweep.

    The task stops itself once the pool is empty, so an idle process is not kept awake
    by a timer that has nothing left to close.
    """
    try:
        while True:
            await asyncio.sleep(max(_SWEEP_MIN_S, _TTL_S / 2))
            async with _lock:
                await _sweep()
                if not _entries:
                    return
    except asyncio.CancelledError:
        raise
    except Exception as err:  # noqa: BLE001 - a sweeper that dies must not take the run with it
        logger.debug(f"effector pool: sweeper stopped — {err}")


def _ensure_sweeper() -> None:
    global _sweeper_task
    if _sweeper_task is not None and not _sweeper_task.done():
        return
    try:
        _sweeper_task = asyncio.get_running_loop().create_task(_sweeper())
    except RuntimeError:  # no running loop (sync context) — sweep-on-acquire still applies
        _sweeper_task = None


async def acquire(key: str, factory: Callable[[], Awaitable[PooledBrowser]]) -> BrowserLease:
    """A warm browser for `key`, or a newly built one. Never raises on a dead entry —
    a browser that died while idle is dropped and the factory runs instead."""
    if not warm_enabled():
        entry = await factory()
        entry.key, entry.refs = key, 1
        return BrowserLease(entry.browser, entry.playwright, cold=True, entry=entry)

    async with _lock:
        await _sweep()
        entry = _entries.get(key)
        if entry is not None and not _alive(entry):
            logger.info("effector pool: the warm browser was gone — launching a cold one")
            await _close_entry(entry, "dead")
            entry = None
        if entry is not None and entry.uses >= _MAX_USES:
            if entry.refs == 0:
                await _close_entry(entry, "retired")
            else:
                entry.retired = True
                _entries.pop(key, None)
            entry = None
        if entry is not None:
            entry.refs += 1
            entry.uses += 1
            logger.debug(f"effector pool: reusing a warm browser (run {entry.uses})")
            return BrowserLease(entry.browser, entry.playwright, cold=False, entry=entry)

        # Built inside the lock on purpose. Two runs racing for the same key would
        # otherwise each launch a browser and one would be orphaned; a launch is ~2 s
        # and the second caller would rather wait for it than start its own.
        built = await factory()
        built.key, built.uses, built.refs = key, 1, 1
        built.idle_since = time.monotonic()
        _entries[key] = built
        _ensure_sweeper()
        while len(_entries) > _MAX_ENTRIES:
            oldest = min(
                (e for e in _entries.values() if e.refs == 0 and e is not built),
                key=lambda e: e.idle_since,
                default=None,
            )
            if oldest is None:
                break
            await _close_entry(oldest, "evicted")
        return BrowserLease(built.browser, built.playwright, cold=True, entry=built)


async def release(lease: BrowserLease | None, *, discard: bool = False) -> None:
    """Give a browser back. `discard=True` retires it — pass it after a crash, or after
    anything that leaves the process in a state the next run should not inherit."""
    if lease is None or lease.entry is None:
        return
    entry = lease.entry
    if not warm_enabled():
        await _close_entry(entry, "unpooled")
        return
    async with _lock:
        entry.refs = max(0, entry.refs - 1)
        entry.idle_since = time.monotonic()
        if discard or not _alive(entry):
            if entry.refs == 0:
                await _close_entry(entry, "discarded")
            else:
                # Still in use elsewhere; stop lending it and let the last holder close it.
                entry.retired = True
                _entries.pop(entry.key, None)


async def shutdown() -> None:
    """Close every pooled browser. For process teardown and for tests.

    Call this before the event loop closes. A pooled browser left running when the
    interpreter exits gets finalized by the garbage collector after the loop is gone,
    and Playwright's subprocess transport then raises `RuntimeError: Event loop is
    closed` out of `__del__` — measured 2026-09-20 at the end of a baseline run. The
    run's own results were unaffected, but the driver process was still leaked.
    """
    global _sweeper_task
    if _sweeper_task is not None:
        _sweeper_task.cancel()
        try:
            await _sweeper_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        _sweeper_task = None
    async with _lock:
        for entry in list(_entries.values()):
            await _close_entry(entry, "shutdown")
        _entries.clear()


def stats() -> dict[str, Any]:
    """What the pool is holding — for the capability manifest and for tests."""
    return {
        "enabled": warm_enabled(),
        "entries": len(_entries),
        "ttl_s": _TTL_S,
        "browsers": [
            {"key": e.key, "uses": e.uses, "refs": e.refs, "alive": _alive(e)}
            for e in _entries.values()
        ],
    }
