"""Stage 61 phase 7 — desktop_task: a self-driving loop over the user's desktop.

Offline: a simulated app stands in for a real computer. Stage 63 made the loop's
destination a BACKEND rather than a hard-wired `dispatch` call, so the fake is injected
through that seam now — which is also what the benchmark and the Windows path do, so
these tests exercise the same wiring production uses instead of a patched module global.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from nanoagent.agent.tools import desktop_task as dt
from test_effector_phase0 import ScriptedProvider


class FakeDesktop:
    """A tiny app: a text box and two buttons. Typing changes the box's name."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.text = ""

    async def __call__(self, capability, payload):
        self.calls.append((capability, payload))
        if capability == "desktop.ui_tree":
            return {"window": "Untitled - Notepad", "elements": [
                {"name": self.text or "Text editor", "type": "Edit", "enabled": True, "x": 400, "y": 300},
                {"name": "Save", "type": "Button", "enabled": True, "x": 50, "y": 20},
                {"name": "Send to printer", "type": "Button", "enabled": True, "x": 90, "y": 20},
            ]}
        if capability == "desktop.type":
            self.text = payload["text"]
        return {"ok": True}


class FakeBackend:
    """The DesktopBackend seam, wired to the simulated app.

    Speaks capability names on the way through so the assertions below still read the
    same traffic the desktop app would receive.
    """

    name = "fake"

    def __init__(self, app):
        self.app = app

    async def ui_tree(self, *, max_elements, reason):
        return await self.app("desktop.ui_tree", {"maxElements": max_elements, "reason": reason})

    async def click(self, *, token, x, y, button, double, reason):
        return await self.app("desktop.click", {"token": token, "x": x, "y": y,
                                                "button": button, "double": double, "reason": reason})

    async def type_text(self, *, text, token, reason):
        return await self.app("desktop.type", {"text": text, "token": token, "reason": reason})

    async def key(self, *, keys, reason):
        return await self.app("desktop.key", {"keys": keys, "reason": reason})

    async def screenshot(self, *, reason):
        return await self.app("desktop.screenshot", {"reason": reason})


@pytest.fixture
def fake(monkeypatch):
    return FakeDesktop()


def _tool(tmp_path, script, backend=None):
    return dt.DesktopTaskTool(workspace=tmp_path, provider=ScriptedProvider(script),
                              model="fake/decider", backend=backend)


@pytest.mark.asyncio
async def test_clicks_land_on_the_controls_recorded_centre(tmp_path, fake):
    out = json.loads(await _tool(tmp_path, [
        {"thought": "focus editor", "action": "click", "target": "@d1", "x": 9999, "y": 9999},
        {"thought": "type", "action": "type", "text": "hello"},
        {"thought": "done", "action": "done", "extractedData": {"text": "hello"}},
    ], FakeBackend(fake)).execute(goal="write hello"))
    assert out["success"] is True and out["outcome"] == "done"
    clicks = [p for c, p in fake.calls if c == "desktop.click"]
    assert clicks and (clicks[0]["x"], clicks[0]["y"]) == (400, 300)  # never the model's numbers
    assert ("desktop.type", {"text": "hello", "token": None, "reason": None}) in fake.calls
    # Typing is an in-place change, so a value on screen is not proof the action worked.
    assert out["proof"]["status"] == "unknown"


@pytest.mark.asyncio
async def test_a_read_with_no_actions_can_be_verified(tmp_path, fake):
    out = json.loads(await _tool(tmp_path, [
        {"thought": "read title", "action": "done", "extractedData": {"button": "Save"}},
    ], FakeBackend(fake)).execute(goal="what does the first button say"))
    assert out["proof"]["status"] == "verified"


@pytest.mark.asyncio
async def test_it_will_not_click_an_irreversible_control(tmp_path, fake):
    out = json.loads(await _tool(tmp_path, [
        {"thought": "print", "action": "click", "target": "@d3"},
    ], FakeBackend(fake)).execute(goal="print it"))
    assert out["outcome"] == "needs_approval"
    assert "Send to printer" in out["error"]
    assert not [c for c, _ in fake.calls if c == "desktop.click"]


@pytest.mark.asyncio
async def test_actions_that_change_nothing_stop_the_loop(tmp_path, fake):
    out = json.loads(await _tool(tmp_path, [
        {"thought": "click save", "action": "click", "target": "@d2"},
    ], FakeBackend(fake)).execute(goal="save the file"))
    assert out["outcome"] == "stuck"
    assert len([c for c, _ in fake.calls if c == "desktop.click"]) <= 3


@pytest.mark.asyncio
async def test_an_unknown_control_is_a_failed_step_not_a_guess(tmp_path, fake):
    out = json.loads(await _tool(tmp_path, [
        {"thought": "x", "action": "click", "target": "@d99"},
        {"thought": "done", "action": "done"},
    ], FakeBackend(fake)).execute(goal="g"))
    assert out["outcome"] == "done"
    assert not [c for c, _ in fake.calls if c == "desktop.click"]


@pytest.mark.asyncio
async def test_no_computer_connected_says_so(tmp_path, monkeypatch):
    async def unavailable(cap, payload):
        raise dt.LocalUnavailable("Pick This computer under the message box.")
    out = json.loads(await _tool(tmp_path, [{"action": "done"}], FakeBackend(unavailable)).execute(goal="g"))
    assert out["success"] is False and "This computer" in out["error"]


@pytest.mark.asyncio
async def test_every_step_is_recorded(tmp_path, fake):
    from nanoagent.agent.effector.decision_log import read_records
    await _tool(tmp_path, [
        {"thought": "focus", "action": "click", "target": "@d1"},
        {"thought": "done", "action": "done"},
    ], FakeBackend(fake)).execute(goal="g")
    kinds = [r["type"] for r in read_records(tmp_path)]
    assert kinds.count("decision") == 2 and "outcome" in kinds and "proof" in kinds
