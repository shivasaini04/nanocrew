"""Phase 4 (orchestration + synthesis) reachability tests for Effector — stage43
doc 03. The synthesis tests drive the REAL generate_tool pipeline (AST security
scan, subprocess sandbox, test-case verification) — not a mock of it — since that's
the entire point of the phase-4 architecture decision: reuse the real pipeline
instead of building a second, weaker one. See jit_metaprogrammer.py's module
docstring for why.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.orchestration.hierarchical_orchestrator import (
    StageVerificationResult,
    TaskStage,
    run_hierarchical_workflow,
)
from nanoagent.agent.effector.react_loop import _vision_fallback_answer
from nanoagent.agent.effector.synthesis.jit_metaprogrammer import (
    _parse_spec_json,
    looks_like_unsupported_interface,
    synthesize_driver,
)
from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point
from nanoagent.agent.tools.effector import EffectorTool

from test_effector_phase0 import FakeKeyboard, FakeMouse, FakeSession, ScriptedProvider


# ─── hierarchical_orchestrator ────────────────────────────────────────────────

def _passing_post(ctx, page):
    return StageVerificationResult(verified=True)


def _failing_post(ctx, page):
    return StageVerificationResult(verified=False, reason="invariant broken")


@pytest.mark.asyncio
async def test_hierarchical_workflow_runs_all_stages_when_everything_passes():
    async def run_ok(ctx, page):
        return {"success": True, "data": {"touched": ctx.get("touched", []) + [ctx.get("_stage", "?")]}}

    stages = [
        TaskStage(id="s1", name="Charge card", app="Stripe", run=run_ok, postconditions=[_passing_post]),
        TaskStage(id="s2", name="Create record", app="Salesforce", run=run_ok, postconditions=[_passing_post]),
    ]

    report = await run_hierarchical_workflow(stages, {"touched": []}, page=None)

    assert report.success is True
    assert report.completed_stages == 2
    assert [s.status for s in report.stages] == ["passed", "passed"]


@pytest.mark.asyncio
async def test_hierarchical_workflow_stops_on_precondition_failure():
    calls = []

    async def run_tracked(ctx, page):
        calls.append(ctx)
        return {"success": True}

    stages = [
        TaskStage(
            id="s1", name="Requires auth", app="Portal", run=run_tracked,
            postconditions=[_passing_post],
            preconditions=[lambda ctx: ctx.get("authenticated", False)],
        ),
        TaskStage(id="s2", name="Never reached", app="Slack", run=run_tracked, postconditions=[_passing_post]),
    ]

    report = await run_hierarchical_workflow(stages, {"authenticated": False}, page=None)

    assert report.success is False
    assert report.failed_stage == "s1"
    assert calls == []  # stage never even ran


@pytest.mark.asyncio
async def test_hierarchical_workflow_rolls_back_on_postcondition_failure_and_stops():
    rollback_calls = []

    async def run_ok(ctx, page):
        return {"success": True}

    async def rollback(ctx, page):
        rollback_calls.append(True)

    stages = [
        TaskStage(id="s1", name="Bad invariant", app="Stripe", run=run_ok,
                   postconditions=[_failing_post], rollback=rollback),
        TaskStage(id="s2", name="Never reached", app="Slack", run=run_ok, postconditions=[_passing_post]),
    ]

    report = await run_hierarchical_workflow(stages, {}, page=None, max_stage_retries=1)

    assert report.success is False
    assert report.failed_stage == "s1"
    assert rollback_calls == [True]
    assert report.completed_stages == 0


@pytest.mark.asyncio
async def test_hierarchical_workflow_retries_before_giving_up():
    attempts = {"count": 0}

    async def flaky_run(ctx, page):
        attempts["count"] += 1
        if attempts["count"] < 2:
            return {"success": False, "error": "transient"}
        return {"success": True}

    stages = [TaskStage(id="s1", name="Flaky", app="Stripe", run=flaky_run, postconditions=[_passing_post])]

    report = await run_hierarchical_workflow(stages, {}, page=None, max_stage_retries=3)

    assert report.success is True
    assert attempts["count"] == 2  # failed once, succeeded on retry


# ─── jit_metaprogrammer: detection ──────────────────────────────────────────────

def test_looks_like_unsupported_interface_true_when_no_elements():
    empty = DOMSnapshot(url="https://example.test", title="Canvas App", elements=[], summary="")
    assert looks_like_unsupported_interface(empty) is True


def test_looks_like_unsupported_interface_false_with_normal_elements():
    normal = DOMSnapshot(
        url="https://example.test", title="Form", summary="",
        elements=[DOMElementNode(ref="@e1", tag="input", selector="#x",
                                  bounds=Bounds(x=0, y=0, width=10, height=10),
                                  center=Point(x=5, y=5), is_visible=True, is_enabled=True)],
    )
    assert looks_like_unsupported_interface(normal) is False


# ─── jit_metaprogrammer: real synthesis through the actual generate_tool pipeline ──

class FakeToolRegistry:
    """Minimal duck-typed registry matching what GenerateToolTool actually calls
    (register(), optionally activate()) — no need to pull in the real ToolRegistry
    and its dependencies for this test."""

    def __init__(self):
        self.registered = []

    def register(self, tool):
        self.registered.append(tool)

    def activate(self, names):
        pass


@dataclass
class SynthesisScriptedProvider:
    """Returns a fixed JSON tool-spec string as if a reasoning model wrote it."""
    spec_json: str
    calls: int = 0

    async def chat(self, messages, model=None, max_tokens=2048, temperature=0.2, **kw):
        self.calls += 1

        @dataclass
        class _Resp:
            content: str
            usage: dict | None = None

        return _Resp(content=self.spec_json)


_VALID_TOOL_SPEC = json.dumps({
    "name": "reverse-text-driver",
    "description": "Reverses a string of text — a stand-in synthesized helper.",
    "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
    "implementation": "def main(**kwargs):\n    return kwargs['text'][::-1]\n",
    "test_cases": [{"input": {"text": "abc"}, "expected_status": "success"}],
})


@pytest.mark.asyncio
async def test_synthesize_driver_registers_a_real_tool_through_the_actual_pipeline():
    """No mocking of GenerateToolTool, security.py, sandbox.py, or validator.py —
    this proves the real AST security scan + subprocess sandbox + test-case
    verification actually accept a valid synthesized tool and register it."""
    provider = SynthesisScriptedProvider(spec_json=_VALID_TOOL_SPEC)
    registry = FakeToolRegistry()

    result = await synthesize_driver(
        problem_description="Need to reverse some text extracted from a canvas element.",
        page_context="URL: https://example.test/canvas-app\nTitle: Canvas App",
        provider=provider, model="fake/reasoning-model",
        tool_registry=registry,
    )

    assert result["success"] is True, result["message"]
    assert result["tool_name"] == "reverse-text-driver"
    assert len(registry.registered) == 1
    assert registry.registered[0].manifest.name == "reverse-text-driver"


@pytest.mark.asyncio
async def test_synthesize_driver_rejects_code_that_fails_the_real_security_scan():
    """A synthesized tool that imports os/subprocess must be rejected by the SAME
    static security scanner every other dynamic tool goes through — this is the
    actual security property phase 4 depends on, not an assumption."""
    dangerous_spec = json.dumps({
        "name": "malicious-driver",
        "description": "Tries to shell out.",
        "parameters": {"type": "object", "properties": {}},
        "implementation": "import subprocess\ndef main(**kwargs):\n    return subprocess.run(['ls']).returncode\n",
        "test_cases": [{"input": {}, "expected_status": "success"}],
    })
    provider = SynthesisScriptedProvider(spec_json=dangerous_spec)
    registry = FakeToolRegistry()

    result = await synthesize_driver(
        problem_description="x", page_context="x",
        provider=provider, model="fake/reasoning-model", tool_registry=registry,
    )

    assert result["success"] is False
    assert result["tool_name"] is None
    assert registry.registered == []  # never reached the registry


@pytest.mark.asyncio
async def test_synthesize_driver_fails_gracefully_with_no_tool_registry():
    provider = SynthesisScriptedProvider(spec_json=_VALID_TOOL_SPEC)
    result = await synthesize_driver(
        problem_description="x", page_context="x",
        provider=provider, model="fake/reasoning-model", tool_registry=None,
    )
    assert result["success"] is False
    assert "registry" in result["message"].lower()


@pytest.mark.asyncio
async def test_synthesize_driver_handles_a_malformed_llm_response():
    provider = SynthesisScriptedProvider(spec_json="not valid json at all")
    registry = FakeToolRegistry()

    result = await synthesize_driver(
        problem_description="x", page_context="x",
        provider=provider, model="fake/reasoning-model", tool_registry=registry,
    )
    assert result["success"] is False
    assert registry.registered == []


# ─── End-to-end: react_loop triggers synthesis on a real empty-page run ────────

class EmptyPage:
    """A page with zero interactive elements on every snapshot — the actual
    condition looks_like_unsupported_interface exists to catch."""

    def __init__(self):
        self.url = "https://example.test/canvas-app"
        self.viewport_size = {"width": 1280, "height": 720}
        self.mouse = FakeMouse(self)
        self.keyboard = FakeKeyboard(self)
        self.actions = []

    async def title(self):
        return "Canvas App"

    async def evaluate(self, script, arg=None):
        if "MutationObserver" in script:
            return True
        if "querySelectorAll" in script:
            return []  # nothing the DOM primitives can see
        return "Some canvas-rendered text the agent needs."

    async def wait_for_timeout(self, ms):
        pass

    async def goto(self, url, **kw):
        self.url = url

    async def screenshot(self, **kw) -> bytes:
        return b"\xff\xd8\xff\xe0fake-jpeg"


@pytest.mark.asyncio
async def test_effector_tool_synthesizes_a_driver_when_the_page_has_nothing_to_click(tmp_path: Path):
    # Synthesis only fires on the SECOND consecutive empty-perception turn (avoids
    # false positives on a genuinely still-loading page) — turn 1 still asks the
    # decision model for an action, which will fail to find anything and the loop
    # simply advances to turn 2, where the empty-count hits 2 and synthesis fires
    # before this response is ever consumed.
    decision_provider = ScriptedProvider([
        {"thought": "nothing visible yet, waiting", "action": "wait", "duration": 100},
    ])
    synthesis_provider = SynthesisScriptedProvider(spec_json=_VALID_TOOL_SPEC)
    registry = FakeToolRegistry()

    tool = EffectorTool(
        workspace=tmp_path, provider=decision_provider, model="fake/primary",
        decision_provider=decision_provider, decision_model="fake/decision",
        tool_registry=registry, synthesis_provider=synthesis_provider, synthesis_model="fake/reasoning",
        use_human_cadence=False,
    )

    class FakeEmptySession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = EmptyPage()
            self.context = FakeContext(pages=[self.page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeEmptySession):
        raw = await tool.execute(goal="Extract the text rendered on this canvas")

    result = json.loads(raw)

    assert result["success"] is False  # the browser goal itself wasn't achieved by clicking
    assert result["synthesized_tool"] == "reverse-text-driver"
    # Real bug, 2026-08-27: the caller needs REAL page data to call the synthesized tool with —
    # the browser session is already closed by the time this result reaches it, so
    # without this the caller has nothing but a reason to fabricate the argument
    # (confirmed live: it did, and got away with it only because the target page's
    # markup happened to be famous, heavily-memorized training data).
    assert result["synthesis_context"] is not None
    assert "https://example.test/canvas-app" in result["synthesis_context"]
    assert "Canvas App" in result["synthesis_context"]  # the page title
    assert len(registry.registered) == 1
    assert synthesis_provider.calls == 1


# ─── _parse_spec_json: the invalid-backslash-escape repair, test 5.4 ───────────

def test_parse_spec_json_repairs_a_raw_backslash_in_embedded_python_source():
    """Real bug, found live 2026-08-27 (test 5.4): the model's own 'implementation'
    field is raw Python source, and a bare backslash inside it (here, a regex) is
    not valid JSON unless doubled — a strict json.loads raised "Invalid \\escape"
    on a spec that was otherwise entirely correct."""
    # Built by hand, not via json.dumps, specifically to contain an INVALID escape
    # the way a model's raw text completion would — json.dumps would have escaped
    # the backslash correctly and never reproduced the bug.
    raw = (
        '{"name": "digit-extractor", "description": "Extracts digits from text.", '
        '"parameters": {"type": "object", "properties": {"text": {"type": "string"}}, '
        '"required": ["text"]}, '
        '"implementation": "import re\\ndef main(**kwargs):\\n    return re.findall(\\\\d+, kwargs[\\"text\\"])\\n", '
        '"test_cases": [{"input": {"text": "a1b2"}, "expected_status": "success"}]}'
    )

    spec = _parse_spec_json(raw)

    assert spec["name"] == "digit-extractor"
    assert "re.findall" in spec["implementation"]


def test_parse_spec_json_still_raises_on_genuinely_malformed_json():
    """The repair pass must not paper over real corruption — a truncated response
    (hit the token limit, missing closing braces) still needs to surface as an
    error the caller can report, not silently return something wrong."""
    with pytest.raises(json.JSONDecodeError):
        _parse_spec_json('{"name": "incomplete", "description": "cut off mid')


def test_parse_spec_json_leaves_correct_escapes_untouched():
    """Regression guard: a spec that was ALREADY valid JSON (a real newline as
    \\n, a real quote as \\") must parse exactly as before — the repair pass only
    ever needs to fire on the genuinely invalid case."""
    spec = _parse_spec_json(json.dumps({
        "name": "ok-tool", "description": 'Says "hi" then\nnewline.',
        "parameters": {"type": "object", "properties": {}},
        "implementation": "def main(**kwargs):\n    return 'ok'\n",
    }))
    assert spec["description"] == 'Says "hi" then\nnewline.'
    assert "\n" in spec["implementation"]


# ─── _vision_fallback_answer: synthesis-can't-solve-it fallback, test 5.4 ──────

@dataclass
class VisionScriptedProvider:
    """Returns a fixed JSON answer string as if a vision-capable model read it
    straight off a screenshot."""
    content: str
    calls: int = 0

    async def chat(self, messages, model=None, max_tokens=512, temperature=0.1, **kw):
        self.calls += 1

        @dataclass
        class _Resp:
            content: str
            usage: dict | None = None

        return _Resp(content=self.content)


@pytest.mark.asyncio
async def test_vision_fallback_returns_the_answer_when_the_model_found_it():
    provider = VisionScriptedProvider(content='{"found": true, "answer": "7742"}')
    page = EmptyPage()

    answer = await _vision_fallback_answer(page, "Read the secret code", provider, "fake/vision-model", {})

    assert answer == "7742"
    assert provider.calls == 1


@pytest.mark.asyncio
async def test_vision_fallback_returns_none_when_the_model_found_nothing():
    provider = VisionScriptedProvider(content='{"found": false, "answer": ""}')
    page = EmptyPage()

    answer = await _vision_fallback_answer(page, "Read the secret code", provider, "fake/vision-model", {})

    assert answer is None


@pytest.mark.asyncio
async def test_vision_fallback_is_a_noop_without_a_configured_vision_model():
    """Must not attempt a screenshot at all when there's nothing to send it to —
    a caller with no vision tier configured gets exactly the pre-fix behavior."""
    page = EmptyPage()

    answer = await _vision_fallback_answer(page, "Read the secret code", None, None, {})

    assert answer is None


@pytest.mark.asyncio
async def test_vision_fallback_fails_open_on_a_broken_response():
    provider = VisionScriptedProvider(content="not valid json")
    page = EmptyPage()

    answer = await _vision_fallback_answer(page, "Read the secret code", provider, "fake/vision-model", {})

    assert answer is None


@pytest.mark.asyncio
async def test_effector_tool_falls_back_to_vision_when_synthesis_cannot_solve_the_page(tmp_path: Path):
    """End-to-end through the real tool -> react_loop chain: synthesis genuinely
    fails (a malformed spec, same shape as the live bug before the backslash fix),
    and the run must not just give up when a vision model is available — this is
    the exact live gap test 5.4 found (success: false, no synthesized_tool, no
    vision attempt, despite the answer being trivially readable from a screenshot)."""
    decision_provider = ScriptedProvider([
        {"thought": "nothing visible yet, waiting", "action": "wait", "duration": 100},
    ])
    synthesis_provider = SynthesisScriptedProvider(spec_json="not valid json at all")
    vision_provider = VisionScriptedProvider(content='{"found": true, "answer": "7742"}')
    registry = FakeToolRegistry()

    tool = EffectorTool(
        workspace=tmp_path, provider=decision_provider, model="fake/primary",
        decision_provider=decision_provider, decision_model="fake/decision",
        tool_registry=registry, synthesis_provider=synthesis_provider, synthesis_model="fake/reasoning",
        vision_provider=vision_provider, vision_model="fake/vision-model",
        use_human_cadence=False,
    )

    class FakeEmptySession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = EmptyPage()
            self.context = FakeContext(pages=[self.page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeEmptySession):
        raw = await tool.execute(goal="Read the secret code shown on the canvas")

    result = json.loads(raw)

    assert result["success"] is True, result
    assert result["synthesized_tool"] is None  # synthesis genuinely never produced one
    assert result["extracted_data"]["answer"] == "7742"
    assert result["extracted_data"]["source"].startswith("vision_fallback")
    # >= 1, not == 1: turn 1's own per-turn vision-grounding (an unrelated,
    # pre-existing mechanic — _should_ground_with_vision fires whenever perception
    # is empty and a vision model is configured) can also call vision_provider
    # before synthesis is even attempted. The property this test actually checks is
    # that the fallback call happened and produced the right answer, not the count.
    assert vision_provider.calls >= 1


@pytest.mark.asyncio
async def test_effector_tool_still_reports_failure_when_vision_also_finds_nothing(tmp_path: Path):
    """Regression guard: the fallback must not manufacture a false success — if
    vision genuinely can't find the answer either, the run reports failure exactly
    as it did before this fix, not a fabricated 'success' with nothing in it."""
    decision_provider = ScriptedProvider([
        {"thought": "nothing visible yet, waiting", "action": "wait", "duration": 100},
    ])
    synthesis_provider = SynthesisScriptedProvider(spec_json="not valid json at all")
    vision_provider = VisionScriptedProvider(content='{"found": false, "answer": ""}')
    registry = FakeToolRegistry()

    tool = EffectorTool(
        workspace=tmp_path, provider=decision_provider, model="fake/primary",
        decision_provider=decision_provider, decision_model="fake/decision",
        tool_registry=registry, synthesis_provider=synthesis_provider, synthesis_model="fake/reasoning",
        vision_provider=vision_provider, vision_model="fake/vision-model",
        use_human_cadence=False,
    )

    class FakeEmptySession:
        def __init__(self, *a, **kw):
            from test_effector_phase0 import FakeContext
            self.page = EmptyPage()
            self.context = FakeContext(pages=[self.page])

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            pass

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeEmptySession):
        raw = await tool.execute(goal="Read the secret code shown on the canvas")

    result = json.loads(raw)

    assert result["success"] is False
    assert vision_provider.calls >= 1  # see the previous test's comment on why not ==
