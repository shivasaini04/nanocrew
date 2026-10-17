"""Which browser a tool call gets, decided per CALL by `identity`.

The workflow this exists for, in the user's own words (2026-09-06):

    "let's say i ask the agent to find the jobs for me now if it go for the local lane,
     there is risk to get ban my profile ... so for that it go with the anti stealth or
     simply the job sweep for the public jobs posting on linkedin and then filter out the
     job that match and then the local lane visit those job posting, contact the person
     related to that job like dm the ceo or cto"

Two kinds of work on the SAME site, needing opposite browsers:

  * the sweep — hundreds of public postings. Must NOT come from the user's account; a
    few hundred profile views in an hour is not something a person does, and the account
    gets restricted for it. Wants the container's stealth lane.
  * the outreach — three DMs. Can ONLY come from the user's account, because there is
    nowhere else to send from.

Before this, the lane was a property of the RUN: opt a run in, and every browser call in
it went through the user's signed-in Chrome, sweep included. So the tests below are about
one thing — that the two halves of one cycle can land in different browsers, and that the
dangerous direction (bulk work quietly becoming "the user") is the one that is closed.

They assert on what is passed to EffectorSession rather than on a launched browser: the
lane decision is the unit under test, and EffectorSession.__aenter__ is already covered
elsewhere.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.tools.browser import BrowserTool
from nanoagent.agent.tools.effector import _MAX_IDENTITY_ACTIONS, EffectorTool


# ── a stand-in for the session, recording how it was asked to be built ───────

class RecordingSession:
    """Captures the constructor kwargs and pretends to be the lane it was asked for."""

    calls: list[dict] = []

    def __init__(self, workspace, **kwargs):
        self.workspace = workspace
        self.kwargs = kwargs
        RecordingSession.calls.append(kwargs)
        # What EffectorSession.__aenter__ decides for real. Mirrored here so a test can
        # read `_remote` the way the tool does: allow_remote=False always stays in the
        # container; None follows the orchestrator, which these tests stub as opted in.
        self._remote = kwargs.get('allow_remote') is not False
        self.page = object()
        self.context = None
        self.capabilities = None
        self.engine = 'chromium'

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


@pytest.fixture(autouse=True)
def _reset():
    RecordingSession.calls = []
    yield
    RecordingSession.calls = []


def _connected(monkeypatch, yes: bool = True):
    """Stub whether the user's browser is attached to this run."""
    import nanoagent.agent.effector.remote_page as rp

    monkeypatch.setattr(
        rp.RemoteConfig, 'from_env',
        classmethod(lambda cls: object() if yes else None),
    )


# ── effector: the lane follows the identity, not the run ─────────────────────

def test_anonymous_stays_in_the_container_even_on_an_opted_in_run(monkeypatch):
    """The sweep half. This is the assertion the whole change is for.

    The run IS opted in — the user's browser is attached and available. An anonymous
    call must still refuse it, because "available" is not "appropriate": this is the
    call that runs hundreds of times.
    """
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch(
            'nanoagent.agent.effector.react_loop.run_react_loop',
            side_effect=RuntimeError('stop after the session is built'),
        ):
            asyncio.run(_run(tool, identity='anonymous'))

    assert RecordingSession.calls, 'the session was never constructed'
    assert RecordingSession.calls[0]['allow_remote'] is False


def test_me_asks_for_the_users_own_browser(monkeypatch):
    """The outreach half. allow_remote=None means "as the orchestrator decided"."""
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch(
            'nanoagent.agent.effector.react_loop.run_react_loop',
            side_effect=RuntimeError('stop after the session is built'),
        ):
            asyncio.run(_run(tool, identity='me'))

    assert RecordingSession.calls[0]['allow_remote'] is None


def test_the_default_is_anonymous():
    """Omitting `identity` must not mean "the user".

    The safe default has to be the silent one: a model that never learned the parameter
    exists should sweep as nobody, not as them.
    """
    import inspect

    sig = inspect.signature(EffectorTool.execute)
    assert sig.parameters['identity'].default == 'anonymous'

    sig = inspect.signature(BrowserTool.execute)
    assert 'identity' not in sig.parameters, 'browser reads identity out of **kwargs'


def test_me_without_a_connected_browser_fails_loudly(monkeypatch):
    """Never quietly fall back.

    A DM the user believes they sent, sent from an anonymous container browser, is not a
    smaller version of the task — it is a different one that silently did not happen. So
    the tool returns an error naming the fix rather than opening the other lane.
    """
    _connected(monkeypatch, False)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        out = json.loads(asyncio.run(_run(tool, identity='me')))

    assert out['success'] is False
    assert 'desktop app' in out['error']
    assert 'anonymous' in out['error'], 'it must tell the agent not to retry as anonymous'
    assert not RecordingSession.calls, 'no browser should have been opened at all'


# ── the ceiling ──────────────────────────────────────────────────────────────

def test_identity_runs_are_capped_at_three_external_actions(monkeypatch):
    """Not agent-adjustable.

    The agent asking for 200 is exactly the case this is for. It is a backstop rather
    than the control — the prompt is what should stop it wanting 200 — but a bad day
    should cost a wasted cycle, never someone's account.
    """
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')
    seen = {}

    async def _capture(*_args, **kwargs):
        seen.update(kwargs)
        raise RuntimeError('stop once the budget is known')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch('nanoagent.agent.effector.react_loop.run_react_loop', _capture):
            asyncio.run(_run(tool, identity='me', max_external_actions=200))

    assert seen['max_external_actions'] == _MAX_IDENTITY_ACTIONS


def test_anonymous_runs_keep_the_budget_they_asked_for(monkeypatch):
    """The cap is about acting AS someone, not about volume in general.

    A sweep legitimately wants a large budget; capping it there would break the half of
    the workflow that is supposed to run at volume.
    """
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')
    seen = {}

    async def _capture(*_args, **kwargs):
        seen.update(kwargs)
        raise RuntimeError('stop once the budget is known')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch('nanoagent.agent.effector.react_loop.run_react_loop', _capture):
            asyncio.run(_run(tool, identity='anonymous', max_external_actions=200))

    assert seen['max_external_actions'] == 200


def test_a_smaller_budget_is_not_raised_to_the_ceiling(monkeypatch):
    """min(), not "set to 3". Three is a ceiling, never a floor."""
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')
    seen = {}

    async def _capture(*_args, **kwargs):
        seen.update(kwargs)
        raise RuntimeError('stop once the budget is known')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch('nanoagent.agent.effector.react_loop.run_react_loop', _capture):
            asyncio.run(_run(tool, identity='me', max_external_actions=1))

    assert seen['max_external_actions'] == 1


# ── the whole workflow, in one cycle ─────────────────────────────────────────

def test_one_cycle_can_sweep_anonymously_then_act_as_the_user(monkeypatch):
    """The shape the user described, end to end.

    Two effector calls in a row on the same site, landing in different browsers. This
    works because EffectorSession is constructed per call rather than per cycle — the
    test exists to keep that true, since a future "reuse the session" optimisation would
    silently collapse both halves into whichever lane opened first.
    """
    _connected(monkeypatch, True)
    tool = EffectorTool(Path('/tmp'), provider=object(), model='m')

    with patch('nanoagent.agent.effector.browser_session.EffectorSession', RecordingSession):
        with patch(
            'nanoagent.agent.effector.react_loop.run_react_loop',
            side_effect=RuntimeError('stop after the session is built'),
        ):
            asyncio.run(_run(
                tool, identity='anonymous',
                goal='sweep public backend job postings on linkedin',
            ))
            asyncio.run(_run(
                tool, identity='me',
                goal='DM the CTO on the three postings that matched',
            ))

    lanes = [c['allow_remote'] for c in RecordingSession.calls]
    assert lanes == [False, None], f'expected container then user browser, got {lanes}'


# ── browser tool: the same switch, and the cached session honours it ─────────

def test_browser_tool_defaults_to_the_container(monkeypatch):
    """The hole this closes.

    `browser` passed no allow_remote at all, so on an opted-in run EVERY call — including
    the cheap reads a sweep is mostly made of — went through the user's own Chrome.
    """
    _connected(monkeypatch, True)
    tool = BrowserTool(Path('/tmp'))

    with patch('nanoagent.agent.effector.EffectorSession', RecordingSession, create=True):
        asyncio.run(tool._ensure_browser())

    assert RecordingSession.calls[0]['allow_remote'] is False


def test_browser_tool_reopens_when_the_identity_changes(monkeypatch):
    """The session is cached across calls, so the lane must not be.

    Without this, the first call of a cycle would decide the browser for every call after
    it — which is the tool-decides-the-lane bug the EffectorSession move already fixed
    once, reintroduced through the cache.
    """
    _connected(monkeypatch, True)
    tool = BrowserTool(Path('/tmp'))

    with patch('nanoagent.agent.effector.EffectorSession', RecordingSession, create=True):
        asyncio.run(tool._ensure_browser('anonymous'))
        asyncio.run(tool._ensure_browser('anonymous'))   # reuses, no new session
        asyncio.run(tool._ensure_browser('me'))          # different lane, must reopen

    lanes = [c['allow_remote'] for c in RecordingSession.calls]
    assert lanes == [False, None], f'expected one anonymous then one me, got {lanes}'


def test_browser_tool_me_without_a_browser_fails_loudly(monkeypatch):
    _connected(monkeypatch, False)
    tool = BrowserTool(Path('/tmp'))

    with patch('nanoagent.agent.effector.EffectorSession', RecordingSession, create=True):
        out = json.loads(asyncio.run(tool.execute('navigate', url='https://example.test/', identity='me')))

    assert 'desktop app' in out['error']
    assert not RecordingSession.calls


# ── helper ───────────────────────────────────────────────────────────────────

async def _run(tool: EffectorTool, **kwargs):
    """Call execute with a goal, swallowing the sentinel that stops the ReAct loop.

    The loop itself is not under test; these assertions are all about what happened
    before it started. A RuntimeError raised from the patched loop is caught by
    execute's own handler and returned as an error JSON, which is fine — the recorded
    constructor kwargs are what the tests read.
    """
    kwargs.setdefault('goal', 'do the thing')
    return await tool.execute(**kwargs)


# ── the prompt the "me" lane carries ─────────────────────────────────────────

def test_the_identity_rules_survive_the_canary_block():
    """The ask-before-send rules must actually reach the model.

    They are appended to the system prompt just above the canary block, which used to
    rebuild the prompt from the _SYSTEM_PROMPT constant rather than append to it. That
    was harmless while nothing else added anything, and would have silently discarded
    every one of these rules the moment something did — the run would look identical,
    the model would just never have been told.

    Asserting on the assembled string rather than mocking the LLM: what matters is that
    both pieces are in the text that goes out.
    """
    import re

    from nanoagent.agent.effector import react_loop as rl

    src = Path(rl.__file__).read_text(encoding='utf-8')
    block = re.search(r'if canary:\n(?:.*\n)*?\s+system_prompt = \(\n\s+f"([^"]*)"', src)
    assert block, 'could not find the canary prompt assembly'
    assert '{system_prompt}' in block.group(1), (
        'the canary block rebuilds from the constant instead of appending — anything '
        'added to system_prompt above it is thrown away'
    )


def test_the_remote_lane_prompt_names_the_takeover_and_the_scarcity():
    """Both halves of the rule, because either alone is wrong.

    "Ask before sending" without "you have very few actions" invites an agent to ask 200
    times. "Few actions" without "ask" gets three DMs sent that nobody read first.
    """
    from nanoagent.agent.effector import react_loop as rl

    src = Path(rl.__file__).read_text(encoding='utf-8')
    start = src.index('if _is_remote_lane(page):')
    block = src[start:start + 1400]

    assert 'takeover' in block
    assert 'exact text you intend' in block
    # Stage 60 phase 3: a list is allowed now, but only one the user approved.
    assert 'request_batch_approval' in block
    assert 'Never send to people who are not on an' in block
    # It must NOT ask about reads — a gate that fires on reading is one people learn to
    # wave through, which is the same reasoning browser.py's own gate records.
    assert 'Do not ask about reading' in block
