"""stage44 doc 01, step 2 of 5: react_loop's throttle + POST of the live browser
frame — docs/research/stage44/01-live-browser-view-architecture.md.

Step 1 (test_effector_stage44_screencast.py) proved EffectorSession keeps the
newest CDP frame on `last_frame_data_url`. This step has to prove the other half:
the loop actually ships one, no faster than the documented 2fps, to the right
URL — and that every way this can go wrong (no frame source, no frame yet, no
orchestrator env, a dead orchestrator, a frame source that raises) leaves the
agent's real task completely untouched. That last property is the whole contract:
a live view is a nice-to-have, and nothing here may ever fail a run.

The endpoint it posts to is a deliberate stub at this step (server.ts logs receipt
and returns 200); step 3 swaps that for the real socket emit.
"""

from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import MagicMock, patch

import pytest

from nanoagent.agent.effector import react_loop
from nanoagent.agent.effector.resilience.adaptive_throttle import global_domain_rate_limiter
from test_effector_phase0 import FakePage, ScriptedProvider

_FRAME = "data:image/jpeg;base64,ZmFrZWpwZWc="


@pytest.fixture(autouse=True)
def _isolated_domain_rate_limiter():
    """Real bug, found running this file as part of the full suite (`pytest -k
    effector`), not in isolation: `global_domain_rate_limiter` (adaptive_throttle.py)
    is a process-wide singleton, and every test in this suite that drives
    run_react_loop against FakePage's fixed domain (example.test) shares its token
    bucket. By the time this file's tests run in a full pass, hundreds of earlier
    tests have already drained that domain's bucket, so `acquire()` starts imposing
    real multi-second sleeps — timing this file's assertions never anticipated (every
    test here genuinely finishes in milliseconds in isolation; see the module
    docstring's "throttled... at what rate?" section). Reset around each test so this
    file's timing stays deterministic regardless of suite order or size, and restore
    the saved state after so other tests running later in the same process see
    whatever accumulated state they'd normally see, not an artificially empty bucket."""
    saved = dict(global_domain_rate_limiter._buckets)
    global_domain_rate_limiter._buckets.clear()
    yield
    global_domain_rate_limiter._buckets.clear()
    global_domain_rate_limiter._buckets.update(saved)

# type -> click -> done: two turns that execute an action, then one that doesn't.
_SCRIPT = [
    {"thought": "fill it", "action": "type", "target": "@e1", "text": "Ada"},
    {"thought": "submit", "action": "click", "target": "@e2"},
    {"thought": "finished", "action": "done"},
]


def _wait_for(pred, timeout: float = 2.0) -> None:
    """The POST is scheduled on the default executor and never awaited (by design),
    so a test asserting on it has to give that thread a moment to land."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not pred():
        time.sleep(0.01)


# ─── _post_live_frame: URL, body, env resolution, error swallowing ─────────────

def test_post_live_frame_hits_the_documented_url_with_the_documented_body(monkeypatch):
    monkeypatch.setenv("NanoCrew_HOST", "http://host.docker.internal:3002")
    monkeypatch.setenv("AGENT_ID", "agent-abc")
    monkeypatch.setenv("CYCLE_ID", "cycle-xyz")

    with patch.object(react_loop.urllib.request, "urlopen") as fake_urlopen:
        react_loop._post_live_frame(_FRAME)

    req = fake_urlopen.call_args.args[0]
    assert req.full_url == "http://host.docker.internal:3002/api/agents/agent-abc/cycles/cycle-xyz/frame"
    assert req.get_method() == "POST"
    # stage45 item 2 widened this body on purpose: a frame alone is pixels, and where
    # the browser IS was state we already had and threw away at the wire. The dataUrl
    # is still the payload's whole point, so it stays asserted exactly; url and title
    # are asserted as present-and-defaulted rather than pinned to a value, because the
    # caller supplies them and this test does not.
    body = json.loads(req.data.decode("utf-8"))
    assert body["dataUrl"] == _FRAME
    assert body["url"] == ""
    assert body["title"] == ""
    assert set(body) == {"dataUrl", "url", "title"}
    # Bounded like persist_activity()'s push — a hung orchestrator must not pin
    # an executor thread for the rest of the run.
    assert fake_urlopen.call_args.kwargs["timeout"] == react_loop._FRAME_POST_TIMEOUT_S


@pytest.mark.parametrize("missing", ["NanoCrew_HOST", "AGENT_ID", "CYCLE_ID"])
def test_post_live_frame_is_a_noop_without_the_orchestrator_env(monkeypatch, missing):
    """A local/manual effector run (no cycle, no orchestrator) has nowhere to post
    to — it must not try, not fail, and not log noise."""
    for var in ("NanoCrew_HOST", "AGENT_ID", "CYCLE_ID"):
        monkeypatch.setenv(var, "set")
    monkeypatch.delenv(missing)

    with patch.object(react_loop.urllib.request, "urlopen") as fake_urlopen:
        react_loop._post_live_frame(_FRAME)

    fake_urlopen.assert_not_called()


def test_post_live_frame_swallows_a_dead_orchestrator(monkeypatch):
    monkeypatch.setenv("NanoCrew_HOST", "http://host.docker.internal:3002")
    monkeypatch.setenv("AGENT_ID", "agent-abc")
    monkeypatch.setenv("CYCLE_ID", "cycle-xyz")

    with patch.object(react_loop.urllib.request, "urlopen", side_effect=OSError("connection refused")):
        react_loop._post_live_frame(_FRAME)  # must not raise


# ─── The loop: does a real run actually ship frames, and at what rate? ─────────

@pytest.mark.asyncio
async def test_a_real_run_pushes_frames_at_the_two_wired_points(monkeypatch):
    """With the throttle disabled, count the push points a run passes through:
    start-of-turn and just-after-the-action, for each of the two acting turns,
    plus start-of-turn for the "done" turn (which returns before any action).
    Five is the whole wiring, stated as a number so a later step that adds or
    drops a push point has to say so here."""
    monkeypatch.setattr(react_loop, "_MIN_FRAME_INTERVAL_S", 0.0)
    sent: list[tuple] = []

    # Three arguments since stage45 item 2 (data_url, url, title) — a bare
    # `sent.append` silently swallowed the extras as a TypeError inside an un-awaited
    # future, which is exactly how this suite caught the contract change.
    with patch.object(react_loop, "_post_live_frame",
                      side_effect=lambda *a, **kw: sent.append(a)):
        result = await react_loop.run_react_loop(
            page=FakePage(), provider=ScriptedProvider(_SCRIPT), model="fake/decision",
            goal="fill the form", max_turns=5, use_human_cadence=False,
            # "Submit" trips the danger gate, which has no approver outside a real
            # cycle — off here so these tests exercise the frame wiring, not that.
            require_approval=False,
            frame_source=lambda: _FRAME,
        )
        _wait_for(lambda: len(sent) >= 5)

    assert result.success is True, result
    assert len(sent) == 5, sent
    # Each entry is now the full (data_url, url, title) argument tuple.
    assert all(args[0] == _FRAME for args in sent)


@pytest.mark.asyncio
async def test_the_throttle_actually_bounds_the_rate():
    """Same run, real 0.5s interval. A scripted run finishes in milliseconds, so
    every push point after the first falls inside one interval — exactly one frame
    goes out. Without the throttle this run would post five times, which is the
    per-turn flood the interval exists to prevent."""
    assert react_loop._MIN_FRAME_INTERVAL_S == 0.5  # doc 01's stated 2fps default
    sent: list[tuple] = []

    # Three arguments since stage45 item 2 (data_url, url, title) — a bare
    # `sent.append` silently swallowed the extras as a TypeError inside an un-awaited
    # future, which is exactly how this suite caught the contract change.
    with patch.object(react_loop, "_post_live_frame",
                      side_effect=lambda *a, **kw: sent.append(a)):
        result = await react_loop.run_react_loop(
            page=FakePage(), provider=ScriptedProvider(_SCRIPT), model="fake/decision",
            goal="fill the form", max_turns=5, use_human_cadence=False,
            # "Submit" trips the danger gate, which has no approver outside a real
            # cycle — off here so these tests exercise the frame wiring, not that.
            require_approval=False,
            frame_source=lambda: _FRAME,
        )
        _wait_for(lambda: len(sent) >= 1)

    assert result.success is True, result
    assert len(sent) == 1, sent


@pytest.mark.asyncio
async def test_no_frame_source_means_no_pushes_at_all():
    """Every caller that doesn't own an EffectorSession (and the swarm, which owns
    several on purpose) leaves frame_source unset — that path must be byte-for-byte
    the old behaviour, not "posts and gets ignored"."""
    sent: list[tuple] = []

    # Three arguments since stage45 item 2 (data_url, url, title) — a bare
    # `sent.append` silently swallowed the extras as a TypeError inside an un-awaited
    # future, which is exactly how this suite caught the contract change.
    with patch.object(react_loop, "_post_live_frame",
                      side_effect=lambda *a, **kw: sent.append(a)):
        result = await react_loop.run_react_loop(
            page=FakePage(), provider=ScriptedProvider(_SCRIPT), model="fake/decision",
            goal="fill the form", max_turns=5, use_human_cadence=False,
            # "Submit" trips the danger gate, which has no approver outside a real
            # cycle — off here so these tests exercise the frame wiring, not that.
            require_approval=False,
        )
        await asyncio.sleep(0.05)

    assert result.success is True, result
    assert sent == []


@pytest.mark.asyncio
async def test_no_frame_delivered_yet_is_not_an_error(monkeypatch):
    """`last_frame_data_url` is None until the first CDP frame arrives — and stays
    None for the whole run if the browser build has no screencast support at all
    (step 1 fails soft there). Neither may post an empty frame."""
    monkeypatch.setattr(react_loop, "_MIN_FRAME_INTERVAL_S", 0.0)
    sent: list[tuple] = []

    # Three arguments since stage45 item 2 (data_url, url, title) — a bare
    # `sent.append` silently swallowed the extras as a TypeError inside an un-awaited
    # future, which is exactly how this suite caught the contract change.
    with patch.object(react_loop, "_post_live_frame",
                      side_effect=lambda *a, **kw: sent.append(a)):
        result = await react_loop.run_react_loop(
            page=FakePage(), provider=ScriptedProvider(_SCRIPT), model="fake/decision",
            goal="fill the form", max_turns=5, use_human_cadence=False,
            # "Submit" trips the danger gate, which has no approver outside a real
            # cycle — off here so these tests exercise the frame wiring, not that.
            require_approval=False,
            frame_source=lambda: None,
        )
        await asyncio.sleep(0.05)

    assert result.success is True, result
    assert sent == []


@pytest.mark.asyncio
async def test_a_frame_source_that_raises_never_fails_the_run(monkeypatch):
    """The contract that matters most: the agent's actual task completes even when
    the live-view plumbing is broken."""
    monkeypatch.setattr(react_loop, "_MIN_FRAME_INTERVAL_S", 0.0)
    exploding = MagicMock(side_effect=RuntimeError("session went away"))

    with patch.object(react_loop, "_post_live_frame") as fake_post:
        result = await react_loop.run_react_loop(
            page=FakePage(), provider=ScriptedProvider(_SCRIPT), model="fake/decision",
            goal="fill the form", max_turns=5, use_human_cadence=False,
            # "Submit" trips the danger gate, which has no approver outside a real
            # cycle — off here so these tests exercise the frame wiring, not that.
            require_approval=False,
            frame_source=exploding,
        )

    assert result.success is True, result
    assert exploding.call_count >= 1  # it really was called, and really did raise
    fake_post.assert_not_called()
