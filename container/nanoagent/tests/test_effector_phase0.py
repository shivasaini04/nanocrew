"""Phase 0 reachability test for Effector (stage43 doc 03).

Per the stage's own verification discipline (citing stage 42: "shipped" was not the
same as "runs"): this drives the REAL `EffectorTool.execute()` -> react_loop ->
executor -> resolver -> dom_snapshot chain — the exact path `loop.py` invokes when the
LLM calls the `effector` tool — not just unit tests of isolated functions. Only the
literal browser process is stubbed (a real headless Chromium isn't practical inside a
unit-test run); the LLM provider and Playwright Page are fakes with scripted/simulated
behavior, everything downstream of them is the real Effector code.

A real-browser, real-LLM smoke run against a live page is a separate, container-side
manual check — this test proves the wiring, not the browser or the model.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.tools.effector import EffectorTool


# ─── Fake Playwright surface ───────────────────────────────────────────────────

class FakeLocator:
    def __init__(self, page: "FakePage", selector: str, matched: bool):
        self._page = page
        self._selector = selector
        self._matched = matched

    async def count(self) -> int:
        return 1 if self._matched else 0

    @property
    def first(self) -> "FakeLocator":
        return self

    async def click(self, **kw):
        self._page.actions.append(("click", self._selector))

    async def fill(self, text: str, **kw):
        self._page.actions.append(("fill", self._selector, text))

    async def is_visible(self, **kw) -> bool:
        return self._matched

    async def inner_text(self) -> str:
        return "ok"


class FakeMouse:
    def __init__(self, page: "FakePage"):
        self._page = page

    async def click(self, x, y, **kw):
        self._page.actions.append(("mouse_click", x, y))

    async def wheel(self, dx, dy):
        pass

    async def move(self, x, y):
        pass

    async def dblclick(self, x, y):
        self._page.actions.append(("mouse_dblclick", x, y))


class FakeKeyboard:
    def __init__(self, page: "FakePage"):
        self._page = page

    async def type(self, text, **kw):
        self._page.actions.append(("kb_type", text))

    async def press(self, key, **kw):
        self._page.actions.append(("kb_press", key))


# Two real interactive elements a snapshot would find on a simple login-style form.
_FAKE_ELEMENTS = [
    {
        "tag": "input", "role": "textbox", "name": "Name", "type": "text",
        "selector": "#name", "bounds": {"x": 10, "y": 10, "width": 200, "height": 30},
        "center": {"x": 110, "y": 25}, "isEnabled": True,
    },
    {
        "tag": "button", "role": "button", "name": "Submit",
        "selector": "#submit", "bounds": {"x": 10, "y": 60, "width": 100, "height": 30},
        "center": {"x": 60, "y": 75}, "isEnabled": True,
    },
]


class FakePage:
    def __init__(self):
        self.url = "https://example.test/form"
        self.viewport_size = {"width": 1280, "height": 720}
        self.actions: list[tuple] = []
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)

    async def title(self) -> str:
        return "Test Form"

    async def evaluate(self, script: str, arg=None):
        if "MutationObserver" in script:
            return True  # DOM settle: report settled immediately
        if 'role="listbox"' in script:
            # Checked BEFORE the generic "querySelectorAll" branch below — the
            # listbox-open check (executor.py's _LISTBOX_OPEN_JS) also contains
            # that substring, and would otherwise match the DOM-snapshot branch
            # and return _FAKE_ELEMENTS (a non-empty list, i.e. always truthy) for
            # every type action in every test. No dropdown open by default; a
            # test that needs one open overrides evaluate() itself.
            return False
        if "querySelectorAll" in script:
            return _FAKE_ELEMENTS
        return None

    def locator(self, selector: str) -> FakeLocator:
        return FakeLocator(self, selector, matched=selector in ("#name", "#submit"))

    def get_by_text(self, text, exact=False) -> FakeLocator:
        return FakeLocator(self, text, matched=False)

    def get_by_role(self, role, name=None) -> FakeLocator:
        return FakeLocator(self, role, matched=False)

    def get_by_label(self, text, exact=False) -> FakeLocator:
        return FakeLocator(self, text, matched=False)

    def get_by_placeholder(self, text, exact=False) -> FakeLocator:
        return FakeLocator(self, text, matched=False)

    async def wait_for_load_state(self, *a, **kw):
        pass

    async def wait_for_timeout(self, ms):
        pass

    async def wait_for_selector(self, *a, **kw):
        pass

    async def wait_for_function(self, *a, **kw):
        pass

    async def goto(self, url, **kw):
        self.url = url

    async def screenshot(self, **kw) -> bytes:
        return b"\xff\xd8\xff\xe0fake-jpeg"


class FakeContext:
    """Minimal fake BrowserContext — just enough for TabManager to construct
    against (it calls context.on('page', ...) and reads context.pages)."""

    def __init__(self, pages=None):
        self.pages = pages or []
        self._handlers: dict[str, list] = {}

    def on(self, event, handler):
        self._handlers.setdefault(event, []).append(handler)


class FakeSession:
    """Stands in for EffectorSession — the only thing stubbed. Everything the real
    session would hand to react_loop (a `.page`/`.context`) is fake instead of real
    Playwright objects; the browser launch/session-persistence code isn't exercised
    here (that needs a real container — see module docstring)."""

    def __init__(self, *a, **kw):
        self.page = FakePage()
        self.context = FakeContext(pages=[self.page])
        # stage45 gap E: a REAL DownloadManager, not a stub. The tool passes this
        # straight through to the executor, so a fake here would only prove the fake
        # agrees with itself — and the manager touches nothing but the filesystem, so
        # the real one is safe in a unit test. `workspace` is the first positional arg
        # every caller passes; tests that construct FakeSession with no arguments get
        # a temp directory instead.
        from pathlib import Path
        from tempfile import mkdtemp

        from nanoagent.agent.effector.downloads import DownloadManager

        workspace = Path(a[0]) if a else Path(kw.get("workspace") or mkdtemp())
        self.downloads = DownloadManager(workspace=workspace)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        pass


@dataclass
class FakeLLMResponse:
    content: str | None
    tool_calls: list = field(default_factory=list)
    usage: dict | None = None


class ScriptedProvider:
    """Fake LLM provider returning a pre-scripted sequence of react_loop decisions —
    deterministic, no network call, no API key needed."""

    def __init__(self, script: list[dict]):
        self._script = list(script)
        self.calls = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw) -> FakeLLMResponse:
        action = self._script[min(self.calls, len(self._script) - 1)]
        self.calls += 1
        # Fixed per-call usage — deterministic, so metrics/usage-accumulation tests
        # can assert exact totals (calls * these numbers) rather than "> 0".
        usage = {
            "prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
            "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
        }
        return FakeLLMResponse(content=json.dumps(action), usage=usage)

    def get_default_model(self) -> str:
        return "fake/decision-model"


# ─── The actual reachability test ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_effector_tool_completes_a_real_task_through_the_real_tool_call_path(tmp_path: Path):
    """Drives the real Tool -> react_loop -> executor -> resolver -> dom_snapshot
    chain for a 3-turn task: type into a field, click submit, report done."""
    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "form submitted", "action": "done", "extractedData": {"submitted": True}},
    ]
    provider = ScriptedProvider(script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path,
        provider=provider,
        model="fake/primary-model",
        decision_provider=provider,
        decision_model="fake/decision-model",
        vision_provider=None,
        vision_model=None,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="Fill in the name field and submit the form")

    result = json.loads(raw)

    assert result["success"] is True, result
    assert result["turns_executed"] == 3
    assert result["extracted_data"] == {"submitted": True}
    assert provider.calls == 3


@pytest.mark.asyncio
async def test_effector_executor_actually_dispatched_real_playwright_shaped_calls(tmp_path: Path):
    """Companion assertion to the test above: inspect the FakePage's recorded actions
    directly, so a bug that made react_loop report success without the executor doing
    anything (the exact failure shape stage 42 warns about) would fail this test."""
    script = [
        {"thought": "fill the name field", "action": "type", "target": "@e1", "text": "Ada Lovelace"},
        {"thought": "submit the form", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    fake_session = FakeSession()

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path,
        provider=provider,
        model="fake/primary-model",
        decision_provider=provider,
        decision_model="fake/decision-model",
        # Phase 2 wired human-cadence typing (char-by-char via stealth.human_type)
        # in place of an instant .fill() when cadence is on, matching the TS
        # original. This test wants the mechanical fill/click assertion below, not
        # cadence behavior — that's covered separately in test_effector_phase2.py.
        use_human_cadence=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", return_value=fake_session):
        raw = await tool.execute(goal="Fill in the name field and submit the form")

    result = json.loads(raw)
    assert result["success"] is True, result

    page = fake_session.page
    assert ("fill", "#name", "Ada Lovelace") in page.actions
    assert ("click", "#submit") in page.actions


@pytest.mark.asyncio
async def test_effector_reports_failure_when_a_step_fails(tmp_path: Path):
    """The loop must not report success when a step genuinely fails — the same
    silent-success failure mode `reference_agent_records_are_not_evidence` warns about."""
    script = [
        {"thought": "click something that doesn't exist", "action": "click", "target": "#does-not-exist"},
    ]
    provider = ScriptedProvider(script)

    tool = EffectorTool(require_approval=False, 
        workspace=tmp_path,
        provider=provider,
        model="fake/primary-model",
        decision_provider=provider,
        decision_model="fake/decision-model",
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="Click a button that isn't on the page")

    result = json.loads(raw)
    assert result["success"] is False
    assert result["error"] is not None
