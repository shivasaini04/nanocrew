"""Fast-Path Macro Runner for distilled Effector workflows.

Executes compiled macros with zero LLM tokens, asserting each element is really there
before acting on it and signalling the caller to fall back to the ReAct loop the moment
an assertion doesn't hold. A macro is a bet that the page hasn't changed since it was
distilled; the assertions are what make losing that bet cheap instead of destructive.

Element identity is checked through the same two layers resolve_target's cheap path
uses — CSS selector, then role/accessible name — and never through anything that costs
a model call. Falling back to vision here would defeat the entire point of the fast path
(a run that pays for vision on every step is slower AND more expensive than just letting
the ReAct loop do it), so a target that neither layer can find is a clean miss.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval
from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.synthesis.macro_distiller import MacroAction, MacroWorkflow
from nanoagent.agent.effector.types import EffectorTurnLog, Step

# Roles resolver.py's a11y layer actually parses out of a "role: name" target
# (its _ROLE_RE). dom_snapshot falls back to the tag name when an element has no
# explicit role, so plenty of recorded roles ("input", "div") are NOT in this set —
# for those the bare accessible name is the right thing to hand the resolver, which
# tries it as a label, a placeholder, and then as visible text.
_RESOLVABLE_ROLES = frozenset({
    "button", "link", "textbox", "checkbox", "radio",
    "combobox", "menuitem", "tab", "heading",
})

# Actions that act on the page as a whole, not on a specific element.
_TARGETLESS_ACTIONS = frozenset({"navigate", "key"})


@dataclass
class MacroExecutionResult:
    status: str  # "success" | "assertion_failed" | "error"
    steps_completed: int
    total_steps: int
    message: str = ""
    failed_step_index: int | None = None
    # Whatever the macro's `extract` steps pulled off the page. A macro distilled from
    # a data-gathering run is useless if replaying it returns nothing but "success" —
    # the data IS the output of that task.
    extracted_data: dict[str, Any] = field(default_factory=dict)
    # Real bug, 2026-08-27 (test 4.2 of the manual capability suite): a macro that
    # replayed a successful select_combobox and then got asked "did this actually
    # work?" via post-replay goal verification (_try_macro_fast_path in react_loop.py)
    # was judged against a BARE page snapshot with no action history at all — and a
    # filled react-select input disappears from that snapshot the same way it
    # disappears mid-ReAct-loop (test 3.1's bug). With nothing in the snapshot and no
    # history to explain why, the verifier correctly-by-its-own-lights reported the
    # selection "unmet", the fast path rolled back and fell through to a fresh ReAct
    # loop — which then inherited a page that was ALREADY filled (the macro's DOM
    # mutation is real; rollback only restores cookies/localStorage/URL, see
    # speculative_rollback.py) with zero context explaining the fields' absence, and
    # burned its whole turn budget scrolling for a state/city dropdown that could
    # never reappear. One real macro success turned into one confirmed-live failure.
    # Carrying each step's real Step+StepResult here lets the caller build the exact
    # same turn history _recent_actions_text already knows how to annotate correctly
    # for select_combobox and extract — reusing that fix instead of inventing a
    # second, weaker signal for the same underlying fact.
    turns: list[EffectorTurnLog] = field(default_factory=list)


async def _count(locator) -> int:
    try:
        return await locator.count()
    except Exception:
        return 0


async def _find_live_target(page: Any, action: MacroAction) -> str | None:
    """The target string that currently resolves to this action's element, or None if
    neither its selector nor its accessible name finds anything on the page right now.

    Returning the string (rather than a Locator) lets the normal executor path do the
    acting, so a macro step goes through exactly the same click/type/self-heal code a
    ReAct step does instead of a parallel implementation that could drift from it.

    Every way of finding the element must match EXACTLY ONE. Stage 61 phase 0 found a
    checkboxes macro whose two steps were both stored as `input:has-text("on")` — both
    checkboxes match it, so a replay would click the first one twice and still pass
    every assertion. An ambiguous target is not a target: miss, and let the ReAct loop
    decide."""
    if action.target:
        try:
            if await _count(page.locator(action.target)) == 1:
                return action.target
        except Exception:
            pass  # not a valid selector on this page — fall through to the a11y name

    name = (action.target_name or "").strip()
    if not name:
        return None

    role = (action.target_role or "").strip().lower()
    if role in _RESOLVABLE_ROLES:
        try:
            if await _count(page.get_by_role(role, name=name)) == 1:
                return f"{role}: {name}"
        except Exception:
            pass

    for finder in ("get_by_label", "get_by_placeholder", "get_by_text"):
        try:
            if await _count(getattr(page, finder)(name, exact=False)) == 1:
                return name
        except Exception:
            continue

    return None


async def _check_page_assertions(page: Any, action: MacroAction) -> str | None:
    """Check this action's whole-page assertions against where the browser actually
    ended up. Returns a description of the first mismatch, or None if the page still
    looks like the one the macro was recorded against.

    `element_visible` assertions are deliberately not re-checked here — they name the
    same element `_find_live_target` already had to locate before the step could run,
    so re-testing them would only add a second chance to disagree with itself."""
    for assertion in action.assertions:
        if assertion.assertion_type == "url_contains":
            current = getattr(page, "url", "") or ""
            if assertion.expected and assertion.expected not in current:
                return (
                    f"page drifted — expected the URL to still contain "
                    f"{assertion.expected!r}, landed on {current!r}"
                )
        elif assertion.assertion_type == "title_contains":
            try:
                title = await page.title()
            except Exception:
                continue  # can't read it, don't fail the macro over that
            if assertion.expected and assertion.expected.lower() not in (title or "").lower():
                return (
                    f"page drifted — expected the title to contain "
                    f"{assertion.expected!r}, got {title!r}"
                )
    return None


_END_STATE_WAIT_S = 5.0


async def _wait_for_url_fragment(page: Any, fragment: str, timeout_s: float | None = None) -> str | None:
    """None once the page URL contains `fragment`; otherwise the URL it was still on
    when the wait ran out."""
    import asyncio

    if timeout_s is None:
        timeout_s = _END_STATE_WAIT_S
    deadline = asyncio.get_running_loop().time() + timeout_s
    while True:
        current = getattr(page, "url", "") or ""
        if fragment in current:
            return None
        if asyncio.get_running_loop().time() >= deadline:
            return current
        await asyncio.sleep(0.2)


async def execute_macro(
    macro: MacroWorkflow,
    page: Any,
    parameters: dict[str, Any] | None = None,
    options: ExecutorOptions | None = None,
) -> MacroExecutionResult:
    """Execute a distilled MacroWorkflow sequentially with strict runtime assertions."""
    params = parameters or {}
    exec_options = options or ExecutorOptions(use_human_cadence=True, require_approval=False)
    extracted: dict[str, Any] = {}
    turns_so_far: list[EffectorTurnLog] = []

    logger.info(
        f"effector-macro: starting fast-path execution for workflow {macro.workflow_id} "
        f"({len(macro.actions)} steps)"
    )

    def _miss(idx: int, action: MacroAction, message: str) -> MacroExecutionResult:
        logger.warning(f"effector-macro: step {action.step_index} — {message}")
        return MacroExecutionResult(
            status="assertion_failed",
            steps_completed=idx,
            total_steps=len(macro.actions),
            failed_step_index=action.step_index,
            message=message,
            extracted_data=extracted,
            turns=turns_so_far,
        )

    for idx, action in enumerate(macro.actions):
        value_to_use = action.literal_value
        if action.param_key:
            if action.param_key not in params:
                # Refuse rather than type nothing (stage 49). A parameterised step whose
                # value is missing used to fall through to `literal_value` — None once
                # distillation stopped freezing recorded values — and typed an empty
                # string into a real form while still reporting success. Missing an input
                # is a reason to go and think, so this becomes a miss and the caller
                # falls back to the ReAct loop, which can reason and ask.
                return _miss(
                    idx, action,
                    f"parameter {action.param_key!r} was not supplied for "
                    f"{action.target_name or action.target!r}",
                )
            value_to_use = str(params[action.param_key])

        live_target = action.target
        needs_element = action.action not in _TARGETLESS_ACTIONS and bool(
            action.target or action.target_name
        )

        if needs_element:
            live_target = await _find_live_target(page, action)
            if live_target is None:
                return _miss(
                    idx, action,
                    f"element not found — neither selector {action.target!r} nor "
                    f"accessible name {action.target_name!r} matches anything on the page",
                )

        step = Step(
            step=action.step_index,
            action=action.action,
            target=live_target,
            text=value_to_use,
            value=value_to_use,
            url=action.url,
            key=action.key,
            extract_schema=action.extract_schema,
            credential_ref=action.credential_ref,
        )

        if is_dangerous(step) and exec_options.require_approval:
            # A macro is replayed input, not vetted input: distilling a run that clicked
            # "Confirm payment" would otherwise reproduce that click on every later run
            # with no human in the loop. execute_step has no gate of its own (only the
            # batch execute_steps does), so replaying through it would silently drop the
            # approval react_loop applies to the equivalent live step.
            decision = await request_approval(step, exec_options.agent_id, exec_options.run_id, page)
            # Fail closed — see escalation.is_approved.
            if not is_approved(decision):
                return _miss(idx, action, f"escalation gate blocked this macro step ({decision})")

        try:
            res = await execute_step(step, page, exec_options)
        except Exception as err:
            logger.error(f"effector-macro: unhandled exception at step {action.step_index} — {err}")
            return MacroExecutionResult(
                status="error",
                steps_completed=idx,
                total_steps=len(macro.actions),
                failed_step_index=action.step_index,
                message=str(err),
                extracted_data=extracted,
            )

        if res.status != "success":
            return _miss(
                idx, action,
                res.error or f"step returned status {res.status}",
            )

        # Real step + real result, same shapes _recent_actions_text already knows how
        # to read for select_combobox/extract — see MacroExecutionResult.turns for why
        # this exists at all.
        turns_so_far.append(EffectorTurnLog(
            turn=idx + 1, thought="macro replay", action=step, result=res,
        ))

        drift = await _check_page_assertions(page, action)
        if drift is not None:
            # The step "worked" but the page is no longer the one this macro was
            # distilled against — an expired session bouncing to a login screen is the
            # ordinary case, and it's exactly when blindly continuing to click does
            # damage. Caught here, the caller rolls back and re-plans instead.
            return _miss(idx + 1, action, drift)

        if action.action == "extract" and isinstance(res.data, dict):
            extracted.update(res.data)

    if macro.end_url:
        # Every step ran; now the page must be where the recorded run finished. A click
        # that submits a form returns before the navigation it causes, so allow a moment
        # for the URL to arrive rather than reading it the instant the click lands.
        ended_on = await _wait_for_url_fragment(page, macro.end_url)
        if ended_on is not None:
            last = macro.actions[-1]
            return _miss(
                len(macro.actions), last,
                f"replay ended on {ended_on!r}, but the run it was recorded from ended on "
                f"{macro.end_url!r} — the steps ran without reaching the same result",
            )

    logger.info(f"effector-macro: fast-path execution succeeded for {macro.workflow_id}")
    return MacroExecutionResult(
        status="success",
        steps_completed=len(macro.actions),
        total_steps=len(macro.actions),
        message="All macro steps executed successfully",
        extracted_data=extracted,
        turns=turns_so_far,
    )
