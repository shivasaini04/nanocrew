"""The operator's browser picker wins over the model's `identity` (stage 60 phase 1).

The chat has a picker under the message box: Cloud or This computer. The orchestrator
turns it into NC_BROWSER_LANE for the one message. These tests pin the three things that
choice must mean inside the container:

  * local  — a call that says nothing, or says 'anonymous', still uses their browser
  * cloud  — asking for 'me' is refused, with a message about the picker rather than a
             broken connection
  * unset  — nothing changes; stage 52's per-call `identity` still decides
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.tools.browser_lane import chosen_lane, resolve_identity
from nanoagent.agent.tools.effector import EffectorTool


class RecordingSession:
    """Captures how EffectorSession was asked to be built (same shape as stage 52's test)."""

    calls: list[dict] = []

    def __init__(self, workspace, **kwargs):
        RecordingSession.calls.append(kwargs)
        self._remote = kwargs.get("allow_remote") is not False
        self.page = object()
        self.context = None
        self.capabilities = None
        self.engine = "chromium"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


def _connected(monkeypatch, yes: bool) -> None:
    import nanoagent.agent.effector.remote_page as rp

    monkeypatch.setattr(rp.RemoteConfig, "from_env", classmethod(lambda cls: object() if yes else None))


async def _run(tool: EffectorTool, **kwargs):
    kwargs.setdefault("goal", "do the thing")
    return await tool.execute(**kwargs)


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    monkeypatch.delenv("NC_BROWSER_LANE", raising=False)
    RecordingSession.calls = []
    yield
    RecordingSession.calls = []


def test_resolve_identity_table(monkeypatch):
    assert resolve_identity(None) == "anonymous"
    assert resolve_identity("me") == "me"

    monkeypatch.setenv("NC_BROWSER_LANE", "local")
    assert resolve_identity(None) == "me"
    assert resolve_identity("anonymous") == "me"

    monkeypatch.setenv("NC_BROWSER_LANE", "cloud")
    assert resolve_identity(None) == "anonymous"
    # 'me' stays 'me' so the tool reaches its not-connected branch and SAYS so, rather
    # than silently running an account action as nobody.
    assert resolve_identity("me") == "me"

    monkeypatch.setenv("NC_BROWSER_LANE", "garbage")
    assert chosen_lane() is None


def _effector_session_kwargs(identity: str | None) -> dict:
    tool = EffectorTool(Path("/tmp"), provider=object(), model="m")
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", RecordingSession):
        with patch(
            "nanoagent.agent.effector.react_loop.run_react_loop",
            side_effect=RuntimeError("stop after the session is built"),
        ):
            kwargs = {} if identity is None else {"identity": identity}
            asyncio.run(_run(tool, **kwargs))
    assert RecordingSession.calls, "the session was never constructed"
    return RecordingSession.calls[0]


def test_local_choice_uses_their_browser_even_when_the_model_says_anonymous(monkeypatch):
    _connected(monkeypatch, True)
    monkeypatch.setenv("NC_BROWSER_LANE", "local")
    assert _effector_session_kwargs("anonymous")["allow_remote"] is None


def test_local_choice_uses_their_browser_when_the_model_says_nothing(monkeypatch):
    _connected(monkeypatch, True)
    monkeypatch.setenv("NC_BROWSER_LANE", "local")
    assert _effector_session_kwargs(None)["allow_remote"] is None


def test_no_choice_keeps_stage52_behaviour(monkeypatch):
    _connected(monkeypatch, True)
    assert _effector_session_kwargs("anonymous")["allow_remote"] is False


def test_cloud_choice_refuses_me_and_names_the_picker(monkeypatch):
    # The orchestrator hands a cloud message no controller, so RemoteConfig is absent.
    _connected(monkeypatch, False)
    monkeypatch.setenv("NC_BROWSER_LANE", "cloud")
    tool = EffectorTool(Path("/tmp"), provider=object(), model="m")
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", RecordingSession):
        out = json.loads(asyncio.run(_run(tool, identity="me")))
    assert out["success"] is False
    assert "Cloud browser" in out["error"]
    assert "This computer" in out["error"]
    assert not RecordingSession.calls, "no browser should have been opened"


def test_browser_tool_follows_the_picker(monkeypatch):
    from nanoagent.agent.tools.browser import BrowserTool

    _connected(monkeypatch, False)
    monkeypatch.setenv("NC_BROWSER_LANE", "cloud")
    out = json.loads(asyncio.run(BrowserTool(Path("/tmp")).execute("navigate", url="https://example.com", identity="me")))
    assert "Cloud browser" in out["error"]

    monkeypatch.setenv("NC_BROWSER_LANE", "local")
    # Local + not connected: even with no identity passed, it must refuse rather than
    # quietly open the container browser.
    out = json.loads(asyncio.run(BrowserTool(Path("/tmp")).execute("navigate", url="https://example.com")))
    assert "desktop app" in out["error"]
