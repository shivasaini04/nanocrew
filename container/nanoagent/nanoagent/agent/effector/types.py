"""Effector's shared types — ported from computer-use/types.ts.

Field names are snake_case Python equivalents of the TS camelCase originals
(e.g. `urlContains` -> `url_contains`); nothing was dropped in the translation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Action = Literal[
    "click", "right_click", "double_click",
    "type", "key", "scroll", "hover",
    "navigate", "wait", "screenshot",
    "select", "clear", "upload", "extract",
    # God-level pillar 06, 2026-08-23: type + wait +
    # match + click + verify-closed as ONE atomic action for ARIA-combobox
    # widgets (React Select, MUI Autocomplete, and anything else following the
    # same pattern) — removes the "typed but never clicked the option" failure
    # mode found live against demoqa.com, instead of relying on the model to
    # remember the two-step convention across two separate turns.
    "select_combobox",
    # stage45 gap E, 2026-09-01: getting a file OFF a page. Three shapes in one
    # action, because from the model's side they are one intent ("save that file")
    # and it should not have to know which mechanism applies:
    #   target -> click it inside expect_download()
    #   url    -> fetch those bytes through the page's own session
    #   neither-> save whatever the page is currently displaying (the PDF viewer case)
    # See downloads.py for why the third one cannot be an event.
    "download",
    # stage45 gap D, 2026-09-01: the escape hatch. Every action above is a thing we
    # decided in advance the agent might need; this is the one that does not need
    # deciding in advance. `select_combobox` above exists because the vocabulary was
    # too small once — this is the alternative to adding a sixteenth special case the
    # next time. See browser_exec.py, including why it goes through the danger gate.
    "browser_exec",
    "done",  # react_loop-only: signals the goal is achieved, not a page action
]


@dataclass
class WaitForSpec:
    selector: str | None = None
    state: Literal["visible", "hidden", "attached", "detached"] = "visible"
    timeout: int = 10000


@dataclass
class VerifySpec:
    url_contains: str | None = None
    element_visible: str | None = None
    element_absent: str | None = None
    text_present: str | None = None


@dataclass
class Step:
    step: int
    action: Action
    target: str | None = None
    text: str | None = None
    key: str | None = None
    url: str | None = None
    value: str | None = None
    direction: Literal["up", "down", "left", "right"] | None = None
    amount: float | None = None
    duration: float | None = None
    file_path: str | None = None
    file_paths: list[str] | None = None
    extract_schema: dict[str, str] | None = None
    description: str | None = None
    wait_for: WaitForSpec | None = None
    verify: VerifySpec | None = None
    # stage45 gap D: the JavaScript for browser_exec, and which world to run it in
    # ("isolated" — the default, invisible to the page — or "main", which is the only
    # one that can see the page's own JS globals).
    script: str | None = None
    world: str | None = None
    # stage45 gap F: accept the JS dialog this action raises, instead of dismissing it.
    # Declared BEFORE the action because a dialog blocks the page until answered, so
    # there is no time to ask a human once one is open — see watchdogs.py. An armed
    # step is dangerous by definition (escalation.is_dangerous), so the human approves
    # "click Delete AND confirm it" as one decision.
    accept_dialog: bool = False
    is_external: bool = False
    is_dangerous: bool = False
    credential_ref: str | None = None

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "Step":
        """Build a Step from a raw dict (e.g. LLM-produced JSON action). `selector` is
        accepted as an alias for `target`, matching the TS executor's normalization."""
        target = d.get("target") or d.get("selector")
        wait_for = d.get("wait_for") or d.get("waitFor")
        verify = d.get("verify")
        return Step(
            step=int(d.get("step", 1)),
            action=d.get("action", "click"),
            target=target,
            text=d.get("text"),
            key=d.get("key"),
            url=d.get("url"),
            value=d.get("value"),
            direction=d.get("direction"),
            amount=d.get("amount"),
            duration=d.get("duration"),
            file_path=d.get("file_path") or d.get("filePath"),
            file_paths=d.get("file_paths") or d.get("filePaths"),
            extract_schema=d.get("extract_schema") or d.get("extractSchema"),
            description=d.get("description"),
            script=d.get("script"),
            world=d.get("world"),
            accept_dialog=bool(d.get("accept_dialog") or d.get("acceptDialog", False)),
            wait_for=WaitForSpec(**wait_for) if isinstance(wait_for, dict) else None,
            verify=VerifySpec(**{
                "url_contains": verify.get("url_contains") or verify.get("urlContains"),
                "element_visible": verify.get("element_visible") or verify.get("elementVisible"),
                "element_absent": verify.get("element_absent") or verify.get("elementAbsent"),
                "text_present": verify.get("text_present") or verify.get("textPresent"),
            }) if isinstance(verify, dict) else None,
            is_external=bool(d.get("is_external") or d.get("isExternal", False)),
            is_dangerous=bool(d.get("is_dangerous") or d.get("isDangerous", False)),
            credential_ref=d.get("credential_ref") or d.get("credentialRef"),
        )


@dataclass
class Bounds:
    x: float
    y: float
    width: float
    height: float


@dataclass
class Point:
    x: float
    y: float


@dataclass
class DOMElementNode:
    ref: str                  # e.g. "@e1"
    tag: str
    selector: str
    bounds: Bounds
    center: Point
    is_visible: bool
    is_enabled: bool
    role: str | None = None
    name: str | None = None
    value: str | None = None
    placeholder: str | None = None
    type: str | None = None
    # God-level pillar 08, 2026-08-23: a CSS selector
    # identifying this element's <iframe> in the TOP page, e.g. '#stripe-frame'
    # — None means the element is in the top-level document. Lets resolve_target
    # reconstruct page.frame_locator(frame_selector).locator(selector) instead
    # of the plain page.locator(selector) that could never see into an iframe
    # at all. Single-level only (an iframe within an iframe isn't resolved) —
    # a deliberate, documented scope line, not a silent gap.
    frame_selector: str | None = None
    # stage45 doc 04, phase 1 (2026-08-29): the page-absolute rect of the iframe
    # whose document this element lives in -- x/y are its CONTENT-box origin, so
    # `bounds`/`center` above have already had it added and are page-absolute like
    # every top-level element's. None means the element is in the top document
    # (frame_selector is None too) and no shift was needed.
    #
    # Kept rather than discarded after the shift because it is the only way back
    # to a frame-local coordinate, which anything talking to that frame's own
    # document (a future frame-scoped evaluate, a debug overlay) would need.
    frame_bounds: Bounds | None = None
    # stage45 doc 04, phase 2 (2026-08-29): this element lives in a frame we could
    # PLACE but not NAME (no id/name/src), so there is no frame_locator string that
    # reaches it and `selector` is only meaningful inside that frame's own document.
    #
    # This is a hard instruction to the resolver, not a hint. frame_selector=None
    # already means "top-level element", and the resolver reads that as "look it up
    # with page.locator(selector)" -- against the TOP document. Running an in-frame
    # selector there does not fail cleanly: on a checkout page `#card-number` may
    # well match a different field, and the click lands on it with no error. So when
    # this is set the selector layers are SKIPPED entirely, not tried-then-fallen-
    # back-from, and resolution goes straight to the page-absolute coordinate phase 1
    # put on `center`.
    coordinate_only: bool = False
    # stage45 doc 04, phase 3 (2026-08-29): a selector for the web component whose
    # shadow root this element lives in, e.g. '#address-widget' or 'stripe-card'.
    # None means the element is in ordinary light DOM. Informational — Playwright's
    # CSS engine pierces open shadow roots on its own, so nothing has to route
    # through the host the way an iframe has to be routed through frame_locator.
    shadow_host: str | None = None
    # stage45 doc 04, phase 4 (2026-08-29): something else would receive a click at
    # this element's centre — a cookie banner, an open modal, a sticky header. The
    # element is genuinely visible and correctly positioned; it just is not reachable
    # right now. dom_pruner drops these so the model is not offered them.
    is_occluded: bool = False


@dataclass
class DOMSnapshot:
    url: str
    title: str
    elements: list[DOMElementNode]
    summary: str                              # compact string for the LLM prompt
    viewport: dict[str, int] = field(default_factory=lambda: {"width": 1280, "height": 720})
    tree_text: str = ""                       # set by dom_pruner after pruning
    # What the page SAYS, as opposed to what can be clicked (stage 52, 2026-09-06).
    #
    # The element list is click targets only, so an agent on a content page — a feed, an
    # article, a search results page — saw controls and no text, and had to spend a second
    # turn on `extract` to read anything. Each entry is {tag, role?, text, bounds}.
    content: list[dict] = field(default_factory=list)


@dataclass
class VerificationResult:
    passed: bool
    reason: str | None = None


@dataclass
class StepResult:
    step: int
    status: Literal["success", "failed", "skipped"]
    error: str | None = None
    verification_passed: bool | None = None
    url_after: str | None = None
    data: Any = None
    # A durable descriptor (CSS selector + accessible name/role) of the element this
    # step actually resolved to — recorded by the executor so a run can later be
    # compiled into a replayable macro. Deliberately NOT inside `data`: that dict is
    # model-facing (react_loop renders it into the next turn's prompt for extract
    # steps), and this is internal bookkeeping the model has no use for.
    resolved_target: dict[str, Any] | None = None


@dataclass
class EffectorGoalArgs:
    goal: str
    url: str | None = None
    session_domain: str | None = None
    max_turns: int = 20
    max_external_actions: int = 10
    auto_dismiss_popups: bool = True


@dataclass
class EffectorTurnLog:
    turn: int
    thought: str
    action: Step
    result: StepResult
    snapshot_summary: str | None = None
    self_healed: bool = False


@dataclass
class EffectorExecutionResult:
    success: bool
    goal: str
    turns_executed: int
    turns: list[EffectorTurnLog]
    final_url: str
    extracted_data: dict[str, Any] | None = None
    error: str | None = None
    # Phase 4 (synthesis): set when react_loop hit an interface the standard DOM
    # primitives can't see (e.g. Canvas/WebGL, closed shadow roots) and synthesized
    # a custom driver via the existing generate_tool pipeline instead of stalling.
    # The outer agent loop can call this tool by name on its next turn.
    synthesized_tool: str | None = None
    # Real bug, found live 2026-08-27: synthesized_tool told the outer agent WHAT to call
    # next but never gave it any real data to call it WITH — the browser session
    # that captured the page's actual text/HTML is already closed by the time this
    # result reaches the caller. Live trace: the outer agent (Mechanic) then
    # fabricated a plausible-looking `html` argument for the synthesized tool from
    # its own training data (the target was a famous, heavily-memorized Selenium
    # tutorial fixture — the-internet.herokuapp.com/windows/new — so the
    # confabulated markup happened to be byte-correct; on any page NOT already in
    # the model's training data this would produce a confidently wrong answer with
    # no signal anything was fabricated). This is the same page_context string
    # already computed and used to AUTHOR the tool (see synthesize_driver) —
    # surfaced here so the caller has real data instead of a reason to invent some.
    synthesis_context: str | None = None
    # Gap-closing pass, 2026-08-23: aggregated token usage across every provider.chat()
    # call in the run (decision + vision + synthesis) — same field shape loop.py's own
    # aggregated_usage uses, so it can flow through the same "JS-side cost calculator"
    # reporting path without translation. Effector deliberately doesn't compute a dollar
    # figure itself — that pricing table lives orchestrator-side, not duplicated here.
    usage: dict = field(default_factory=lambda: {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
    })
    # God-level pillar 05, 2026-08-23 (structured goal verification): the
    # checklist the goal was decomposed into, when verify_goal=True — None when
    # verification wasn't enabled for this run. Lets the caller see exactly
    # what was checked, not just trust the success flag.
    goal_checklist: list[str] | None = None
    # Set when a previously distilled macro replayed this goal end to end with no
    # decision calls at all (workflow_id), and when a successful run was compiled into
    # a new one. Both are reported rather than inferred: "turns_executed: 0" alone
    # can't distinguish a fast path from a run that never started.
    macro_used: str | None = None
    macro_distilled: str | None = None
    # R2, 2026-08-31: turns whose page content matched a prompt injection signature,
    # as [{"turn": int, "url": str}]. Empty on a clean run. Reported rather than only
    # logged: a run can succeed at its goal and still have been steered at, and the
    # caller should be able to see that without reading container logs.
    injection_flags: list[dict[str, Any]] = field(default_factory=list)
    # R5, 2026-08-31: True when the run's own integrity token turned up in a step the
    # model produced — page content captured control-plane text and was steering it
    # back out. The run is aborted before that step executes.
    canary_triggered: bool = False
    # stage45 gap E, 2026-09-01: every file this run pulled off a page, as
    # DownloadRecord dicts (see downloads.py) — including the ones that failed, with
    # the reason. Reported rather than left on disk to be discovered: a run whose whole
    # point was "save the statement" needs to say where the statement went, and a
    # download the cap refused has to be visible as a refusal rather than as an absence.
    # `path` in each record is workspace-relative, which is what read_file takes.
    downloads: list[dict[str, Any]] = field(default_factory=list)
    # stage45 gap F, 2026-09-01: the browser died and this run is CHECKPOINTED AND
    # RESUMABLE rather than failed. Reported as its own field because "success: false
    # with an error string" is how every other failure looks too, and a caller deciding
    # whether to resume needs to tell a crash apart from a goal the agent could not
    # reach — resuming the latter just burns the same turns again.
    browser_crashed: bool = False


_USAGE_FIELDS = (
    "prompt_tokens", "completion_tokens", "total_tokens",
    "cache_creation_input_tokens", "cache_read_input_tokens",
    "prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
)


def new_usage_totals() -> dict:
    return {f: 0 for f in _USAGE_FIELDS}


def accumulate_usage(totals: dict, response_usage: dict | None) -> None:
    """Add one provider.chat() response's usage into a running totals dict —
    shared by react_loop's decision calls and resolver's vision-fallback calls,
    so every LLM call an Effector run makes (not just the per-turn decision) is
    reflected in EffectorExecutionResult.usage."""
    if not response_usage:
        return
    for field_name in _USAGE_FIELDS:
        totals[field_name] += response_usage.get(field_name, 0) or 0
