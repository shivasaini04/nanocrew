"""Tests for the post-live-test gap-closing pass, 2026-08-23: the blocking approval
round trip, TabManager wiring into react_loop, and fingerprint diversity.

The `effector_escalate` half was deleted 2026-09-03 — see the note further down. What
remains here is `request_approval`, which is the gate and always was the real thing. Same discipline as every other phase — real code paths,
not isolated units asserting on themselves.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.escalation import (
    APPROVAL_TIMED_OUT,
    APPROVAL_UNAVAILABLE,
    is_approved,
    request_approval,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES, pick_device_profile
from nanoagent.agent.effector.stealth.stealth import build_stealth_init_script
from nanoagent.agent.effector.types import Step

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse, FakeSession, ScriptedProvider


# ─── Blocking round trip: registration + poll-until-decision ───────────────────

class _FakeResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload

    def json(self):
        return self._payload


def _fake_client_factory(post_response, poll_responses):
    """poll_responses: list consumed in order, one per GET call."""
    poll_iter = iter(poll_responses)

    class FakeAsyncClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def post(self, url, json=None, headers=None, timeout=None):
            return post_response

        async def get(self, url, headers=None, timeout=None):
            return next(poll_iter)

    return FakeAsyncClient


@pytest.mark.asyncio
async def test_request_approval_blocks_until_approved(monkeypatch):
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://host.docker.internal:3002")

    post_resp = _FakeResponse(200, {"approvalId": "appr-1", "createdAt": "now"})
    poll_sequence = [
        _FakeResponse(200, {"decision": "pending"}),
        _FakeResponse(200, {"decision": "pending"}),
        _FakeResponse(200, {"decision": "approved"}),
    ]
    fake_client_cls = _fake_client_factory(post_resp, poll_sequence)

    step = Step(step=1, action="click", target="Submit payment", is_dangerous=True)

    with patch("httpx.AsyncClient", fake_client_cls), patch("asyncio.sleep", return_value=None):
        decision = await request_approval(step, agent_id="agent-1", run_id="run-1", page=None)

    assert decision == "approved"


@pytest.mark.asyncio
async def test_request_approval_blocks_until_denied(monkeypatch):
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://host.docker.internal:3002")

    post_resp = _FakeResponse(200, {"approvalId": "appr-2"})
    poll_sequence = [_FakeResponse(200, {"decision": "denied"})]
    fake_client_cls = _fake_client_factory(post_resp, poll_sequence)

    step = Step(step=1, action="click", target="Delete account", is_dangerous=True)

    with patch("httpx.AsyncClient", fake_client_cls), patch("asyncio.sleep", return_value=None):
        decision = await request_approval(step, agent_id="agent-1", run_id="run-1", page=None)

    assert decision == "denied"


@pytest.mark.asyncio
async def test_request_approval_times_out_after_max_wait(monkeypatch):
    """Every poll returns 'pending' forever — must eventually give up and deny,
    not hang or loop forever."""
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    post_resp = _FakeResponse(200, {"approvalId": "appr-3"})

    class AlwaysPendingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def post(self, url, json=None, headers=None, timeout=None):
            return post_resp

        async def get(self, url, headers=None, timeout=None):
            return _FakeResponse(200, {"decision": "pending"})

    step = Step(step=1, action="click", target="Confirm purchase", is_dangerous=True)

    with patch("httpx.AsyncClient", AlwaysPendingClient), patch("asyncio.sleep", return_value=None):
        decision = await request_approval(step, agent_id="agent-1", run_id="run-1", page=None)

    # Stage 49 phase 1: still blocks, but is no longer spelled "denied" — nobody
    # refused this, nobody answered. The safety property is is_approved(), not the label.
    assert not is_approved(decision)
    assert decision == APPROVAL_TIMED_OUT


@pytest.mark.asyncio
async def test_request_approval_fails_safe_when_registration_rejected(monkeypatch):
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    class RejectingClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

        async def post(self, url, json=None, headers=None, timeout=None):
            return _FakeResponse(401, {"error": "invalid token"})

    step = Step(step=1, action="click", target="Submit", is_dangerous=True)

    with patch("httpx.AsyncClient", RejectingClient):
        decision = await request_approval(step, agent_id="agent-1", run_id="run-1", page=None)

    assert not is_approved(decision)
    assert decision == APPROVAL_UNAVAILABLE


@pytest.mark.asyncio
async def test_request_approval_fails_safe_with_no_cycle_token(monkeypatch):
    """Outside a real cycle (no token) — must deny immediately, not attempt httpx
    at all, matching every other bridged tool's contract (get_credential.py etc)."""
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    called = {"post": False}

    class ShouldNeverBeCalledClient:
        async def __aenter__(self):
            called["post"] = True
            return self

        async def __aexit__(self, *a):
            pass

    step = Step(step=1, action="click", target="Submit", is_dangerous=True)

    with patch("httpx.AsyncClient", ShouldNeverBeCalledClient):
        decision = await request_approval(step, agent_id="agent-1", run_id="run-1", page=None)

    assert not is_approved(decision)
    assert decision == APPROVAL_UNAVAILABLE
    assert called["post"] is False


# ─── effector_escalate: deleted 2026-09-03 ──────────────────────────────────────
#
# Its two tests went with it. The tool wrapped a reason in a synthetic Step and called
# request_approval, so it was an approve/deny round trip in which nobody touched a
# browser — for a CAPTCHA, its own headline example, approving achieved nothing.
#
# Real takeover is a `takeover` action inside the ReAct loop (stage 49 phase 5.4),
# covered by tests/test_stage49_phase54_takeover_state.py. It had to live there: an
# outer-loop tool runs after the effector session has closed, so there is no browser
# left to hand over.

# ─── TabManager wiring in react_loop ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_react_loop_follows_a_new_tab_opened_mid_task(tmp_path: Path):
    """The actual gap that was found: a step opens a popup, and the NEXT turn must
    act on the popup, not the stale original page. The popup opens SYNCHRONOUSLY
    as part of the triggering click (as a real Playwright popup does by the time
    the action awaits complete), not via a fire-and-forget callback — avoids an
    artificial race in the test itself."""
    from nanoagent.agent.effector.capabilities.tab_manager import TabManager
    from nanoagent.agent.effector.react_loop import run_react_loop
    from test_effector_phase0 import FakeContext, _FAKE_ELEMENTS

    class PopupAwarePage:
        def __init__(self, label, elements):
            self.label = label
            self.url = f"https://example.test/{label}"
            self.viewport_size = {"width": 1280, "height": 720}
            self.actions = []
            self.mouse = FakeMouse(self)
            self.keyboard = FakeKeyboard(self)
            self._elements = elements

        async def title(self):
            return self.label

        async def evaluate(self, script, arg=None):
            if "MutationObserver" in script:
                return True
            if "querySelectorAll" in script:
                return self._elements
            return ""

        async def wait_for_timeout(self, ms):
            pass

        def on(self, event, handler):
            pass  # TabManager registers a close handler on every page it tracks

        def locator(self, selector):
            matched = selector in [e["selector"] for e in self._elements]
            return PopupTriggerLocator(self, selector, matched, context, popup_page) if selector == "#opens-popup" else FakeLocator(self, selector, matched=matched)

        def get_by_text(self, *a, **kw):
            return FakeLocator(self, "x", matched=False)

        def get_by_role(self, *a, **kw):
            return FakeLocator(self, "x", matched=False)

        def get_by_label(self, *a, **kw):
            return FakeLocator(self, "x", matched=False)

        def get_by_placeholder(self, *a, **kw):
            return FakeLocator(self, "x", matched=False)

    class PopupTriggerLocator(FakeLocator):
        """Clicking this element opens a new tab, synchronously, before the click
        call returns — matching a real target=_blank link or window.open()."""

        def __init__(self, page, selector, matched, context, popup_page):
            super().__init__(page, selector, matched)
            self._context = context
            self._popup_page = popup_page

        async def click(self, **kw):
            await super().click(**kw)
            for handler in self._context._handlers.get("page", []):
                handler(self._popup_page)

    original_elements = [{
        "tag": "button", "role": "button", "name": "Open popup", "selector": "#opens-popup",
        "bounds": {"x": 0, "y": 0, "width": 50, "height": 20}, "center": {"x": 25, "y": 10}, "isEnabled": True,
    }]
    popup_elements = [{
        "tag": "button", "role": "button", "name": "Accept", "selector": "#popup-accept",
        "bounds": {"x": 0, "y": 0, "width": 50, "height": 20}, "center": {"x": 25, "y": 10}, "isEnabled": True,
    }]

    original_page = PopupAwarePage("original", original_elements)
    popup_page = PopupAwarePage("popup", popup_elements)

    context = FakeContext(pages=[original_page])
    tab_manager = TabManager(context, initial_page=original_page)

    script = [
        {"thought": "open the popup", "action": "click", "target": "@e1"},
        {"thought": "accept in the popup", "action": "click", "target": "@e1"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)

    result = await run_react_loop(
        page=original_page, provider=provider, model="fake/decision", goal="accept the popup",
        max_turns=5, tab_manager=tab_manager, use_human_cadence=False,
    )

    assert result.success is True, result
    assert ("click", "#popup-accept") in popup_page.actions
    assert tab_manager.get_active_page() is popup_page


# ─── Fingerprint diversity ───────────────────────────────────────────────────

def test_pick_device_profile_is_stable_per_domain():
    p1 = pick_device_profile("linkedin.com")
    p2 = pick_device_profile("linkedin.com")
    assert p1.name == p2.name  # same site, same "device", every call


def test_pick_device_profile_varies_across_the_pool():
    """Not every domain should land on the same profile — that would defeat the
    point (a fleet that all look identical is itself a correlatable pattern)."""
    names = {pick_device_profile(f"site-{i}.example").name for i in range(20)}
    assert len(names) > 1


def test_build_stealth_init_script_substitutes_every_placeholder():
    for profile in DEVICE_PROFILES:
        script = build_stealth_init_script(profile)
        assert "__" not in script, f"unsubstituted placeholder left in script for {profile.name}"
        assert profile.gpu_vendor in script
        assert profile.gpu_renderer in script
        assert profile.platform in script
        assert str(profile.hardware_concurrency) in script
        assert "as any" not in script  # the original bug must stay fixed under every profile too


def test_different_profiles_produce_genuinely_different_scripts():
    a = build_stealth_init_script(DEVICE_PROFILES[0])
    b = build_stealth_init_script(DEVICE_PROFILES[1])
    assert a != b