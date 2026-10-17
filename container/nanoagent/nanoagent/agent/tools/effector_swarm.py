"""The `effector_swarm` tool — runs N independent goals concurrently across
isolated browser sessions.

God-level pillar 02, 2026-08-24: the buildable core of
"swarm" for a single-container Effector — genuine parallelism via asyncio.gather
across independent EffectorSession instances (each launches its own Chromium
process/context — see browser_session.py, nothing shared between them), not the
geo-distributed-proxy-mesh/consensus-engine version the original doc sketched.
Bounded by max_concurrency (a Semaphore): a single container has a real CPU/memory
ceiling on how many Chromium processes it can host, so unbounded parallelism would
just OOM the container, not actually go faster.

Jobs that depend on each other's output belong in `effector_workflow`'s multi-stage
type (sequential, with rollback), not here — this tool assumes independence and
makes no ordering guarantees between jobs.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.tools.base import Tool

_MAX_CONCURRENCY_CAP = 6  # hard ceiling regardless of what the caller asks for


class EffectorSwarmTool(Tool):
    """Run several independent browser goals in parallel — e.g. the same lookup or
    form filled across several URLs — instead of one `effector` call at a time. Each
    job gets its own isolated browser session; one job failing doesn't stop the rest."""

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
        tool_registry: Any = None,
        tool_persistence: Any = None,
        job_id: str | None = None,
        health_monitor: Any = None,
        synthesis_provider: Any = None,
        synthesis_model: str | None = None,
    ):
        self._workspace = Path(workspace)
        self._provider = provider
        self._model = model
        self._decision_provider = decision_provider or provider
        self._decision_model = decision_model or model
        self._vision_provider = vision_provider
        self._vision_model = vision_model
        self._use_human_cadence = use_human_cadence
        self._stealth = stealth
        self._network_shield = network_shield
        self._tool_registry = tool_registry
        self._tool_persistence = tool_persistence
        self._job_id = job_id
        self._health_monitor = health_monitor
        self._synthesis_provider = synthesis_provider
        self._synthesis_model = synthesis_model

    @property
    def name(self) -> str:
        return "effector_swarm"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def description(self) -> str:
        return (
            "Run several INDEPENDENT browser goals concurrently, each in its own "
            "isolated browser session — for naturally parallel work (the same "
            "lookup/form across several URLs, several unrelated goals) instead of "
            "one `effector` call after another. A failure in one job doesn't stop "
            "the others; the result lists each job's own success/error separately. "
            "Not for goals that depend on each other's output or must run in a "
            "specific order — use `effector_workflow`'s multi-stage type for that."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "jobs": {
                    "type": "array",
                    "description": "Independent goals to run in parallel.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "goal": {"type": "string"},
                            "url": {"type": "string"},
                            "session_domain": {"type": "string"},
                            "max_turns": {"type": "integer"},
                        },
                        "required": ["goal"],
                    },
                },
                "max_concurrency": {
                    "type": "integer",
                    "description": f"Max jobs running at once (default 3, hard cap {_MAX_CONCURRENCY_CAP} "
                                    "— each job is its own Chromium process).",
                },
            },
            "required": ["jobs"],
        }

    async def _run_one_job(self, job: dict[str, Any], sem: asyncio.Semaphore, agent_id: str) -> dict[str, Any]:
        from nanoagent.agent.effector.browser_session import EffectorSession
        from nanoagent.agent.effector.capabilities.tab_manager import TabManager
        from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval
        from nanoagent.agent.effector.react_loop import run_react_loop
        from nanoagent.agent.effector.types import Step

        goal = job["goal"]
        url = job.get("url")
        session_domain = job.get("session_domain")
        max_turns = job.get("max_turns", 20)
        run_id = str(uuid.uuid4())

        async with sem:
            try:
                async with EffectorSession(
                    self._workspace, session_domain=session_domain,
                    stealth=self._stealth, network_shield=self._network_shield,
                    # allow_remote=False, stated rather than inherited. A swarm runs
                    # several sessions at once and a remote browser gives them ONE tab to
                    # fight over — they would interleave clicks on the same page and each
                    # believe it was theirs. The other genuine reason to stay in the
                    # container; see EffectorSession.__init__.
                    allow_remote=False,
                ) as session:
                    page = session.page
                    if url:
                        # Real bug, found live 2026-08-27 (test 5.1): same gap as
                        # EffectorTool.execute()'s own initial page.goto() — this ran
                        # before run_react_loop's is_dangerous/request_approval gate
                        # ever engaged. A job whose `url` itself is the dangerous
                        # destination went through with no check at all.
                        nav_step = Step(step=0, action="navigate", url=url)
                        if is_dangerous(nav_step):
                            decision = await request_approval(nav_step, agent_id, run_id, page)
                            # Fail closed — see escalation.is_approved.
                            if not is_approved(decision):
                                return {
                                    "goal": goal, "run_id": run_id, "success": False,
                                    "final_url": getattr(page, "url", "") or "",
                                    "error": f"Escalation gate blocked the starting URL ({decision})",
                                }
                        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
                    tab_manager = TabManager(session.context, initial_page=page)

                    # stage44 step 2: deliberately NO frame_source here. Every job in
                    # a swarm runs its own EffectorSession/Chromium concurrently, and
                    # the live view is a single per-agent stream — wiring all of them
                    # would interleave frames from N different browsers into one <img>
                    # and show nothing coherent. Which job (if any) a swarm should
                    # broadcast is a step-4 UI question, not something to guess at here.
                    result = await run_react_loop(
                        page=page, tab_manager=tab_manager,
                        provider=self._decision_provider, model=self._decision_model,
                        goal=goal, max_turns=max_turns, agent_id=agent_id, run_id=run_id,
                        vision_provider=self._vision_provider or self._provider, vision_model=self._vision_model,
                        workspace=self._workspace, session_domain=session_domain,
                        use_human_cadence=self._use_human_cadence,
                        tool_registry=self._tool_registry, tool_persistence=self._tool_persistence,
                        job_id=self._job_id, health_monitor=self._health_monitor,
                        synthesis_provider=self._synthesis_provider, synthesis_model=self._synthesis_model,
                        # Unlike frame_source above, this one IS per-job and safe: each
                        # job has its own session and its own manager, and two jobs that
                        # download the same filename get -1/-2 rather than one clobbering
                        # the other (downloads._unique_path). Nothing is shared.
                        download_manager=getattr(session, "downloads", None),
                    )
                return {
                    "goal": goal, "run_id": run_id, "success": result.success,
                    "final_url": result.final_url, "extracted_data": result.extracted_data,
                    "turns_executed": result.turns_executed, "error": result.error,
                }
            except Exception as err:
                logger.warning(f"effector_swarm: job failed for goal={goal!r} — {err}")
                return {"goal": goal, "run_id": run_id, "success": False, "error": str(err)}

    async def execute(self, jobs: list[dict[str, Any]], max_concurrency: int = 3, **kwargs: Any) -> str:
        if not jobs:
            return json.dumps({"error": "jobs must be a non-empty list"})

        agent_id = os.environ.get("AGENT_ID", "unknown")
        concurrency = max(1, min(max_concurrency, _MAX_CONCURRENCY_CAP))
        sem = asyncio.Semaphore(concurrency)
        started = time.monotonic()

        results = await asyncio.gather(*[self._run_one_job(job, sem, agent_id) for job in jobs])

        succeeded = sum(1 for r in results if r["success"])
        return json.dumps({
            "total_jobs": len(jobs), "succeeded": succeeded, "failed": len(jobs) - succeeded,
            "duration_ms": int((time.monotonic() - started) * 1000),
            "results": results,
        }, ensure_ascii=False)
