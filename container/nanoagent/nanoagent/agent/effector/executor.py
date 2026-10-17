"""Ported from computer-use/executor.ts. Executes Steps against a Playwright page —
all 14 actions from the original, the external-action budget gate, the danger
escalation gate, human-cadence movement/typing (phase 2), self-healing (phase 1),
and credential-ref resolution (phase 5 cleanup — see credential_inject.py)."""

from __future__ import annotations

import weakref
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable

from loguru import logger

from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval
from nanoagent.agent.effector.resolver import Coordinate, resolve_target
from nanoagent.agent.effector.types import DOMSnapshot, Step, StepResult
from nanoagent.agent.effector.verify import run_verification
from nanoagent.agent.effector.waitfor import apply_wait_for, wait_for_navigation

_NAV_FOLLOWUP_ACTIONS = {"click", "double_click", "navigate", "key", "upload"}


@dataclass
class ExecutorOptions:
    max_external_actions: int = 5
    agent_id: str = "unknown"
    run_id: str = "unknown"
    require_approval: bool = True
    provider: Any = None            # for resolver's vision fallback
    vision_model: str | None = None
    on_step_start: Callable[[Step], None] | None = None
    on_step_end: Callable[[Step, StepResult], None] | None = None
    # Resilience (phase 1): the snapshot the current turn was planned against — used
    # as the anchor source if a @ref target fails to resolve (self_healing_selectors).
    # None disables self-healing (e.g. phase-0 callers that don't pass one).
    self_heal_snapshot: DOMSnapshot | None = None
    # Resilience (phase 1): when set, a mutating action already recorded in the
    # checkpoint's idempotency ledger (a resumed run re-planning the same step) is
    # skipped rather than re-executed. None disables idempotency checking.
    checkpoint: Any = None  # resilience.checkpoint.RunCheckpoint — Any avoids a cycle
    # Real bug, 2026-08-27: scopes the idempotency check to actions that existed
    # in the ledger BEFORE this live process's own turns began — see
    # is_action_already_executed's docstring. None falls back to checking the
    # checkpoint's whole (continuously-growing) ledger, matching the old
    # behavior; react_loop.py always passes this explicitly for a real run.
    checkpoint_prior_keys: frozenset[str] | None = None
    # Stealth (phase 2): organic mouse movement (Bezier trajectory) and per-character
    # typing cadence instead of instant Playwright input. Default True — an agent tool
    # tier'd DangerFullAccess browsing arbitrary real sites should not announce itself
    # as automated by default; set False for speed in a trusted/offline context (tests).
    use_human_cadence: bool = True
    # How long a click waits for its element to become actionable. A macro replay passes
    # a short one: it is a bet that the page has not changed, and when it has, waiting
    # the full 10 s before handing over to the ReAct loop made a failed replay slower
    # than no macro at all (stage 61 phase 0: a login repeat took 62 s vs 40 s).
    click_timeout_ms: int = 10000
    # Gap-closing pass, 2026-08-23: the caller's running token totals (react_loop's
    # usage_totals dict, passed by reference) — resolver's vision fallback (layer 5)
    # accumulates into this directly, so a run's EffectorExecutionResult.usage reflects
    # every LLM call the run made, not just the per-turn decision calls. None (e.g.
    # phase-0 callers, direct executor.py tests) just skips accumulation.
    usage_totals: dict | None = None
    # Side channel: set by _resolve_with_healing when a self-heal actually fired, read
    # by execute_step to annotate the StepResult. Reset at the start of each step.
    _last_self_heal_confidence: float | None = field(default=None, repr=False)
    # Side channel: set by _resolve_with_healing to a DURABLE descriptor of whatever
    # the step's target actually resolved to (CSS selector + accessible name/role),
    # read by execute_step to annotate the StepResult. Reset at the start of each step.
    # A @ref is an ordinal into ONE snapshot — it identifies nothing in a later run —
    # so a run's history is only replayable if the durable identity gets recorded at
    # the moment resolution succeeds. See synthesis/macro_distiller.py.
    _last_resolved_target: dict[str, Any] | None = field(default=None, repr=False)
    # stage45 gap E: the run's DownloadManager (downloads.DownloadManager), owned by
    # EffectorSession. Any, not the real type, for the same reason `checkpoint` is —
    # importing downloads.py here is harmless today but the pattern in this file is
    # that executor imports nothing that might one day import it back.
    #
    # None disables downloads entirely: the `download` action fails with a clear
    # reason rather than a NoneType error, and a file a click pulls down is left in
    # Playwright's temp dir exactly as it was before this existed. Tests and phase-0
    # callers pass nothing and see no behaviour change.
    download_manager: Any = None
    # stage45 gap D. On by default: the effector tool is already DangerFullAccess and
    # already drives a real browser, clicks arbitrary things and injects credentials —
    # running JS in a page it is already driving is a marginal increase, not a
    # categorical one, and the page's own origin could do all of it anyway. Exposed so
    # a caller can turn it off (and so the remote lane, which cannot carry a script at
    # all, is not the only thing standing between a model and a confusing error).
    allow_browser_exec: bool = True
    # The session's CDP session, used for the isolated world. None is fine —
    # evaluate_isolated falls back to the page's own evaluate.
    cdp_session: Any = None
    # stage45 gap F: the session's DialogWatchdog. None means dialogs are handled by
    # whatever listener the session registered and nothing is armed or reported — the
    # pre-gap-F behaviour, which is what the phase-0 callers and the tests want.
    dialog_watchdog: Any = None


async def execute_steps(steps: list[Step], page, options: ExecutorOptions | None = None) -> list[StepResult]:
    """Execute a list of steps in order. Stops early on a failed or denied step."""
    opts = options or ExecutorOptions()
    external_count = 0
    results: list[StepResult] = []

    for step in steps:
        if opts.on_step_start:
            opts.on_step_start(step)

        is_external = (
            step.is_external
            or step.action == "navigate"
            or (step.action == "click" and step.target and _looks_external(step.target))
        )

        if is_external and external_count >= opts.max_external_actions:
            result = StepResult(
                step=step.step, status="skipped",
                error=f"External action budget exhausted (max {opts.max_external_actions})",
            )
            results.append(result)
            if opts.on_step_end:
                opts.on_step_end(step, result)
            continue

        if is_dangerous(step) and opts.require_approval:
            decision = await request_approval(step, opts.agent_id, opts.run_id, page)
            # Fail closed — see escalation.is_approved. `== "denied"` would let a
            # timeout or an unreachable gate execute the very step it was guarding.
            if not is_approved(decision):
                result = StepResult(
                    step=step.step, status="skipped",
                    error=f"Blocked by the escalation gate ({decision})",
                )
                results.append(result)
                if opts.on_step_end:
                    opts.on_step_end(step, result)
                break

        result = await execute_step(step, page, opts)
        if is_external and result.status == "success":
            external_count += 1

        results.append(result)
        if opts.on_step_end:
            opts.on_step_end(step, result)

        if result.status == "failed":
            break

    return results


def _looks_external(target: str) -> bool:
    from nanoagent.agent.effector.escalation import _DANGEROUS_ACTION_PATTERN
    return bool(_DANGEROUS_ACTION_PATTERN.search(target))


async def execute_step(step: Step, page, options: ExecutorOptions | None = None) -> StepResult:
    """Execute a single step. Never raises — failures come back as a StepResult."""
    opts = options or ExecutorOptions()
    opts._last_self_heal_confidence = None
    opts._last_resolved_target = None
    url_before = page.url

    if opts.checkpoint is not None:
        from nanoagent.agent.effector.resilience.checkpoint import is_action_already_executed
        # self_heal_snapshot doubles as "this turn's DOM snapshot" here — it's set
        # by react_loop right before this call — so a @ref target resolves to a
        # stable identity for the idempotency check, not its raw, recyclable label.
        if is_action_already_executed(
            opts.checkpoint, step, url_before, opts.self_heal_snapshot, opts.checkpoint_prior_keys,
        ):
            return StepResult(step=step.step, status="skipped",
                               error="Already executed in a prior attempt of this run (idempotency ledger)")

    watchdog = opts.dialog_watchdog
    try:
        if step.wait_for:
            await apply_wait_for(page, step.wait_for)

        # Armed before the action, not after: the dialog fires DURING the Playwright
        # call, and the handler needs the answer already decided. By the time an armed
        # step gets here a human has approved it — is_dangerous() treats arming as
        # dangerous — or the run is unattended and it was denied and never reached this.
        if watchdog is not None and step.accept_dialog:
            watchdog.arm()

        action_data = await _dispatch_action(step, page, opts)

        if step.action in _NAV_FOLLOWUP_ACTIONS:
            try:
                await wait_for_navigation(page, timeout=3000)
            except Exception:
                pass

        url_after = page.url

        # A click can start a download nothing planned for — an "Export" button, a
        # link with a `download` attribute. Playwright buffers those to a temp file
        # and deletes them when the context closes, so without this the file is gone
        # and the step still says "success". Draining here (rather than in the event
        # handler) means a save failure is reported in THIS step's result, and means
        # the model is told on its very next turn that a file arrived.
        captured = await _drain_downloads(opts)
        if captured:
            action_data = {**(action_data or {}), "downloads": captured}

        dialogs = _dialogs_during_step(opts)
        if dialogs:
            action_data = {**(action_data or {}), "dialogs": dialogs}

        verification_passed = None
        if step.verify:
            v_result = await run_verification(step.verify, page)
            verification_passed = v_result.passed
            if not v_result.passed:
                return StepResult(
                    step=step.step, status="failed",
                    error=f"Verification failed: {v_result.reason}",
                    verification_passed=False, url_after=url_after,
                )

        if opts._last_self_heal_confidence is not None:
            action_data = {**(action_data or {}), "self_healed": True,
                            "self_heal_confidence": opts._last_self_heal_confidence}

        if opts.checkpoint is not None:
            from nanoagent.agent.effector.resilience.checkpoint import record_executed_action
            record_executed_action(opts.checkpoint, step, url_after, opts.self_heal_snapshot)

        return StepResult(
            step=step.step, status="success",
            verification_passed=verification_passed,
            url_after=url_after if url_after != url_before else None,
            data=action_data,
            # Carried so react_loop's action log persists it and a later run can replay
            # this step against the element's own identity rather than the @ref that
            # only meant something inside this turn's snapshot.
            resolved_target=opts._last_resolved_target,
        )
    except Exception as err:
        # Dialogs are reported on the FAILURE path too, and this is the case that
        # matters most: a click raises a confirm(), the confirm is dismissed, and the
        # click then fails or times out because the action it was confirming never
        # happened. Reporting dialogs only on success would hide exactly the sequence
        # gap F exists to make visible.
        failed_dialogs = _dialogs_during_step(opts)
        return StepResult(
            step=step.step, status="failed", error=str(err),
            url_after=_safe_page_url(page),
            data={"dialogs": failed_dialogs} if failed_dialogs else None,
        )
    finally:
        # Always, on every path. An arming that survived a failed step would accept the
        # NEXT step's dialog — one nobody reviewed — which is exactly the unreviewed
        # accept the dismiss-by-default rule exists to prevent.
        if watchdog is not None:
            watchdog.disarm()


def _safe_page_url(page: Any) -> str | None:
    """`page.url` raises once the browser is gone, and raising inside an error handler
    replaces a clean failed-StepResult with an exception out of execute_step."""
    try:
        return page.url
    except Exception:
        return None


def _dialogs_during_step(options: ExecutorOptions) -> list[dict[str, Any]]:
    """What dialogs appeared while this step ran.

    The point of gap F's dialog half: a dismissed confirm() cancels the action that
    raised it, so without this the loop sees a page that simply did not change and the
    model retries the same click forever.
    """
    watchdog = options.dialog_watchdog
    if watchdog is None:
        return []
    try:
        return [d.to_dict() for d in watchdog.drain()]
    except Exception as err:  # pragma: no cover - defensive
        logger.debug(f"effector: could not read the dialog record — {err}")
        return []


async def _drain_downloads(options: ExecutorOptions) -> list[dict[str, Any]]:
    """Save anything the browser downloaded on its own since the last step.

    Never raises: a passive capture failing is worth reporting, but it must not turn a
    step that otherwise succeeded into a failure. The record carries its own error and
    that reaches the model through the step's data.
    """
    manager = options.download_manager
    if manager is None:
        return []
    try:
        return [r.to_dict() for r in await manager.drain()]
    except Exception as err:
        logger.warning(f"effector: could not save a captured download — {err}")
        return []


def _durable_descriptor(element) -> dict[str, Any]:
    """A DOM element's own identity, in the forms resolve_target can look it up by in
    a later run: its CSS selector (layer 3) and its role/accessible name (layer 4).
    Both are recorded rather than just the selector — a generated class name changes
    between deploys while the visible label usually doesn't, and vice versa, so having
    the pair is what makes replay survive a redesign that moves only one of them."""
    return {
        "selector": element.selector,
        "name": element.name,
        "role": element.role,
        "frame_selector": element.frame_selector,
    }


async def _resolve_with_healing(page, target: str, options: ExecutorOptions):
    """resolve_target, with one self-healing retry: if `target` is a @ref that no
    longer resolves and the caller passed the snapshot it was planned against
    (self_heal_snapshot), recapture a fresh snapshot and try anchor-based recovery
    before giving up. See resilience/self_healing_selectors.py.

    Also records a durable descriptor of whatever the target resolved to
    (options._last_resolved_target) — see that field's note on ExecutorOptions."""
    from nanoagent.agent.effector.dom_snapshot import find_element_by_ref, is_ref_tag

    # Looked up BEFORE resolution, from the snapshot the turn was actually planned
    # against — the same mapping resolve_target's own @ref layer uses, so the two
    # can't disagree about which element the ref meant.
    planned_element = (
        find_element_by_ref(target, options.self_heal_snapshot)
        if (options.self_heal_snapshot is not None and is_ref_tag(target))
        else None
    )

    try:
        resolved = await resolve_target(page, target, options.provider, options.vision_model, usage_totals=options.usage_totals)
        if planned_element is not None:
            options._last_resolved_target = _durable_descriptor(planned_element)
        elif not is_ref_tag(target):
            # Already durable: a CSS selector, "role: name", or visible text all mean
            # the same thing next run. A @ref with no snapshot to resolve it against
            # deliberately records nothing rather than a string that can't be replayed.
            options._last_resolved_target = {"selector": target}
        return resolved
    except Exception as original_err:
        from nanoagent.agent.effector.dom_snapshot import capture_dom_snapshot
        from nanoagent.agent.effector.resilience.self_healing_selectors import (
            create_anchor_descriptor,
            resolve_self_healing_selector,
        )

        if not options.self_heal_snapshot or not is_ref_tag(target):
            raise

        old_element = find_element_by_ref(target, options.self_heal_snapshot)
        if old_element is None:
            raise original_err

        logger.debug(f'effector: target "{target}" failed to resolve, attempting self-heal')
        try:
            fresh = await capture_dom_snapshot(page)
        except Exception:
            raise original_err

        anchor = create_anchor_descriptor(old_element)
        healed = resolve_self_healing_selector(anchor, fresh.elements)
        if healed is None:
            raise original_err

        element, confidence = healed
        options._last_self_heal_confidence = confidence
        # The HEALED element is the one the step actually acted on — recording the
        # stale planned element here would teach a macro to replay the very selector
        # that just failed to resolve.
        options._last_resolved_target = _durable_descriptor(element)
        # stage45 doc 04, phase 2: same guard as resolver.py's @ref layer, and for
        # the same reason — a self-heal can land on an element from an unnamed frame
        # just as easily as the planner can, and looking its selector up against the
        # top page could click something unrelated. See DOMElementNode.coordinate_only.
        if not element.coordinate_only:
            # God-level pillar 08: same frame-routing resolve_target's own @ref
            # layer does — a healed element can be inside an iframe just as easily
            # as any other.
            scope = page.frame_locator(element.frame_selector) if element.frame_selector else page
            try:
                loc = scope.locator(element.selector)
                if await loc.count() > 0:
                    return loc.first
            except Exception:
                pass
        # stage45 doc 04, phase 1 (2026-08-29): the in-frame raise that used to sit
        # here is gone for the same reason as resolver.py's — the snapshot hands us
        # page-absolute coordinates now, so a healed in-frame element can fall back
        # to a click like any other. This path matters more than the resolver's: a
        # self-heal only runs when the selector ALREADY failed once, so refusing the
        # coordinate meant the whole recovery attempt was wasted.
        return Coordinate(x=element.center.x, y=element.center.y)


# Last known cursor position per page — mirrors the TS original's WeakMap<Page, Point>,
# used to give human_mouse_move a real starting point instead of teleporting.
_cursor_positions: "weakref.WeakKeyDictionary[Any, Coordinate]" = weakref.WeakKeyDictionary()


async def _move_and_click(page, options: ExecutorOptions, target: Coordinate, *, button: str = "left", clicks: int = 1) -> None:
    """Coordinate-based click with organic movement when use_human_cadence is on —
    mirrors the TS original's cursorPositions tracking + humanMouseMove-then-click."""
    if options.use_human_cadence:
        from nanoagent.agent.effector.stealth.stealth import human_mouse_move
        from nanoagent.agent.effector.types import Point
        current = _cursor_positions.get(page) or Coordinate(x=400, y=300)
        await human_mouse_move(page, Point(x=current.x, y=current.y), Point(x=target.x, y=target.y))
    _cursor_positions[page] = target
    if clicks == 2:
        await page.mouse.dblclick(target.x, target.y)
    else:
        await page.mouse.click(target.x, target.y, button=button)


async def _click_locator(
    page, options: ExecutorOptions, locator, *, button: str = "left", clicks: int = 1, timeout: int | None = None,
) -> None:
    """Click a resolved Locator, routing through the organic-movement path when
    human cadence is on.

    Review finding, 2026-08-30: `_move_and_click` only ever ran for targets that
    resolved to a raw Coordinate. When the DOM snapshot produced a selector — the
    common case by far — every click was `locator.click()`, which teleports the
    cursor and fires instantly. The Bezier trajectory work was real but mostly
    executed on the fallback path, so "human cadence" was on in name only.

    Scrolls the element into view first, since mouse coordinates are viewport-
    relative and `locator.click()`'s own auto-scroll is exactly what we're bypassing.
    Falls back to the plain locator click whenever a bounding box isn't available
    (detached, zero-size, or cross-origin-framed element).
    """
    if options.use_human_cadence:
        try:
            await locator.scroll_into_view_if_needed(timeout=timeout or 5000)
            box = await locator.bounding_box()
        except Exception:
            box = None
        if box and box.get("width") and box.get("height"):
            target = Coordinate(
                x=round(box["x"] + box["width"] / 2),
                y=round(box["y"] + box["height"] / 2),
            )
            await _move_and_click(page, options, target, button=button, clicks=clicks)
            return

    kwargs: dict = {}
    if timeout is not None:
        kwargs["timeout"] = timeout
    if clicks == 2:
        await locator.dblclick(**kwargs)
    else:
        await locator.click(button=button, **kwargs)


async def _move_only(page, options: ExecutorOptions, target: Coordinate) -> None:
    if options.use_human_cadence:
        from nanoagent.agent.effector.stealth.stealth import human_mouse_move
        from nanoagent.agent.effector.types import Point
        current = _cursor_positions.get(page) or Coordinate(x=400, y=300)
        await human_mouse_move(page, Point(x=current.x, y=current.y), Point(x=target.x, y=target.y))
    else:
        await page.mouse.move(target.x, target.y)
    _cursor_positions[page] = target


async def _type_text(page, options: ExecutorOptions, text: str) -> None:
    if options.use_human_cadence:
        from nanoagent.agent.effector.stealth.stealth import human_type
        await human_type(page, text)
    else:
        await page.keyboard.type(text, delay=20)


_LISTBOX_OPEN_JS = """
() => {
  const listboxes = document.querySelectorAll('[role="listbox"]');
  for (const lb of listboxes) {
    const rect = lb.getBoundingClientRect();
    const style = window.getComputedStyle(lb);
    if (rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none') {
      return true;
    }
  }
  return false;
}
"""


async def _listbox_is_open(page) -> bool:
    """A visible role="listbox" is the WAI-ARIA-standard signal that a combobox's
    option list is currently open — generic across react-select, MUI Autocomplete,
    Chakra Select, Ant Design, and any other widget following the ARIA combobox
    pattern, not a heuristic tuned to one site's markup."""
    try:
        return bool(await page.evaluate(_LISTBOX_OPEN_JS))
    except Exception:
        return False


async def _dispatch_action(step: Step, page, options: ExecutorOptions) -> Any:
    resolve = lambda target: _resolve_with_healing(page, target, options)  # noqa: E731

    if step.action == "navigate":
        if not step.url:
            raise ValueError("navigate action requires url")
        await page.goto(step.url, wait_until="domcontentloaded", timeout=30000)
        return {"url": page.url}

    if step.action == "wait":
        ms = step.duration or 1000
        await page.wait_for_timeout(ms)
        return {"waited_ms": ms}

    if step.action == "screenshot":
        # Reports the truth instead of "captured": True, which is what this used to
        # return while doing nothing at all. The action is deliberately absent from the
        # loop's vocabulary, but models invent actions, and one that invents this got
        # told it had a screenshot it never took — then reasoned about a picture that
        # did not exist. Nothing here captures anything; say so.
        #
        # The live view already ships frames continuously (stage 50), so the honest
        # answer also names the thing that does work.
        raise ValueError(
            "screenshot is not an available action. The page is already streamed to "
            "the live view; use 'extract' to read content, or 'done' when finished."
        )

    if step.action == "key":
        if not step.key:
            raise ValueError("key action requires key")
        await page.keyboard.press(step.key)
        return {"key": step.key}

    if step.action == "scroll":
        direction = step.direction or "down"
        amount = step.amount or 300
        delta_x = -amount if direction == "left" else amount if direction == "right" else 0
        delta_y = -amount if direction == "up" else amount if direction == "down" else 0
        # Review finding, 2026-08-30: stealth.human_scroll existed, was tested, and
        # had no production caller — every scroll was a single instantaneous
        # mouse.wheel jump with no acceleration, no drift and no reading dwell,
        # which is the one input event a passive behavioural detector sees on
        # almost every page.
        async def _do_scroll() -> None:
            if options.use_human_cadence and delta_y and not delta_x:
                from nanoagent.agent.effector.stealth.stealth import human_scroll
                await human_scroll(page, delta_y)
            else:
                await page.mouse.wheel(delta_x, delta_y)

        if step.target:
            resolved = await resolve(step.target)
            if not isinstance(resolved, Coordinate):
                await resolved.hover()
            await _do_scroll()
        else:
            await _do_scroll()
        return {"delta_x": delta_x, "delta_y": delta_y}

    if step.action == "type":
        if not step.target:
            raise ValueError("type action requires target")
        if step.text is None:
            from nanoagent.agent.effector.credential_inject import has_credential_ref, resolve_credential_ref
            if not has_credential_ref(step.credential_ref):
                raise ValueError("type action requires text or credential_ref")
            cred_value = await resolve_credential_ref(step.credential_ref)
            if cred_value is None:
                # Addressed to the MODEL, which is what reads this, and which cannot
                # store a credential itself. The old wording ("store it first via the
                # credentials vault") named an action only a human can take, leaving the
                # loop with a failure and no next move. Naming the next move is what
                # turns a missing secret into a question for a person instead of a
                # retry loop or a guess.
                raise ValueError(
                    f'Credential not found: "{step.credential_ref}". Do not guess one — '
                    f'use the "takeover" action to ask the person to sign in.'
                )
            step = replace(step, text=cred_value)
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_and_click(page, options, resolved)
            await _type_text(page, options, step.text)
        else:
            await _click_locator(page, options, resolved)
            if options.use_human_cadence:
                await _type_text(page, options, step.text)
            else:
                await resolved.fill(step.text)
        # Gap-closing pass, 2026-08-23: found live against demoqa.com — typing
        # into a combobox (react-select, MUI Autocomplete, and everything else
        # following the ARIA combobox pattern) only filters its option list; it
        # never confirms a selection by itself. A bare {"typed": True} told the
        # model nothing was wrong, so it moved on believing the field was fully
        # handled with a filtered-but-unconfirmed dropdown left open. Checking
        # for a visible role="listbox" is a generic, DOM-observable signal — not
        # specific to react-select — so this generalizes past the one site it
        # was found on. See react_loop.py's _build_turn_prompt for where this
        # actually reaches the model.
        return {"typed": True, "dropdown_open": await _listbox_is_open(page)}

    if step.action == "select_combobox":
        # God-level pillar 06, 2026-08-23: type + wait +
        # match + click + verify-closed as ONE action, so there's no intermediate
        # "typed but not yet confirmed" state for the model to stop at — the
        # exact gap pillar 05's dropdown_open signal only detects AFTER the fact.
        if not step.target:
            raise ValueError("select_combobox action requires target")
        if not step.text:
            raise ValueError("select_combobox action requires text (the option to select)")

        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_and_click(page, options, resolved)
            await _type_text(page, options, step.text)
        else:
            await _click_locator(page, options, resolved)
            if options.use_human_cadence:
                await _type_text(page, options, step.text)
            else:
                await resolved.fill(step.text)

        await page.wait_for_timeout(400)  # let the filtered option list actually render

        if not await _listbox_is_open(page):
            raise RuntimeError(
                f'select_combobox: typed "{step.text}" but no option list (role="listbox") '
                "appeared — this target may not be a searchable combobox widget"
            )

        option_locator = page.locator('[role="listbox"] [role="option"]')
        option_count = await option_locator.count()
        option_texts = [(await option_locator.nth(i).inner_text()).strip() for i in range(option_count)]

        query = step.text.strip().lower()
        matched_index = next((i for i, t in enumerate(option_texts) if t.lower() == query), None)
        if matched_index is None:
            candidates = [i for i, t in enumerate(option_texts) if query in t.lower()]
            if len(candidates) == 1:
                matched_index = candidates[0]
            elif len(candidates) > 1:
                raise RuntimeError(
                    f'select_combobox: "{step.text}" matched multiple options ambiguously: '
                    f"{[option_texts[i] for i in candidates]}"
                )
            else:
                raise RuntimeError(
                    f'select_combobox: no option matching "{step.text}" — visible options were: {option_texts}'
                )

        await _click_locator(page, options, option_locator.nth(matched_index))
        await page.wait_for_timeout(200)
        # Same key `type`'s dropdown_open uses — reuses _recent_actions_text's
        # existing "a dropdown is still open" prompt annotation for free if a
        # widget genuinely doesn't close after its option is clicked, rather
        # than needing a second, parallel signal for the same underlying fact.
        return {"selected": option_texts[matched_index], "dropdown_open": await _listbox_is_open(page)}

    if step.action == "clear":
        if not step.target:
            raise ValueError("clear action requires target")
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_and_click(page, options, resolved)
            await page.keyboard.press("Control+a")
            await page.keyboard.press("Delete")
        else:
            await resolved.fill("")
        return {"cleared": True}

    if step.action == "select":
        if not step.target:
            raise ValueError("select action requires target")
        if not step.value:
            raise ValueError("select action requires value")
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            raise ValueError("select action cannot use coordinates")
        await resolved.select_option(step.value)
        return {"selected": step.value}

    if step.action == "hover":
        if not step.target:
            raise ValueError("hover action requires target")
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_only(page, options, resolved)
        else:
            await resolved.hover()
        return {"hovered": True}

    if step.action == "right_click":
        if not step.target:
            raise ValueError("right_click action requires target")
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_and_click(page, options, resolved, button="right")
        else:
            await _click_locator(page, options, resolved, button="right")
        return {"right_clicked": True}

    if step.action == "double_click":
        if not step.target:
            raise ValueError("double_click action requires target")
        resolved = await resolve(step.target)
        if isinstance(resolved, Coordinate):
            await _move_and_click(page, options, resolved, clicks=2)
        else:
            await _click_locator(page, options, resolved, clicks=2)
        return {"double_clicked": True}

    if step.action == "upload":
        files = step.file_paths or ([step.file_path] if step.file_path else [])
        if not files:
            raise ValueError("upload action requires file_path or file_paths")

        if step.target:
            resolved = await resolve(step.target)
            if isinstance(resolved, Coordinate):
                async with page.expect_file_chooser(timeout=10000) as fc_info:
                    await _move_and_click(page, options, resolved)
                file_chooser = await fc_info.value
                await file_chooser.set_files(files)
            else:
                try:
                    await resolved.set_input_files(files)
                except Exception:
                    async with page.expect_file_chooser(timeout=10000) as fc_info:
                        await resolved.click()
                    file_chooser = await fc_info.value
                    await file_chooser.set_files(files)
        else:
            file_input = page.locator('input[type="file"]').first
            if await file_input.count() > 0:
                await file_input.set_input_files(files)
            else:
                raise ValueError("upload action: no target provided and no input[type=file] found on page")
        return {"uploaded": files}

    if step.action == "browser_exec":
        from nanoagent.agent.effector.browser_exec import BrowserExecError, run_script

        if not options.allow_browser_exec:
            raise ValueError(
                "browser_exec is disabled for this run — the escape hatch is off, so "
                "use the standard actions or escalate"
            )
        try:
            return await run_script(
                page,
                step.script or step.text or "",
                world=(step.world or "isolated"),
                # `duration` is the loop's existing seconds field; reusing it keeps the
                # action from growing a second timeout concept. run_script clamps it and
                # substitutes its own default for None.
                timeout_s=step.duration,
                cdp_session=options.cdp_session,
            )
        except BrowserExecError as err:
            # A failed script is one bad turn with a readable reason, not a dead run —
            # the model's next move is usually a corrected script, and it can only make
            # one if it is told what went wrong.
            raise ValueError(str(err)) from err

    if step.action == "download":
        manager = options.download_manager
        if manager is None:
            raise ValueError(
                "download is not available in this run — no download manager is attached "
                "(the remote lane cannot download; see remote_page.py)"
            )

        # Shape 1: a URL was named. Fetch it through the page's own session. This is
        # also the answer for a PDF the browser is displaying, because the viewer means
        # no download event will ever fire — see downloads.py.
        if step.url:
            record = await manager.fetch_url(page, step.url)
            if not record.ok:
                raise ValueError(record.error or "the download failed")
            return {"downloaded": record.to_dict()}

        # Shape 2: an element was named. Click it and wait for the download the click
        # starts. expect_download() is used rather than clicking and hoping the passive
        # listener catches it: this way the wait is bounded and a button that turned out
        # NOT to download anything is a clear timeout instead of a silent success.
        if step.target:
            resolved = await resolve(step.target)
            timeout = int(step.duration * 1000) if step.duration else 30000
            try:
                async with page.expect_download(timeout=timeout) as info:
                    if isinstance(resolved, Coordinate):
                        await _move_and_click(page, options, resolved)
                    else:
                        await _click_locator(page, options, resolved)
                download = await info.value
            except Exception as err:
                raise ValueError(
                    f"clicking that target started no download within {timeout}ms — "
                    f"if the file opens in the browser instead of saving (a PDF, say), "
                    f"use download with the file's url rather than a target ({err})"
                ) from err

            # Claim before saving: the context listener saw this same object and would
            # otherwise save it a second time on the next drain, inventing a phantom
            # "report-1.pdf" that no site ever served.
            manager.claim(download)
            record = await manager.save(download)
            if not record.ok:
                raise ValueError(record.error or "the download failed")
            return {"downloaded": record.to_dict()}

        # Shape 3: neither. Save whatever the page is currently showing — the PDF
        # viewer case, where the model can see a document on screen and there is no
        # button to click because the browser already "opened" it.
        current = page.url
        if not current or current.startswith("about:"):
            raise ValueError(
                "download needs a target (an element to click) or a url (the file to "
                "fetch) — this page has nothing to save"
            )
        record = await manager.fetch_url(page, current)
        if not record.ok:
            raise ValueError(record.error or "the download failed")
        return {"downloaded": record.to_dict()}

    if step.action == "extract":
        schema = step.extract_schema or {}
        extracted: dict[str, str] = {}

        # The remote lane reads text through a named probe rather than a Locator, and it
        # is the only branch here that reaches into frames. Found live 2026-08-31: without
        # this, extract on that lane always returned {} — the schema path raised into a
        # bare except and the target path did nothing for a coordinate, so the model asked
        # for the same text turn after turn.
        remote_extract = getattr(page, "nc_extract_selectors", None)
        if remote_extract is not None:
            from nanoagent.agent.effector.dom_snapshot import is_ref_tag

            target = str(step.target or "")
            if schema:
                texts = await remote_extract(list(schema.values()))
                for key, selector in schema.items():
                    if texts.get(selector):
                        extracted[key] = texts[selector]
                if extracted:
                    return extracted
                # Nothing matched. Read the page instead of returning {}.
                #
                # The target path below already does this, and its comment records why —
                # an empty answer sends the model round the loop asking for the same text,
                # four identical turns measured. The schema path never got that fix, and
                # it is the one a model reaches for first: asked for "the first post" it
                # invents field->selector guesses, and on a site that renames its classes
                # every guess misses.
                #
                # Seen live 2026-09-06 on a LinkedIn feed: the session was valid, the page
                # was loaded, extractText held 5,220 characters INCLUDING the post — and
                # the agent concluded the tool could not read dynamic content, because
                # every schema selector it guessed matched nothing and it got {} back.
                logger.debug(
                    f"effector: extract schema matched nothing ({list(schema.values())}) "
                    f"— falling back to the page text"
                )
            point = None
            if target and is_ref_tag(target):
                # A @ref resolves through the snapshot, and on this lane that always ends
                # in a coordinate — so read the text of whatever is at that point.
                resolved = await resolve(step.target)
                if isinstance(resolved, Coordinate):
                    point = {"x": resolved.x, "y": resolved.y}
            elif target:
                texts = await remote_extract([target])
                if texts.get(target):
                    extracted["text"] = texts[target]
                    return extracted
                # A selector that matched nothing reads the page instead of returning {}.
                # The model asked to read something, and an empty answer is what sends it
                # round the loop asking again — four identical turns, measured.
                # Deliberately NOT falling through to resolve(): its later layers are
                # get_by_label/get_by_text, which this lane refuses, so a miss there is a
                # failed step rather than a fallback.
            extracted["text"] = await page.nc_text(point)
            return extracted

        if schema:
            for key, selector in schema.items():
                try:
                    loc = page.locator(selector).first
                    if await loc.count() > 0:
                        extracted[key] = (await loc.inner_text()).strip()
                except Exception:
                    pass  # non-fatal — best effort per field
        elif step.target:
            resolved = await resolve(step.target)
            if not isinstance(resolved, Coordinate):
                extracted["text"] = (await resolved.inner_text()).strip()
        return extracted

    # click (default)
    if not step.target:
        raise ValueError("click action requires target")
    try:
        resolved = await resolve(step.target)
    except Exception as resolve_err:
        # Gap-closing pass, 2026-08-23: layer 7, the genuine last resort — an
        # OS-level click via the virtual display (see desktop/desktop_vision.py),
        # for the case every DOM-based layer (ref/CSS/a11y/text/browser-vision/OCR)
        # already failed, e.g. a Canvas/WebGL widget with no accessible DOM surface
        # at all. Only attempted when a vision-capable provider is configured — same
        # precondition resolver.py's own vision layer already requires. Scoped to
        # plain `click` only: os_visual_click has no typing/select equivalent yet,
        # so other actions still raise honestly rather than half-working.
        if options.provider is not None and options.vision_model:
            from nanoagent.agent.effector.desktop.desktop_vision import os_visual_click
            description = step.description or step.target
            logger.info(f'effector: all DOM-based resolution failed for "{step.target}" — attempting OS-level desktop click')
            clicked = await os_visual_click(description, options.provider, options.vision_model, usage_totals=options.usage_totals)
            if clicked:
                return {"clicked": True, "desktop_fallback": True}
        raise resolve_err
    if isinstance(resolved, Coordinate):
        await _move_and_click(page, options, resolved)
    else:
        await _click_locator(page, options, resolved, timeout=options.click_timeout_ms)
    return {"clicked": True}
