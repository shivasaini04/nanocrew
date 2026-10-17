"""Ported from computer-use/hierarchical-orchestrator.ts. Solves long-horizon
(50+ step) multi-app enterprise workflows by enforcing strict precondition/
postcondition invariant gates between stages, with per-stage retry and rollback —
so a failure in stage 6 of an 8-stage Stripe→Salesforce→Slack workflow doesn't
silently corrupt state in the apps stages 1-5 already touched.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from loguru import logger

StagePrecondition = Callable[[dict[str, Any]], Awaitable[bool] | bool]
StageRun = Callable[[dict[str, Any], Any], Awaitable[dict[str, Any]]]
StagePostcondition = Callable[[dict[str, Any], Any], Awaitable["StageVerificationResult"] | "StageVerificationResult"]
StageRollback = Callable[[dict[str, Any], Any], Awaitable[None]]


@dataclass
class StageVerificationResult:
    verified: bool
    reason: str | None = None
    data: dict[str, Any] | None = None


@dataclass
class TaskStage:
    id: str
    name: str
    app: str  # e.g. "Stripe", "Salesforce", "Slack", "Portal"
    run: StageRun
    postconditions: list[StagePostcondition]
    description: str | None = None
    preconditions: list[StagePrecondition] = field(default_factory=list)
    rollback: StageRollback | None = None


@dataclass
class StageExecutionReport:
    stage_id: str
    name: str
    app: str
    status: str  # 'passed' | 'failed' | 'skipped'
    duration_ms: int
    error: str | None = None
    verification_reason: str | None = None


@dataclass
class HierarchicalWorkflowReport:
    run_id: str
    success: bool
    completed_stages: int
    total_stages: int
    stages: list[StageExecutionReport]
    context: dict[str, Any]
    failed_stage: str | None = None


async def _maybe_await(value):
    if asyncio.iscoroutine(value):
        return await value
    return value


async def run_hierarchical_workflow(
    stages: list[TaskStage],
    initial_context: dict[str, Any],
    page: Any = None,
    run_id: str | None = None,
    max_stage_retries: int = 2,
    stop_on_stage_failure: bool = True,
) -> HierarchicalWorkflowReport:
    resolved_run_id = run_id or f"hwf-{int(time.time() * 1000)}"
    context = dict(initial_context)
    reports: list[StageExecutionReport] = []

    logger.info(f"effector hierarchical-orchestrator: starting {len(stages)}-stage workflow, run_id={resolved_run_id}")

    for stage in stages:
        start_time = time.monotonic()

        # 1. Preconditions
        if stage.preconditions:
            pre_passed = True
            for pre in stage.preconditions:
                ok = await _maybe_await(pre(context))
                if not ok:
                    pre_passed = False
                    break

            if not pre_passed:
                error = f"Precondition failed for stage {stage.name} ({stage.app})"
                logger.warning(f"effector hierarchical-orchestrator: {error}")
                reports.append(StageExecutionReport(
                    stage_id=stage.id, name=stage.name, app=stage.app, status="failed",
                    duration_ms=int((time.monotonic() - start_time) * 1000), error=error,
                ))
                return HierarchicalWorkflowReport(
                    run_id=resolved_run_id, success=False,
                    completed_stages=sum(1 for r in reports if r.status == "passed"),
                    total_stages=len(stages), stages=reports, context=context, failed_stage=stage.id,
                )

        # 2. Execute with retry loop
        stage_success = False
        stage_error: str | None = None
        stage_verification_reason: str | None = None

        for attempt in range(1, max_stage_retries + 1):
            try:
                exec_result = await stage.run(context, page)
                if not exec_result.get("success"):
                    raise RuntimeError(exec_result.get("error") or "Stage execution failed")

                if exec_result.get("data"):
                    context.update(exec_result["data"])

                # 3. Verify postcondition invariants
                post_passed = True
                for post in stage.postconditions:
                    v_res = await _maybe_await(post(context, page))
                    if not v_res.verified:
                        post_passed = False
                        stage_verification_reason = v_res.reason or "Postcondition invariant assertion failed"
                        break
                    if v_res.data:
                        context.update(v_res.data)

                if post_passed:
                    stage_success = True
                    break
                raise RuntimeError(f"Verification failed: {stage_verification_reason}")

            except Exception as err:
                stage_error = str(err)
                logger.warning(f"effector hierarchical-orchestrator: stage {stage.id} attempt {attempt}/{max_stage_retries} failed — {stage_error}")
                if attempt < max_stage_retries:
                    await asyncio.sleep(1 * attempt)

        duration_ms = int((time.monotonic() - start_time) * 1000)

        if stage_success:
            reports.append(StageExecutionReport(
                stage_id=stage.id, name=stage.name, app=stage.app, status="passed", duration_ms=duration_ms,
            ))
        else:
            reports.append(StageExecutionReport(
                stage_id=stage.id, name=stage.name, app=stage.app, status="failed",
                duration_ms=duration_ms, error=stage_error, verification_reason=stage_verification_reason,
            ))

            if stage.rollback:
                try:
                    await stage.rollback(context, page)
                except Exception as r_err:
                    logger.error(f"effector hierarchical-orchestrator: rollback error for stage {stage.id} — {r_err}")

            if stop_on_stage_failure:
                return HierarchicalWorkflowReport(
                    run_id=resolved_run_id, success=False,
                    completed_stages=sum(1 for r in reports if r.status == "passed"),
                    total_stages=len(stages), stages=reports, context=context, failed_stage=stage.id,
                )

    all_passed = all(r.status == "passed" for r in reports)
    return HierarchicalWorkflowReport(
        run_id=resolved_run_id, success=all_passed,
        completed_stages=sum(1 for r in reports if r.status == "passed"),
        total_stages=len(stages), stages=reports, context=context,
    )
