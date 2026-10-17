"""stage45 item 3: the live view stops freezing during a decision call.

Stage 44 shipped two push points per turn and named the consequence in its own
"known limits": a long LLM decision shows a frozen frame. The decision is often the
longest part of a turn and it is exactly when a page is still finishing what the last
action started, so the one thing a watcher wants to see is the part they cannot.

The pump lives on `EffectorSession` rather than in the loop for one reason, and it is
the reason worth testing: `run_react_loop` has thirteen return sites, and a background
task cancelled at only twelve of them outlives its run inside a warm daemon that gets
reused. `__aexit__` already runs on every path.
"""

from __future__ import annotations

import asyncio

import pytest

from nanoagent.agent.effector.browser_session import EffectorSession


class FakePage:
    def __init__(self, url="https://a.test/"):
        self.url = url
        self.title_calls = 0

    async def title(self):
        self.title_calls += 1
        return f"title of {self.url}"


def _session(tmp_path, page) -> EffectorSession:
    """A session object without a browser. __init__ starts nothing, so this exercises
    the pump exactly as a real run would without launching Chromium."""
    s = EffectorSession(tmp_path)
    s.page = page
    return s


async def _drive(session, sink, ticks=6, interval=0.02):
    session.start_frame_pump(sink, interval_s=interval)
    await asyncio.sleep(interval * ticks)
    await session._stop_frame_pump()


# ── the point of the feature ─────────────────────────────────────────────────


def test_frames_are_pushed_without_the_loop_doing_anything(tmp_path):
    """No turn boundary, no maybe_push_frame — just time passing, which is what a
    decision call looks like from the outside."""
    page = FakePage()
    s = _session(tmp_path, page)
    sent = []

    async def go():
        counter = {"n": 0}

        def sink(data_url, url, title):
            sent.append((data_url, url, title))

        # A page that keeps changing, as one still loading would.
        async def churn():
            for i in range(10):
                s.last_frame_data_url = f"data:image/jpeg;base64,frame{i}"
                await asyncio.sleep(0.02)

        s.start_frame_pump(sink, interval_s=0.02)
        await churn()
        await s._stop_frame_pump()

    asyncio.run(go())
    assert len(sent) >= 3, sent
    assert sent[0][0] != sent[-1][0]


def test_an_unchanged_frame_is_not_pushed_again(tmp_path):
    """Deduplicated on purpose. A static page during a 20-second decision would
    otherwise POST identical bytes forty times; the pump exists for the page that IS
    changing while the loop is busy, not as a heartbeat."""
    page = FakePage()
    s = _session(tmp_path, page)
    s.last_frame_data_url = "data:image/jpeg;base64,same"
    sent = []

    asyncio.run(_drive(s, lambda d, u, t: sent.append(d), ticks=8))
    assert len(sent) == 1, sent


def test_nothing_is_pushed_before_a_frame_exists(tmp_path):
    """A session whose screencast has not delivered yet must not post empty frames."""
    s = _session(tmp_path, FakePage())
    s.last_frame_data_url = None
    sent = []
    asyncio.run(_drive(s, lambda d, u, t: sent.append(d), ticks=6))
    assert sent == []


def test_the_url_rides_along_and_the_title_is_only_fetched_when_it_changes(tmp_path):
    """page.title() is a round trip and this runs twice a second in production."""
    page = FakePage("https://a.test/one")
    s = _session(tmp_path, page)
    sent = []

    async def go():
        s.start_frame_pump(lambda d, u, t: sent.append((u, t)), interval_s=0.02)
        for i in range(4):
            s.last_frame_data_url = f"data:image/jpeg;base64,f{i}"
            await asyncio.sleep(0.03)
        page.url = "https://a.test/two"
        for i in range(4, 8):
            s.last_frame_data_url = f"data:image/jpeg;base64,f{i}"
            await asyncio.sleep(0.03)
        await s._stop_frame_pump()

    asyncio.run(go())
    urls = {u for u, _ in sent}
    assert urls == {"https://a.test/one", "https://a.test/two"}
    # Two distinct URLs over eight-ish pushes: one title fetch each, not one per push.
    assert page.title_calls == 2, page.title_calls


def test_a_loading_placeholder_is_never_reported_as_a_title(tmp_path):
    """Chromium reports `Loading <url>` mid-navigation. That is a status message, not a
    title, and it would label the live view with noise."""
    class LoadingPage(FakePage):
        async def title(self):
            self.title_calls += 1
            return "Loading https://a.test/slow"

    s = _session(tmp_path, LoadingPage())
    sent = []

    async def go():
        s.start_frame_pump(lambda d, u, t: sent.append(t), interval_s=0.02)
        s.last_frame_data_url = "data:image/jpeg;base64,f"
        await asyncio.sleep(0.06)
        await s._stop_frame_pump()

    asyncio.run(go())
    assert sent and all(t == "" for t in sent), sent


# ── it must never be able to break a run ─────────────────────────────────────


def test_a_sink_that_raises_does_not_kill_the_pump(tmp_path):
    """A dead orchestrator must cost the run nothing — the same contract
    _post_live_frame already has."""
    s = _session(tmp_path, FakePage())
    calls = {"n": 0}

    def angry_sink(d, u, t):
        calls["n"] += 1
        raise RuntimeError("orchestrator is down")

    async def go():
        s.start_frame_pump(angry_sink, interval_s=0.02)
        for i in range(5):
            s.last_frame_data_url = f"data:image/jpeg;base64,f{i}"
            await asyncio.sleep(0.03)
        await s._stop_frame_pump()

    asyncio.run(go())
    assert calls["n"] >= 3, calls  # kept going after the first failure


def test_a_page_that_raises_on_url_does_not_kill_the_pump(tmp_path):
    class DeadPage:
        @property
        def url(self):
            raise RuntimeError("Target crashed")

        async def title(self):
            raise RuntimeError("Target crashed")

    s = _session(tmp_path, DeadPage())
    sent = []

    async def go():
        s.start_frame_pump(lambda d, u, t: sent.append((d, u)), interval_s=0.02)
        s.last_frame_data_url = "data:image/jpeg;base64,f"
        await asyncio.sleep(0.06)
        await s._stop_frame_pump()

    asyncio.run(go())
    # The frame still ships, just unlabelled — a crashed page's last frame is the one
    # most worth seeing.
    assert sent and sent[0][1] == ""


# ── lifecycle: the reason it lives on the session ────────────────────────────


def test_starting_twice_does_not_leave_two_pumps(tmp_path):
    s = _session(tmp_path, FakePage())

    async def go():
        first = s.start_frame_pump(lambda *a: None, interval_s=0.05)
        second = s.start_frame_pump(lambda *a: None, interval_s=0.05)
        await s._stop_frame_pump()
        return first, second

    first, second = asyncio.run(go())
    assert first is True and second is False


def test_stopping_actually_stops_it(tmp_path):
    """The whole reason this is on the session: a task that survives its run gets reused
    by the next cycle inside a warm daemon."""
    s = _session(tmp_path, FakePage())
    sent = []

    async def go():
        s.start_frame_pump(lambda d, u, t: sent.append(d), interval_s=0.02)
        s.last_frame_data_url = "data:image/jpeg;base64,a"
        await asyncio.sleep(0.05)
        await s._stop_frame_pump()
        before = len(sent)
        # Keep changing the frame after the stop; nothing more may be sent.
        for i in range(5):
            s.last_frame_data_url = f"data:image/jpeg;base64,after{i}"
            await asyncio.sleep(0.03)
        return before

    before = asyncio.run(go())
    assert len(sent) == before


def test_stopping_a_pump_that_never_started_is_fine(tmp_path):
    s = _session(tmp_path, FakePage())
    asyncio.run(s._stop_frame_pump())


def test_no_sink_means_no_pump(tmp_path):
    s = _session(tmp_path, FakePage())
    assert s.start_frame_pump(None) is False
