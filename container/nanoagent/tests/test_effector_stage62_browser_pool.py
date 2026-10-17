"""Stage 62 phase 1 — the warm browser pool, and the leaks that pooling creates.

Two halves. The first is the pool's own contract: reuse a healthy browser, never reuse
a dead or discarded one, and behave exactly like the old cold path when it is switched
off. The second is the part that only matters BECAUSE the browser now survives the run —
per-run listeners and CDP sessions that used to be thrown away with the process and now
accumulate on a shared object.

Every test drives the real module; the browser is a stub because a real launch is 1.6 s
and this file runs on every push.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from nanoagent.agent.effector import browser_pool
from nanoagent.agent.effector.watchdogs import CrashWatchdog


class FakeBrowser:
    def __init__(self) -> None:
        self.connected = True
        self.closed = False
        self.listeners: list[tuple[str, object]] = []

    def is_connected(self) -> bool:
        return self.connected

    async def close(self) -> None:
        self.closed = True
        self.connected = False

    def on(self, event: str, handler) -> None:
        self.listeners.append((event, handler))

    def remove_listener(self, event: str, handler) -> None:
        self.listeners.remove((event, handler))


class FakePlaywright:
    def __init__(self) -> None:
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True


def make_factory(built: list):
    async def factory() -> browser_pool.PooledBrowser:
        browser, pw = FakeBrowser(), FakePlaywright()
        built.append((browser, pw))
        return browser_pool.PooledBrowser(browser=browser, playwright=pw)

    return factory


@pytest.fixture(autouse=True)
async def _clean_pool(monkeypatch):
    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "1")
    await browser_pool.shutdown()
    yield
    await browser_pool.shutdown()


# ---------------------------------------------------------------- the pool's contract


async def test_second_run_reuses_the_browser_instead_of_launching():
    built: list = []
    factory = make_factory(built)

    first = await browser_pool.acquire("k", factory)
    await browser_pool.release(first)
    second = await browser_pool.acquire("k", factory)

    assert len(built) == 1, "a warm browser was available and a second one was launched anyway"
    assert second.browser is first.browser
    assert first.cold is True and second.cold is False
    assert built[0][0].closed is False


async def test_a_different_key_gets_its_own_browser():
    built: list = []
    factory = make_factory(built)

    a = await browser_pool.acquire("chromium|display-1", factory)
    b = await browser_pool.acquire("chromium|display-2", factory)

    assert a.browser is not b.browser
    assert len(built) == 2


async def test_a_browser_that_died_while_idle_is_replaced_not_handed_out():
    built: list = []
    factory = make_factory(built)

    first = await browser_pool.acquire("k", factory)
    await browser_pool.release(first)
    built[0][0].connected = False  # the process went away while nobody was looking

    second = await browser_pool.acquire("k", factory)

    assert len(built) == 2
    assert second.browser is not first.browser
    assert second.cold is True


async def test_a_crashed_browser_is_retired_rather_than_lent_again():
    built: list = []
    factory = make_factory(built)

    first = await browser_pool.acquire("k", factory)
    await browser_pool.release(first, discard=True)

    assert built[0][0].closed is True
    second = await browser_pool.acquire("k", factory)
    assert second.browser is not first.browser


async def test_a_held_browser_is_never_closed_under_its_user():
    built: list = []
    factory = make_factory(built)

    one = await browser_pool.acquire("k", factory)
    two = await browser_pool.acquire("k", factory)  # a second run, same warm browser
    assert one.browser is two.browser

    await browser_pool.release(one, discard=True)
    assert built[0][0].closed is False, "the browser closed while another run was using it"

    await browser_pool.release(two)
    assert built[0][0].closed is True


async def test_idle_browsers_are_closed_once_the_ttl_passes(monkeypatch):
    built: list = []
    factory = make_factory(built)

    first = await browser_pool.acquire("k", factory)
    await browser_pool.release(first)
    monkeypatch.setattr(browser_pool, "_TTL_S", -1)  # everything idle is now expired

    second = await browser_pool.acquire("k", factory)

    assert built[0][0].closed is True
    assert second.browser is not first.browser


async def test_a_browser_is_retired_after_enough_runs(monkeypatch):
    built: list = []
    factory = make_factory(built)
    monkeypatch.setattr(browser_pool, "_MAX_USES", 2)

    a = await browser_pool.acquire("k", factory)
    await browser_pool.release(a)
    b = await browser_pool.acquire("k", factory)
    await browser_pool.release(b)
    c = await browser_pool.acquire("k", factory)

    assert b.browser is a.browser
    assert c.browser is not a.browser, "the browser ran past its use limit without restarting"


async def test_switching_the_pool_off_restores_the_old_cold_path(monkeypatch):
    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "0")
    built: list = []
    factory = make_factory(built)

    first = await browser_pool.acquire("k", factory)
    await browser_pool.release(first)
    second = await browser_pool.acquire("k", factory)
    await browser_pool.release(second)

    assert len(built) == 2, "the pool was off and still reused a browser"
    assert built[0][0].closed and built[0][1].stopped
    assert built[1][0].closed and built[1][1].stopped
    assert browser_pool.stats()["entries"] == 0


async def test_two_runs_racing_for_one_key_launch_one_browser():
    built: list = []
    factory = make_factory(built)

    a, b = await asyncio.gather(
        browser_pool.acquire("k", factory), browser_pool.acquire("k", factory)
    )

    assert len(built) == 1, "a race launched a second browser that nothing would ever close"
    assert a.browser is b.browser


# ------------------------------------------------- what pooling makes possible to leak


async def test_the_crash_watchdog_takes_its_listeners_back_off():
    browser = FakeBrowser()

    for _ in range(5):  # five runs borrowing one pooled browser
        watchdog = CrashWatchdog()
        watchdog.attach(browser=browser)
        watchdog.detach()

    assert browser.listeners == [], (
        "each run left a 'disconnected' handler on the shared browser; after a day of "
        "cycles the pooled browser carries a listener per run that ever touched it"
    )


async def test_detach_reports_that_the_watchdog_is_no_longer_wired():
    browser = FakeBrowser()
    watchdog = CrashWatchdog()
    assert watchdog.attach(browser=browser) == 1
    assert watchdog.attached_to == ["browser.disconnected"]

    assert watchdog.detach() == 1
    assert watchdog.attached_to == []


async def test_detach_survives_an_object_that_cannot_unsubscribe():
    class NoRemove:
        def on(self, event, handler):
            pass

    watchdog = CrashWatchdog()
    watchdog.attach(browser=NoRemove())
    assert watchdog.detach() == 0  # nothing came off, and nothing raised


async def test_the_run_record_says_which_engine_and_whether_it_was_warm(tmp_path):
    """`session_ms` is meaningless without this: 5.5 s is a camoufox launch, 1.6 s a
    Chromium launch, 0.2 s a warm handover. Three arms, one median, no way to tell."""
    import json

    from nanoagent.agent.effector.decision_log import record_run_timings

    record_run_timings(
        tmp_path, "run-1", {"start": 0.0, "session": 0.2, "end": 9.0},
        engine="chromium", warm_browser=True,
    )
    line = json.loads((tmp_path / ".effector" / "decisions" / "run-1.jsonl").read_text().strip())

    assert line["type"] == "run"
    assert line["engine"] == "chromium"
    assert line["warm_browser"] is True
    assert line["session_ms"] == 200


async def test_the_run_record_omits_engine_when_the_run_never_had_one(tmp_path):
    import json

    from nanoagent.agent.effector.decision_log import record_run_timings

    record_run_timings(tmp_path, "run-2", {"start": 0.0, "end": 1.0})
    line = json.loads((tmp_path / ".effector" / "decisions" / "run-2.jsonl").read_text().strip())

    assert "engine" not in line and "warm_browser" not in line


@pytest.mark.parametrize(
    "value,native",
    [(None, True), ("", True), ("auto", True), ("camoufox", True), ("chromium", False), (" Chromium ", False)],
)
def test_an_empty_engine_variable_still_means_auto(monkeypatch, value, native):
    """`docker run -e EFFECTOR_ENGINE=` SETS the variable to "". Read with a plain
    default that reads as "not auto", which silently forced Chromium — and would have
    made the control arm of the engine comparison run the treatment engine."""
    from nanoagent.agent.effector.browser_session import resolve_engine_preference

    monkeypatch.delenv("EFFECTOR_USE_NATIVE_ENGINE", raising=False)
    if value is None:
        monkeypatch.delenv("EFFECTOR_ENGINE", raising=False)
    else:
        monkeypatch.setenv("EFFECTOR_ENGINE", value)

    assert (resolve_engine_preference() in ("auto", "camoufox")) is native


def test_the_native_engine_override_still_wins(monkeypatch):
    from nanoagent.agent.effector.browser_session import resolve_engine_preference

    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    monkeypatch.setenv("EFFECTOR_USE_NATIVE_ENGINE", "1")
    assert resolve_engine_preference() == "camoufox"


# ------------------------------------------------------------- the real session, wired


@pytest.mark.asyncio
async def test_a_second_session_reuses_the_browser_and_still_gets_its_own_context(
    tmp_path, monkeypatch
):
    """The wiring, not the pool in isolation.

    This is the test that was missing when the pool first landed: 15 unrelated tests
    started failing because a session really did hand its browser to the next one, and
    nothing here asserted that on purpose. Two sessions, one launch, two contexts, and
    the browser still open at the end.
    """
    from unittest.mock import patch

    from nanoagent.agent.effector.browser_session import EffectorSession
    from test_effector_phase2 import _fake_playwright_chain

    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "1")
    fake_async_playwright, fake_browser, fake_context, _page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as first:
            assert first.capabilities.warm_browser is False
        async with EffectorSession(tmp_path) as second:
            assert second.capabilities.warm_browser is True

    assert fake_browser.new_context.await_count == 2, "the second run did not get its own context"
    assert fake_context.close.await_count == 2, "a run's context outlived it"
    assert fake_browser.close.await_count == 0, "the browser was closed instead of pooled"

    await browser_pool.shutdown()
    assert fake_browser.close.await_count == 1, "shutdown left the browser running"


@pytest.mark.asyncio
async def test_with_the_pool_off_each_session_launches_and_closes_its_own_browser(
    tmp_path, monkeypatch
):
    from unittest.mock import patch

    from nanoagent.agent.effector.browser_session import EffectorSession
    from test_effector_phase2 import _fake_playwright_chain

    monkeypatch.setenv("EFFECTOR_ENGINE", "chromium")
    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "0")
    fake_async_playwright, fake_browser, _context, _page = _fake_playwright_chain()

    with patch("playwright.async_api.async_playwright", fake_async_playwright):
        async with EffectorSession(tmp_path) as session:
            assert session.capabilities.warm_browser is False

    assert fake_browser.close.await_count == 1, "EFFECTOR_WARM_BROWSER=0 did not restore the cold path"


async def test_an_idle_browser_is_closed_by_the_timer_without_another_acquire(monkeypatch):
    """A warm daemon is ONE long-lived process fed a JSON line per cycle. An agent that
    does one browser task and then spends the day on email would hold the browser's
    ~250 MB forever if the only sweep ran on acquire — there is no next acquire."""
    built: list = []
    monkeypatch.setattr(browser_pool, "_TTL_S", 0.01)
    monkeypatch.setattr(browser_pool, "_SWEEP_MIN_S", 0.01)

    lease = await browser_pool.acquire("k", make_factory(built))
    await browser_pool.release(lease)

    for _ in range(100):  # the sweeper wakes on its own timer
        if built[0][0].closed:
            break
        await asyncio.sleep(0.02)

    assert built[0][0].closed is True, "the idle browser was never closed without a second acquire"
    assert browser_pool.stats()["entries"] == 0


async def test_the_sweeper_stops_itself_once_the_pool_is_empty(monkeypatch):
    built: list = []
    monkeypatch.setattr(browser_pool, "_TTL_S", 0.01)
    monkeypatch.setattr(browser_pool, "_SWEEP_MIN_S", 0.01)

    lease = await browser_pool.acquire("k", make_factory(built))
    await browser_pool.release(lease)
    for _ in range(100):
        if browser_pool._sweeper_task is None or browser_pool._sweeper_task.done():
            break
        await asyncio.sleep(0.02)

    assert browser_pool._sweeper_task is not None and browser_pool._sweeper_task.done(), (
        "a timer with nothing left to close is still keeping the process awake"
    )


async def test_shutdown_cancels_the_sweeper():
    built: list = []
    lease = await browser_pool.acquire("k", make_factory(built))
    await browser_pool.release(lease)
    assert browser_pool._sweeper_task is not None

    await browser_pool.shutdown()

    assert browser_pool._sweeper_task is None
    assert built[0][0].closed is True


# ------------------------------------------------------- the native (Gecko) lane

class _FakeNativeBrowser:
    """A Gecko browser that already has a default context, the way a real one does."""

    def __init__(self) -> None:
        self.connected = True
        self.closed = False
        self.default_context = MagicMock(name="default-context")
        self.contexts = [self.default_context]
        self.made: list = []

    def is_connected(self) -> bool:
        return self.connected

    async def new_context(self, **_kw):
        page = MagicMock(name=f"page-{len(self.made)}")
        page.route = AsyncMock()          # the network shield awaits this
        page.close = AsyncMock()
        page.screenshot = AsyncMock(return_value=b"")
        page.title = AsyncMock(return_value="")
        ctx = MagicMock(name=f"fresh-context-{len(self.made)}")
        ctx.new_page = AsyncMock(return_value=page)
        ctx.close = AsyncMock()
        ctx.storage_state = AsyncMock(return_value={})
        ctx.add_cookies = AsyncMock()     # session restore awaits this
        ctx.add_init_script = AsyncMock()
        ctx.pages = []
        self.made.append(ctx)
        return ctx

    def on(self, *_a, **_kw):
        pass


def _patch_native_lane(monkeypatch, browser):
    """Force the native lane and hand it `browser`, without a real engine."""
    import sys
    import types

    import nanoagent.agent.effector.browser_session as bs

    monkeypatch.setenv("EFFECTOR_ENGINE", "camoufox")
    monkeypatch.setattr(bs, "engine_status", lambda: (True, "test engine"))
    monkeypatch.setattr(bs, "pick_device_profile",
                        lambda *_a, **_k: SimpleNamespace(browser_family="gecko", user_agent="UA/1"))
    monkeypatch.setattr(bs, "should_route_through_proxy", lambda *_a, **_k: False)

    async def _geo(*_a, **_k):
        return SimpleNamespace(timezone_id="UTC", locale="en-US",
                               accept_language="en-US", languages=["en-US"], source="test")

    monkeypatch.setattr(bs, "resolve_geo_profile", _geo)
    monkeypatch.setattr(bs, "get_camoufox_engine_options", lambda **_k: {})

    class _FakeCM:
        def __init__(self, **_kw):
            pass

        async def __aenter__(self):
            return browser

        async def __aexit__(self, *_a):
            browser.closed = True
            browser.connected = False

    # Injected rather than imported: the real engine package pulls in its own
    # dependencies (orjson, the vendored fork) that this test has no use for, and the
    # launch under test only needs the one name.
    stub = types.ModuleType("nanoagent.agent.effector.engine.async_api")
    stub.AsyncCamoufox = _FakeCM
    monkeypatch.setitem(sys.modules, "nanoagent.agent.effector.engine.async_api", stub)


@pytest.mark.asyncio
async def test_a_pooled_native_browser_never_hands_a_run_the_default_context(
    tmp_path, monkeypatch
):
    """The one way pooling could have become a security bug rather than a speed change.

    The native lane used to take `browser.contexts[0]` — the DEFAULT context, which
    holds whatever the previous run logged into. That was harmless when the browser died
    with the run. With a pooled browser the previous run is a different task, so reusing
    it would hand one task another's cookies and localStorage.
    """
    from nanoagent.agent.effector.browser_session import EffectorSession

    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "1")
    browser = _FakeNativeBrowser()
    _patch_native_lane(monkeypatch, browser)

    async with EffectorSession(tmp_path, session_domain="example.com") as first:
        assert first.context is not browser.default_context, "the run got the DEFAULT context"
        first_ctx = first.context
    async with EffectorSession(tmp_path, session_domain="example.com") as second:
        assert second.context is not browser.default_context
        assert second.context is not first_ctx, "two runs shared one context"
        assert second.capabilities.warm_browser is True

    assert len(browser.made) == 2, "each run must get its own context"
    assert browser.closed is False, "the native browser was closed instead of pooled"
    await browser_pool.shutdown()
    assert browser.closed is True


@pytest.mark.asyncio
async def test_a_native_browser_is_not_shared_across_different_fingerprints(
    tmp_path, monkeypatch
):
    """Gecko bakes the disguise in at LAUNCH, so a warm one is only reusable by a run
    that resolved the same fingerprint. Sharing across domains would make one site's
    visit wear another site's identity."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "1")
    browser = _FakeNativeBrowser()
    _patch_native_lane(monkeypatch, browser)

    import nanoagent.agent.effector.browser_session as bs
    from nanoagent.agent.effector.stealth.fingerprint_pool import pick_device_profile

    # The REAL pool, not a fake. The first version of this test invented a profile whose
    # user agent varied per domain and passed against a key that read the user agent —
    # but every Gecko profile in the real pool carries the SAME user agent and differs
    # in hardware_concurrency, GPU and screen. The fake proved the key worked; the real
    # pool proved it did not.
    monkeypatch.setattr(bs, "pick_device_profile", pick_device_profile)

    domains = ["books.toscrape.com", "quotes.toscrape.com", "news.ycombinator.com",
               "en.wikipedia.org", "the-internet.herokuapp.com", "demoqa.com"]
    profiles = {d: pick_device_profile(d, browser_family="gecko") for d in domains}
    distinct = {p.name for p in profiles.values()}
    assert len(distinct) > 1, "this test needs domains that really do get different devices"
    assert len({p.user_agent for p in profiles.values()}) == 1, (
        "the premise of this test changed: Gecko profiles no longer share a user agent"
    )

    a, b = next(
        (x, y) for x in domains for y in domains
        if profiles[x].name != profiles[y].name
    )

    warm = {}
    async with EffectorSession(tmp_path, session_domain=a) as s:
        warm[a] = s.capabilities.warm_browser
    async with EffectorSession(tmp_path, session_domain=b) as s:
        warm[b] = s.capabilities.warm_browser

    assert warm == {a: False, b: False}, (
        f"{b} reused the browser launched for {a}, so it wore {profiles[a].name} "
        f"instead of {profiles[b].name} — a site seeing another site's device"
    )


async def test_a_crash_is_still_detected_before_detach():
    browser = FakeBrowser()
    watchdog = CrashWatchdog()
    watchdog.attach(browser=browser)

    browser.listeners[0][1]()  # the browser emits "disconnected"

    assert watchdog.crashed is True
    assert watchdog.reason == "browser.disconnected"
