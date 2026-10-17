"""The `effector` tool — autonomous goal-directed browser operation.

Phase 0 of the stage43 Effector port. Drives agent/effector/react_loop.py end to end: perceive (DOM
snapshot) -> decide (LLM) -> act (executor) -> verify -> repeat, until the goal is
reported done, a step fails, or max_turns is hit.

`effector_workflow` (blueprint-driven flows) is a separate tool — see
tools/effector_workflow.py. Human takeover is a `takeover` action inside the ReAct
loop (stage 49 phase 5.4), not a tool — an outer-loop tool runs after the session has
closed, so there would be no browser left to hand over. Phase 4 (synthesis) is wired in: when the loop hits an interface the
standard DOM primitives can't see, it can synthesize a driver via the existing
generate_tool pipeline — see effector/synthesis/jit_metaprogrammer.py.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.effector.capability_manifest import CapabilityManifest
from nanoagent.agent.effector.watchdogs import DialogWatchdog
from nanoagent.agent.tools.base import Tool


def _domain_of(url: str) -> str | None:
    """The host a URL belongs to, as a vault key — or None if there isn't one.

    Deliberately NOT react_loop's `_domain_of`, which answers "default" for anything it
    cannot parse. That is right for rate-limiting buckets and wrong here: a vault named
    "default" would collect the cookies of every site whose URL failed to parse into one
    shared file. No key is better than the wrong key.

    `www.` is stripped so www.example.com and example.com are one session rather than
    two half-logged-in ones.
    """
    from urllib.parse import urlparse

    try:
        host = (urlparse(url).hostname or "").strip().lower()
    except Exception:  # noqa: BLE001
        return None
    if not host:
        return None
    return host[4:] if host.startswith("www.") else host


# The most external actions an 'identity' step may take. Not agent-adjustable — see the
# call site for why a ceiling exists alongside the agent's own judgement.
_MAX_IDENTITY_ACTIONS = 3


class EffectorTool(Tool):
    """Operate a real web browser autonomously toward a goal — clicking, typing,
    navigating, and extracting data — with a fresh perception snapshot each turn so
    it can react to whatever the page actually shows rather than following a fixed
    script."""

    def __init__(
        self,
        workspace: Path,
        provider: Any,
        model: str,
        decision_provider: Any = None,
        decision_model: str | None = None,
        vision_provider: Any = None,
        vision_model: str | None = None,
        use_human_cadence: bool = True,
        stealth: bool = True,
        network_shield: bool = True,
        require_approval: bool = True,
        tool_registry: Any = None,
        tool_persistence: Any = None,
        job_id: str | None = None,
        health_monitor: Any = None,
        synthesis_provider: Any = None,
        synthesis_model: str | None = None,
        firewall_protection: bool = True,
        merkle_audit: bool = True,
        autonomous_challenges: bool = True,
    ):
        self._workspace = Path(workspace)
        self._provider = provider
        self._model = model
        # Per-step decisions default to a cheap/fast tier (model_router's "tool_heavy")
        # since a single task can run dozens of turns — see loop.py's registration site
        # for how this is resolved. Falls back to the primary provider/model when no
        # separate key is configured for that tier.
        self._decision_provider = decision_provider or provider
        self._decision_model = decision_model or model
        self._vision_provider = vision_provider
        self._vision_model = vision_model
        # Phase 4 (synthesis) — the outer agent loop's own tool registry/persistence/
        # health monitor, so a mid-task-synthesized driver goes through the exact same
        # validated pipeline every other dynamic tool does. None disables synthesis
        # (react_loop just stops instead, matching its pre-phase-4 behavior).
        self._tool_registry = tool_registry
        self._tool_persistence = tool_persistence
        self._job_id = job_id
        self._health_monitor = health_monitor
        self._synthesis_provider = synthesis_provider
        self._synthesis_model = synthesis_model
        # Stealth (phase 2) — default on for real runs, matching the TS original;
        # exposed here (not hardcoded) so tests can turn cadence off for determinism
        # without that meaning the feature defaults off in production.
        self._use_human_cadence = use_human_cadence
        self._stealth = stealth
        self._network_shield = network_shield
        # Phase 16: Dispatcher-level protections
        self._firewall_protection = firewall_protection
        self._merkle_audit = merkle_audit
        self._autonomous_challenges = autonomous_challenges
        # The human-approval gate on irreversible actions. Exposed for the same reason
        # use_human_cadence is — tests that exercise loop mechanics shouldn't have to
        # route every submit-shaped click through an approval round trip — and NOT so
        # production can turn it off: the default is on, and loop.py never passes this.
        self._require_approval = require_approval

    @property
    def name(self) -> str:
        return "effector"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def description(self) -> str:
        return (
            "Operate a real web browser autonomously toward a goal. Unlike `browser` "
            "(single fixed actions), this drives a full perceive-decide-act-verify loop: "
            "each turn it takes a fresh snapshot of the page's interactive elements, "
            "decides the next action, executes it, and verifies the result — so it can "
            "adapt to whatever the page actually shows (popups, redirects, changed "
            "layouts) rather than following a script that breaks the moment the page "
            "differs from what was expected. Use for open-ended tasks like 'apply to "
            "this job posting' or 'find the pricing page and extract the plan names and "
            "prices' — not for a single click or read, where `browser` is cheaper.\n"
            "If the page turns out to have no standard interactive elements (a pure "
            "Canvas/WebGL app, a closed shadow-root widget), the result may include "
            "`synthesized_tool`: a new tool was generated and registered to handle it — "
            "call that tool by name next, don't retry `effector` on the same page. The "
            "browser session is already closed by then, so also use `synthesis_context` "
            "(the real page text/HTML this call captured) for whatever argument the new "
            "tool needs — never invent page content from memory; if synthesis_context "
            "doesn't contain what the tool needs, say so rather than guessing."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "The high-level goal to achieve in the browser. Be specific about "
                                   "what counts as done, including any data to extract.",
                },
                "url": {
                    "type": "string",
                    "description": "Starting URL. Omit to continue from the current page of an "
                                   "existing session_domain, if any.",
                },
                "session_domain": {
                    "type": "string",
                    "description": "Domain key for session cookie reuse (e.g. 'linkedin.com') — "
                                   "logs in once, reuses the session on later calls.",
                },
                "max_turns": {
                    "type": "integer",
                    "description": "Maximum autonomous turns before halting. Default 20.",
                },
                "max_external_actions": {
                    "type": "integer",
                    "description": "Maximum external/irreversible actions (navigate, submit-shaped "
                                   "clicks) allowed before halting. Default 10.",
                },
                "identity": {
                    "type": "string",
                    "enum": ["anonymous", "me"],
                    "description": (
                        "WHOSE browser this step runs in, and the most consequential choice "
                        "you make here. "
                        "'anonymous' (default) — a clean, stealthed browser that is nobody. "
                        "Use it for everything that only READS: searching, sweeping listings, "
                        "opening public pages, price checks, research. Safe at volume. "
                        "'me' — the user's OWN browser, signed in as them, from their home "
                        "network. Use it ONLY when the task requires being them: sending a "
                        "message, posting, applying, or reading something private to their "
                        "account. "
                        "Choosing 'me' for bulk reading is how an account gets flagged — a "
                        "few hundred profile views from one real person in an hour is not "
                        "something a person does. Choosing 'anonymous' for a DM simply fails, "
                        "because there is no account to send from. "
                        "A job hunt is the shape of both: sweep the public postings anonymous, "
                        "then message the handful of people worth messaging as 'me'."
                    ),
                },
                "verify_goal": {
                    "type": "boolean",
                    "description": "Decompose the goal into a checklist up front and verify every "
                                   "item against the real page before accepting \"done\" — catches "
                                   "the goal being called complete when it wasn't (e.g. a dropdown "
                                   "typed into but never confirmed). Costs 1-2 extra LLM calls. "
                                   "Default false; turn on for goals where a wrong 'done' would be "
                                   "costly to have missed.",
                },
            },
            "required": ["goal"],
        }

    async def execute(
        self,
        goal: str,
        url: str | None = None,
        session_domain: str | None = None,
        max_turns: int = 20,
        max_external_actions: int = 10,
        verify_goal: bool = False,
        identity: str = "anonymous",
        **kwargs: Any,
    ) -> str:
        import os
        import uuid

        from nanoagent.agent.effector.browser_session import EffectorSession
        from nanoagent.agent.effector.capabilities.tab_manager import TabManager
        from nanoagent.agent.effector.cycle_channel import current_channel
        from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval
        from nanoagent.agent.effector.live_screen import LiveScreen
        from nanoagent.agent.effector.takeover import TakeoverSession, router as takeover_router
        from nanoagent.agent.effector.react_loop import run_react_loop
        from nanoagent.agent.effector.types import Step

        agent_id = os.environ.get("AGENT_ID", "unknown")
        run_id = str(uuid.uuid4())
        # Stage 61 phase 0: the phase-0 baseline found ~44% of task time outside the
        # step loop, so the run's own phases are timed too (see decision_log.py).
        import time as _time
        _tm: dict[str, float] = {"start": _time.monotonic()}
        # Bound here, not only inside the session block: the run record is written after
        # it, and a run that never got a browser still writes timings.
        engine_info: dict[str, Any] = {}
        # Stays None when merkle_audit is off or the run produced no turns, so the
        # result's "audit" key distinguishes "not audited" from "audited and clean".
        audit_result: dict[str, Any] | None = None
        # Stage 61 phase 6 — see effector/proof.py.
        proof: dict[str, Any] | None = None
        # Which browser engine actually ran. A run that fell back to Chromium because
        # the native engine binary isn't in this image must say so in its result, not
        # only in a container log nobody reads.
        engine_info: dict[str, Any] | None = None
        # stage45 gap F: captured inside the session below, read in the result JSON
        # after it. Declared here for the same reason engine_info is — the return
        # statement lives outside the `async with`, and reaching across a closed block
        # for a live attribute is how a later refactor turns into a NameError.
        dialog_records: list[dict[str, Any]] = []

        # Derive the session key from the starting URL when the caller did not name one.
        #
        # Session persistence is the whole point of the encrypted vault, and it engaged
        # only when the MODEL remembered to pass `session_domain` — an optional argument
        # it cannot know it needs, because it has not hit the login yet. Measured live
        # 2026-09-04: a human took over, signed into Google, handed back, and nothing was
        # saved, because the call was `effector(goal=..., url=...)` with no
        # session_domain. The next run would have asked them to sign in all over again.
        #
        # An explicit argument still wins — a caller that names a domain means it.
        if not session_domain and url:
            session_domain = _domain_of(url)
            if session_domain:
                logger.debug(f"effector: session key derived from the URL — {session_domain}")

        # WHOSE browser, decided per CALL rather than per cycle.
        #
        # A job hunt is the reason this exists: sweeping a few hundred public postings and
        # then messaging three people are opposite kinds of work on the SAME site. The
        # first must not come from the user's account — a few hundred profile views in an
        # hour is not something a person does, and the account gets flagged. The second
        # can only come from their account, because there is nowhere else to send from.
        #
        # So the lane follows the work, and one cycle can use both.
        # Stage 60 phase 1: when the operator picked a browser for this message, that
        # choice wins over the model's — see browser_lane.py.
        from nanoagent.agent.tools.browser_lane import not_connected_message, resolve_identity

        wants_identity = resolve_identity(identity) == "me"

        # Asking RemoteConfig rather than reading one env var: the lane needs a controller
        # AND a cycle token AND a host, and a check that tested only the first would report
        # "connected" for a run that then quietly fell back to the container.
        from nanoagent.agent.effector.remote_page import RemoteConfig

        if wants_identity and RemoteConfig.from_env() is None:
            # Fail loudly rather than quietly doing it as nobody. A DM the user believes
            # they sent, sent from an anonymous browser, is not a smaller version of the
            # task — it is a different one that silently did not happen.
            return json.dumps({
                "success": False,
                "goal": goal,
                "error": not_connected_message(),
            })

        if wants_identity:
            # A hard ceiling the model cannot raise.
            #
            # Three is enough to message the handful of people a task is really about, and
            # far too few to get an account restricted. It is a backstop, not the control:
            # the agent should never WANT to send two hundred messages. But an agent
            # having a bad day should cost a wasted cycle, never someone's account — and
            # this one spent an afternoon confidently insisting a working tool was broken.
            #
            # Stage 60 phase 3: once the person approved a list (request_batch_approval),
            # the list is the budget. Doubled because a send can take more than one
            # outward-looking click ("Add a note", then "Send"); what actually limits
            # sends is the grant, used once per send at the danger gate.
            from nanoagent.agent.effector import batch_approval

            approved_left = batch_approval.total_remaining()
            if approved_left:
                max_external_actions = approved_left * 2
            else:
                max_external_actions = min(max_external_actions, _MAX_IDENTITY_ACTIONS)

        # Stage 61 phase 4: a compiled read answers a repeat of a verified public read
        # with one HTTP GET — no browser, so none of the ~10 s it takes to start one.
        # Never on the user's own browser, and any miss falls through to the normal run.
        if not wants_identity and not kwargs.get("macro_parameters"):
            from nanoagent.agent.effector.synthesis.compiled_read import replay_read

            import asyncio as _asyncio
            hit = await _asyncio.get_running_loop().run_in_executor(
                None, replay_read, self._workspace, session_domain, goal,
            )
            if hit is not None:
                if self._firewall_protection:
                    # Page text, like any extracted data, is untrusted — same scrub the
                    # browser path applies before handing it to the model.
                    from nanoagent.agent.effector.security.prompt_firewall import PromptFirewall
                    hit["extracted_data"] = PromptFirewall.sanitize_data(hit["extracted_data"])
                _tm["end"] = _time.monotonic()
                from nanoagent.agent.effector.decision_log import append_record, record_run_timings
                run_timings = record_run_timings(self._workspace, run_id, _tm)
                append_record(self._workspace, run_id, {"type": "route", "route": "compiled_read", "url": hit["url"]})
                from nanoagent.agent.effector.proof import build_proof
                proof = build_proof(
                    success=True, extracted=hit["extracted_data"], page_text=None, downloads=[],
                    workspace=self._workspace, final_url=hit["url"], route="compiled_read",
                )
                append_record(self._workspace, run_id, {"type": "proof", **proof})
                return json.dumps({
                    "success": True,
                    "goal": goal,
                    "run_id": run_id,
                    "turns_executed": 0,
                    "final_url": hit["url"],
                    "extracted_data": hit["extracted_data"],
                    "error": None,
                    "route": "compiled_read",
                    "proof": proof,
                    "summary": "Read from a compiled public-page read (no browser); values are live.",
                    "timings": run_timings,
                    "macro_used": None,
                    "downloads": [],
                })

        try:
            async with EffectorSession(
                self._workspace, session_domain=session_domain,
                stealth=self._stealth, network_shield=self._network_shield,
                # None means "as the orchestrator decided" (the user's browser, when this
                # run was opted in). False forces the container, which is what anonymous
                # work wants even on an opted-in run.
                allow_remote=None if wants_identity else False,
            ) as session:
                _tm["session"] = _time.monotonic()
                page = session.page
                # R3: what this run actually had available. A stubbed session (tests,
                # the remote lane) may not carry a manifest at all, and whatever comes
                # back goes straight into json.dumps below — so fall back rather than
                # trusting the attribute's shape.
                # isinstance, not hasattr: an AsyncMock satisfies hasattr("to_dict")
                # and returns a mock from it, which then blows up in json.dumps below.
                manifest = getattr(session, "capabilities", None)
                if isinstance(manifest, CapabilityManifest):
                    engine_info = manifest.to_dict()
                else:
                    engine_info = {
                        "engine": str(getattr(session, "engine", "chromium") or "chromium"),
                        "engine_reason": "no capability manifest on this session",
                    }

                # Which lane this call ACTUALLY got, recorded next to which one it asked
                # for.
                #
                # Both, not just the request. The pre-check above refuses "me" when no
                # browser is attached, so the two agree on the common paths — but the
                # request is what someone reading a trace will assume happened, and a
                # future change to how the lane is chosen would make that assumption
                # wrong silently. Recording what the session actually is means the trace
                # cannot drift away from the browser.
                #
                # Read off the session rather than off `wants_identity`, for the same
                # reason _is_remote_lane checks the page object: what matters is the
                # browser in hand, not what was configured.
                lane_info = {
                    "requested": "me" if wants_identity else "anonymous",
                    "actual": "user_browser" if getattr(session, "_remote", False) else "container",
                }
                engine_info["lane"] = lane_info
                if url:
                    # Real bug, found live 2026-08-27 (test 5.1): this call used to run
                    # before the ReAct loop even started, so it never went anywhere near
                    # is_dangerous(). The mid-loop navigate fix (escalation.py) closed
                    # the case where the MODEL decides to navigate somewhere dangerous
                    # partway through a run — it never touched this one, where the
                    # dangerous destination is just the tool's own `url` argument. Same
                    # gate, same reasoning: a caller (model or otherwise) blocked here
                    # must not be able to reach the same page by asking for it as the
                    # starting URL instead.
                    nav_step = Step(step=0, action="navigate", url=url)
                    if self._require_approval and is_dangerous(nav_step):
                        decision = await request_approval(nav_step, agent_id, run_id, page)
                        # Fail closed — see escalation.is_approved.
                        if not is_approved(decision):
                            return json.dumps({
                                "error": (
                                    f"Escalation gate blocked the starting URL ({decision})"
                                ),
                                "goal": goal,
                            })
                    try:
                        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                        _tm["navigated"] = _time.monotonic()
                        if self._autonomous_challenges:
                            from nanoagent.agent.effector.perception.challenge_solver import ChallengeSolver
                            await ChallengeSolver.solve_if_present(page, timeout_s=4.0)
                        _tm["challenge"] = _time.monotonic()
                    except Exception as err:
                        return json.dumps({"error": f"Failed to load starting URL: {err}"})

                # stage45 item 3: start the timer-driven live-frame pump. The tool is
                # the wiring point because it is the one place that already has both the
                # session (which owns the screencast) and the loop's poster — the
                # session must not import react_loop, and the loop cannot outlive its own
                # thirteen return sites to clean a task up.
                try:
                    from nanoagent.agent.effector.react_loop import push_live_frame

                    session.start_frame_pump(push_live_frame)
                except Exception as err:
                    logger.debug(f"effector: could not start the live frame pump — {err}")

                # No context means the remote lane: there is one tab, the extension
                # picks it per command, and TabManager has no context to listen on.
                tab_manager = TabManager(session.context, initial_page=page) if session.context else None
                if tab_manager is not None:
                    # Bug found live 2026-09-03: the frame pump screenshotted `page`
                    # forever, so the moment an OAuth flow ("Continue with Google")
                    # opened its own tab, the human driving kept watching the original,
                    # now-backgrounded page — frozen — with no way to tell why nothing
                    # they clicked did anything.
                    session.active_page_resolver = tab_manager.get_active_page

                # stage 49 phase 5.3 — the human's end of the wheel.
                #
                # The cycle channel is already open for frames; this gives it somewhere
                # to deliver what comes back down. Input is refused until takeover is
                # armed (phase 5.4), so wiring it here does not let a click reach the
                # page while the agent is mid-action — two drivers on one browser leaves
                # a page state that belongs to neither.
                #
                # page_resolver closes the other half of the same bug: without it, a
                # click during takeover keeps landing on the tab that existed when this
                # session was built, not the popup the human is actually looking at.
                takeover = TakeoverSession(
                    page, page_resolver=tab_manager.get_active_page if tab_manager else None,
                )

                # Stage 50 phase 5 — the real screen, for when someone actually drives.
                # Constructed here (the tool owns the session's lifetime) but not started:
                # the takeover action brings it up and takes it down, because a VNC
                # session costs CPU and bandwidth for as long as it is open and watching
                # does not need it.
                #
                # `getattr` for the reason the manifest above uses it: a stubbed session
                # (tests, the remote lane) need not carry every attribute a real one has,
                # and a live view is never worth failing a run over.
                live_screen = LiveScreen(getattr(session, "display", None))
                channel = await current_channel()
                if channel is not None:
                    channel.on_message = takeover_router(takeover)

                _tm["loop_start"] = _time.monotonic()
                result = await run_react_loop(
                    page=page,
                    tab_manager=tab_manager,
                    live_screen=live_screen,
                    # Phase 5.4: the loop parks here when it asks for hands.
                    takeover=takeover,
                    # Lets a failed macro replay roll back cookies and storage, not just
                    # navigate back — a half-run login flow leaves state behind that the
                    # URL alone doesn't undo. See react_loop._try_macro_fast_path.
                    browser_context=session.context,
                    # stage44 step 2: the live browser view's frame source. Read
                    # through a lambda, not passed as a value — `last_frame_data_url`
                    # is replaced on every CDP frame, so the loop has to re-read the
                    # attribute each time rather than capture whatever it was here.
                    frame_source=lambda: session.last_frame_data_url,
                    provider=self._decision_provider,
                    model=self._decision_model,
                    goal=goal,
                    max_turns=max_turns,
                    max_external_actions=max_external_actions,
                    agent_id=agent_id,
                    run_id=run_id,
                    require_approval=self._require_approval,
                    vision_provider=self._vision_provider or self._provider,
                    vision_model=self._vision_model,
                    workspace=self._workspace,
                    session_domain=session_domain,
                    use_human_cadence=self._use_human_cadence,
                    tool_registry=self._tool_registry,
                    tool_persistence=self._tool_persistence,
                    job_id=self._job_id,
                    health_monitor=self._health_monitor,
                    synthesis_provider=self._synthesis_provider,
                    synthesis_model=self._synthesis_model,
                    verify_goal=verify_goal,
                    # R2: the firewall's real job is upstream of the decision, inside
                    # the loop. The dispatcher-level sanitize below stays as
                    # defence-in-depth for consumers of the result JSON.
                    firewall_protection=self._firewall_protection,
                    # stage45 gap E. The session owns the manager, so the files a run
                    # produced outlive the loop that produced them and can be reported
                    # below whatever way the run ended.
                    download_manager=getattr(session, "downloads", None),
                    # stage45 gap D: the isolated world needs the session's CDP session.
                    # Without it evaluate_isolated falls back to a plain page.evaluate —
                    # which still works, but in the MAIN world, silently losing the
                    # cloaking the isolated default is chosen for.
                    cdp_session=getattr(session, "_cdp_session", None),
                    # stage45 gap F. getattr for the same reason every other session
                    # attribute here uses it — a stubbed session carries neither.
                    dialog_watchdog=getattr(session, "dialogs", None),
                    crash_watchdog=getattr(session, "crash", None),
                )

                _tm["loop_end"] = _time.monotonic()
                # Drain here, INSIDE the session, not at teardown. The teardown drain in
                # __aexit__ runs after this function has already built its JSON, so a
                # file saved there would exist on disk and be missing from the result —
                # a report that is wrong in the one direction that matters. This makes
                # the teardown drain a genuine last resort rather than the normal path.
                # getattr, not attribute access, for the same reason `capabilities`
                # above uses it: a stubbed session (tests) may not carry a manager at
                # all, and a run must not fail over the reporting of a feature it
                # never used.
                downloads = getattr(session, "downloads", None)
                if downloads is not None:
                    try:
                        await downloads.drain()
                    except Exception as err:
                        logger.warning(f"effector: final download drain failed — {err}")
                    result.downloads = downloads.to_dicts()

                # isinstance, not a None check, for the reason this file records above
                # for `capabilities`: an AsyncMock answers getattr with another mock,
                # and .records() then returns a coroutine that a list comprehension
                # chokes on. A stubbed session should report no dialogs, not explode.
                dialogs = getattr(session, "dialogs", None)
                if isinstance(dialogs, DialogWatchdog):
                    dialog_records = [d.to_dict() for d in dialogs.records()]

                # Stage 61 phase 6: prove the result against the page while it is still
                # open — before the firewall rewrites extracted values, so the values
                # compared are the ones the page produced.
                try:
                    from nanoagent.agent.effector.proof import build_proof
                    from nanoagent.agent.effector.screenshot import extract_page_text

                    page_text = ""
                    if result.extracted_data:
                        try:
                            page_text = await extract_page_text(page, max_chars=60000)
                        except Exception as err:  # noqa: BLE001
                            logger.debug(f"effector: proof could not read the final page — {err}")
                    proof = build_proof(
                        success=bool(result.success),
                        extracted=result.extracted_data if isinstance(result.extracted_data, dict) else None,
                        page_text=page_text,
                        downloads=result.downloads if isinstance(getattr(result, "downloads", None), list) else [],
                        workspace=self._workspace,
                        final_url=result.final_url,
                        macro_used=result.macro_used if isinstance(getattr(result, "macro_used", None), str) else None,
                        error=result.error if isinstance(getattr(result, "error", None), str) else None,
                        steps=[
                            {"action": t.action.action, "url_after": getattr(t.result, "url_after", None)}
                            for t in (result.turns or [])
                            if getattr(t, "action", None) and t.action.action != "done"
                        ],
                        start_url=url,
                    )
                except Exception as err:  # noqa: BLE001
                    logger.debug(f"effector: building the proof failed — {err}")

                # Phase 16: Dispatcher-level protections
                if self._firewall_protection and result.extracted_data is not None:
                    from nanoagent.agent.effector.security.prompt_firewall import PromptFirewall
                    result.extracted_data = PromptFirewall.sanitize_data(result.extracted_data)

                if self._merkle_audit and result.turns:
                    from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger
                    ledger = MerkleActionLedger()
                    for t in result.turns:
                        ledger.record_step(
                            turn=t.turn,
                            action=t.action.action if t.action else "noop",
                            target=str(t.action.target) if t.action else "",
                            url=result.final_url or "",
                            snapshot_summary=str(t.thought),
                            status=t.result.status if t.result else "done",
                        )
                    # R1: the chain used to end its life here as an unread local. Verify
                    # it, write it down, and hand the caller the verdict — an audit
                    # nobody can read afterwards audits nothing.
                    audit_result = {
                        "verified": ledger.verify_integrity(),
                        "trusted_key": ledger.trusted,
                        "blocks": len(ledger.blocks),
                        "final_hmac": ledger.final_hmac,
                        "path": None,
                    }
                    try:
                        audit_result["path"] = str(ledger.persist(self._workspace, run_id))
                    except Exception as err:
                        # Degraded observability is not a reason to throw away the run's
                        # actual work product.
                        logger.warning(f"effector: failed to persist audit ledger for {run_id} — {err}")
                    if not ledger.trusted:
                        logger.warning(
                            "effector: audit ledger signed with an ephemeral key (no cycle token "
                            "in the agent environment) — corruption-evident only, NOT tamper-evident"
                        )
                _tm["post_loop"] = _time.monotonic()
        except Exception as err:
            logger.warning(f"effector: run failed for goal={goal!r} — {err}")
            return json.dumps({"error": str(err), "goal": goal})

        _tm["end"] = _time.monotonic()
        from nanoagent.agent.effector.decision_log import append_record, record_run_timings
        run_timings = record_run_timings(
            self._workspace, run_id, _tm,
            engine=engine_info.get("engine"),
            warm_browser=engine_info.get("warm_browser"),
        )
        if proof is not None:
            append_record(self._workspace, run_id, {"type": "proof", **proof})

        return json.dumps({
            "success": result.success,
            "goal": result.goal,
            "run_id": run_id,
            "turns_executed": result.turns_executed,
            "final_url": result.final_url,
            "extracted_data": result.extracted_data,
            "error": result.error,
            "synthesized_tool": result.synthesized_tool,
            "synthesis_context": result.synthesis_context,
            "usage": result.usage,
            "goal_checklist": result.goal_checklist,
            "macro_used": result.macro_used,
            "macro_distilled": result.macro_distilled,
            "audit": audit_result,
            "proof": proof,
            "timings": run_timings,
            "capabilities": engine_info,
            "injection_flags": list(getattr(result, "injection_flags", []) or []),
            "canary_triggered": bool(getattr(result, "canary_triggered", False)),
            # stage45 gap E. Failed downloads are included alongside the saved ones, with
            # their reason — an agent told only about successes reads a refused download
            # (over the size cap, blocked by the network policy) as a file that was never
            # asked for, and tries the same thing again.
            # isinstance, not `or []`, for the reason this file already records above
            # for `capabilities`: a mocked result answers every attribute with another
            # mock, and list()-ing one raises inside json.dumps rather than degrading.
            "downloads": (
                result.downloads if isinstance(getattr(result, "downloads", None), list) else []
            ),
            # stage45 gap F: a crashed run is checkpointed and resumable. A caller that
            # cannot tell this apart from "the agent could not do it" either retries a
            # hopeless goal or abandons a recoverable one.
            "browser_crashed": bool(getattr(result, "browser_crashed", False)),
            "dialogs": dialog_records,
            "turns": [
                {
                    "turn": t.turn,
                    "thought": t.thought,
                    "action": t.action.action,
                    "target": t.action.target,
                    "status": t.result.status if t.result else "done",
                    "self_healed": t.self_healed,
                }
                for t in result.turns
            ],
        }, ensure_ascii=False)
