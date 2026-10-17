"""Ported from computer-use/blueprints/index.ts (`runDigitalEmployeeWorkflow` +
`exportLeadsToCsv`), restructured around this port's react_loop instead of the TS
tree's separate ReAct implementation — the blueprints below are otherwise unchanged
goal templates.

`BlueprintContext` bundles the parameters every blueprint needs (page, provider,
model, workspace, ids) so each blueprint function takes one context object instead
of repeating a dozen keyword arguments — this wasn't in the TS original because TS's
blueprints took a bare `Page` and reached a module-level model/provider resolver
(react-loop.ts's own getVisionModel-style lookup); this port threads the caller's
already-resolved provider/model through instead, consistent with resolver.py's and
desktop_vision.py's established pattern of not re-deriving model selection per module.
"""

from __future__ import annotations

import csv
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval
from nanoagent.agent.effector.react_loop import run_react_loop
from nanoagent.agent.effector.types import EffectorExecutionResult, Step


@dataclass
class BlueprintContext:
    page: Any
    provider: Any
    model: str
    workspace: Path
    agent_id: str = "unknown"
    run_id: str | None = None
    vision_provider: Any = None
    vision_model: str | None = None
    use_human_cadence: bool = True
    tool_registry: Any = None
    tool_persistence: Any = None
    job_id: str | None = None
    health_monitor: Any = None
    synthesis_provider: Any = None
    synthesis_model: str | None = None
    tab_manager: Any = None
    verify_goal: bool = False
    # stage44 step 2: zero-arg callable returning the newest live browser frame as a
    # data URL (see run_react_loop's `frame_source`). None for any caller that has no
    # EffectorSession to read one from.
    frame_source: Any = None
    # stage45 gap E: the session's DownloadManager. The invoice/receipt blueprint is
    # the reason this gap was ranked at all — it shipped able to read an invoice off a
    # page and unable to save the PDF of it — so the blueprint path gets the manager
    # for the same reason the plain effector tool does. None for callers with no
    # EffectorSession, which keeps `download` failing loudly rather than silently.
    download_manager: Any = None


@dataclass
class BlueprintResult:
    type: str
    success: bool
    data: dict[str, Any]
    artifact_path: str | None = None
    # Gap-closing pass, 2026-08-23: the underlying react_loop run's token usage
    # (see EffectorExecutionResult.usage) — None for smart-form, which doesn't run
    # react_loop at all.
    usage: dict | None = None
    # God-level pillar 05, 2026-08-23: mirrors EffectorExecutionResult.goal_checklist
    # — None unless ctx.verify_goal was set. Same smart-form exception as usage.
    goal_checklist: list[str] | None = None


async def _run_goal(ctx: BlueprintContext, goal: str, url: str | None, session_domain: str | None, max_turns: int) -> EffectorExecutionResult:
    # run_react_loop has no url param — navigation is the caller's job (see
    # EffectorTool.execute()'s page.goto() before it calls the loop). Match that
    # here rather than assuming the loop navigates for us.
    if url:
        # Real bug, found live 2026-08-27 (test 5.1): the same gap as
        # EffectorTool.execute()'s own initial page.goto() (see that file's fix) —
        # this ran before run_react_loop and its is_dangerous/request_approval gate
        # ever engaged, for every blueprint (multi-stage stage URLs included). A
        # stage whose `url` itself is the dangerous destination (not just a click
        # partway through it) went through with no check at all.
        nav_step = Step(step=0, action="navigate", url=url)
        if is_dangerous(nav_step):
            decision = await request_approval(nav_step, ctx.agent_id, ctx.run_id or "unknown", ctx.page)
            # Fail closed — see escalation.is_approved.
            if not is_approved(decision):
                return EffectorExecutionResult(
                    success=False, goal=goal, turns_executed=0, turns=[],
                    final_url=getattr(ctx.page, "url", "") or "",
                    error=f"Escalation gate blocked the starting URL ({decision})",
                )
        await ctx.page.goto(url, wait_until="domcontentloaded", timeout=30000)

    return await run_react_loop(
        page=ctx.page, provider=ctx.provider, model=ctx.model, goal=goal,
        max_turns=max_turns, agent_id=ctx.agent_id,
        run_id=ctx.run_id or f"wf-{int(time.time() * 1000)}",
        vision_provider=ctx.vision_provider or ctx.provider, vision_model=ctx.vision_model,
        workspace=ctx.workspace, session_domain=session_domain,
        use_human_cadence=ctx.use_human_cadence,
        tool_registry=ctx.tool_registry, tool_persistence=ctx.tool_persistence,
        job_id=ctx.job_id, health_monitor=ctx.health_monitor,
        synthesis_provider=ctx.synthesis_provider, synthesis_model=ctx.synthesis_model,
        tab_manager=ctx.tab_manager, verify_goal=ctx.verify_goal,
        frame_source=ctx.frame_source,
        download_manager=ctx.download_manager,
    )


async def run_multi_stage_workflow(
    ctx: BlueprintContext,
    stages: list[dict[str, Any]],
    max_stage_retries: int = 2,
    stop_on_stage_failure: bool = True,
) -> BlueprintResult:
    """God-level pillar 02, 2026-08-24: the reachable wiring
    for orchestration/hierarchical_orchestrator.py — it existed, tested, since Phase 4
    but nothing outside its own test file ever called it, because TaskStage.run takes
    a Python callable and an LLM tool call can only ever hand over plain JSON. This
    closes that gap: each stage dict here becomes a TaskStage whose `run` just drives
    `_run_goal` (the same react_loop every other blueprint uses), so the LLM authors
    a sequence of {name, app, goal} stages and gets the orchestrator's real
    precondition/retry/rollback gates between them for free — e.g. "log into Stripe
    and export the invoices" -> "log into the accounting portal and upload them",
    where a failure in stage 2 shouldn't silently be reported as if stage 1's work
    was safe to build on.

    One browser session/page for the whole sequence (this call runs inside a single
    EffectorSession, same as every other blueprint) — stages that need genuinely
    separate sessions or need to run at the same time instead of in order are
    `effector_swarm`'s job, not this one.
    """
    from nanoagent.agent.effector.orchestration.hierarchical_orchestrator import (
        TaskStage,
        run_hierarchical_workflow,
    )

    if not stages:
        return BlueprintResult(type="multi-stage", success=False, data={"error": "stages must be a non-empty list"})

    def _make_stage(spec: dict[str, Any]) -> TaskStage:
        stage_id = spec.get("id") or spec.get("name") or "stage"
        goal = spec["goal"]
        url = spec.get("url")
        session_domain = spec.get("session_domain")
        max_turns = spec.get("max_turns", 20)

        async def _run(context: dict[str, Any], page: Any) -> dict[str, Any]:
            exec_result = await _run_goal(ctx, goal, url, session_domain, max_turns)
            return {
                "success": exec_result.success,
                "error": exec_result.error,
                "data": {
                    f"{stage_id}_result": {
                        "final_url": exec_result.final_url,
                        "extracted_data": exec_result.extracted_data,
                        "turns_executed": exec_result.turns_executed,
                    },
                },
            }

        return TaskStage(
            id=stage_id, name=spec.get("name", stage_id), app=spec.get("app", "web"),
            run=_run, postconditions=[], description=spec.get("description"),
        )

    task_stages = [_make_stage(s) for s in stages]
    report = await run_hierarchical_workflow(
        task_stages, initial_context={}, page=ctx.page, run_id=ctx.run_id,
        max_stage_retries=max_stage_retries, stop_on_stage_failure=stop_on_stage_failure,
    )

    data = {
        "completed_stages": report.completed_stages, "total_stages": report.total_stages,
        "failed_stage": report.failed_stage,
        "stages": [
            {"id": s.stage_id, "name": s.name, "app": s.app, "status": s.status,
             "error": s.error, "duration_ms": s.duration_ms}
            for s in report.stages
        ],
        "context": {k: v for k, v in report.context.items() if not k.startswith("_")},
    }
    return BlueprintResult(type="multi-stage", success=report.success, data=data)


def export_leads_to_csv(artifacts_dir: Path, run_id: str, leads: list[dict[str, Any]]) -> str:
    """Export structured lead records to a CSV file."""
    artifacts_dir = Path(artifacts_dir)
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    file_path = artifacts_dir / f"leads-{run_id}.csv"
    with file_path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["Name", "Title", "Company", "Email", "LinkedInURL"])
        for lead in leads:
            writer.writerow([
                lead.get("name", ""), lead.get("title", ""), lead.get("company", ""),
                lead.get("email", ""), lead.get("linkedin_url", lead.get("linkedinUrl", "")),
            ])
    return str(file_path)


async def offer_to_save_as_skill(workspace: Path, blueprint_name: str, goal: str, result: EffectorExecutionResult) -> str | None:
    """On a successful blueprint run, persist the goal + step trace as a skill via
    the existing skill infrastructure (ledger, provenance, linting) — so the next
    run of the same task type, on any agent that reads this workspace's skills,
    starts from a working recipe instead of blank. Returns the save_skill tool's
    response message, or None if the run didn't succeed."""
    if not result.success:
        return None

    from nanoagent.agent.tools.save_skill import SaveSkillTool

    steps_summary = "\n".join(
        f"- Turn {t.turn}: {t.action.action} {t.action.target or ''} — {t.thought}"
        for t in result.turns if t.action.action != "done"
    )
    content = (
        f"# Effector blueprint: {blueprint_name}\n\n"
        f"Goal template that worked (turn {result.turns_executed}, {'success' if result.success else 'failed'}):\n\n"
        f"> {goal}\n\n"
        f"## What actually happened\n\n{steps_summary}\n\n"
        f"Final URL: {result.final_url}\n"
    )
    if result.extracted_data:
        content += f"\nExtracted data shape: {list(result.extracted_data.keys())}\n"

    tool = SaveSkillTool(workspace)
    try:
        return await tool.execute(name=f"effector-{blueprint_name}", content=content)
    except Exception as err:
        logger.warning(f"effector blueprint: failed to save skill for {blueprint_name} — {err}")
        return None


async def run_digital_employee_workflow(workflow_type: str, ctx: BlueprintContext, artifacts_dir: Path | None = None, **config_kwargs: Any) -> BlueprintResult:
    """High-level dispatcher for the turnkey blueprints — ported from
    computer-use/blueprints/index.ts's `runDigitalEmployeeWorkflow`. `config_kwargs`
    are forwarded to the matching blueprint's Config dataclass."""
    try:
        if workflow_type == "linkedin-apply":
            from nanoagent.agent.effector.blueprints.linkedin_job_applier import (
                LinkedInApplierConfig,
                run_linkedin_job_applier,
            )
            res = await run_linkedin_job_applier(LinkedInApplierConfig(**config_kwargs), ctx)
            data = {"jobs_found": res.jobs_found, "submitted": res.submitted, "execution_success": res.execution.success}
            await offer_to_save_as_skill(ctx.workspace, "linkedin-job-applier", config_kwargs.get("job_query", ""), res.execution)
            return BlueprintResult(type=workflow_type, success=True, data=data, usage=res.execution.usage, goal_checklist=res.execution.goal_checklist)

        if workflow_type == "b2b-lead-enrich":
            from nanoagent.agent.effector.blueprints.b2b_lead_enricher import LeadEnricherConfig, run_b2b_lead_enricher
            res = await run_b2b_lead_enricher(LeadEnricherConfig(**config_kwargs), ctx)
            data = {"leads_count": len(res.leads_extracted), "leads": res.leads_extracted}
            artifact_path = None
            if artifacts_dir and res.leads_extracted:
                artifact_path = export_leads_to_csv(artifacts_dir, ctx.run_id or "run", res.leads_extracted)
            await offer_to_save_as_skill(ctx.workspace, "b2b-lead-enricher", config_kwargs.get("icp_title", ""), res.execution)
            return BlueprintResult(type=workflow_type, success=True, data=data, artifact_path=artifact_path, usage=res.execution.usage, goal_checklist=res.execution.goal_checklist)

        if workflow_type == "invoice-extract":
            from nanoagent.agent.effector.blueprints.invoice_receipt_extractor import (
                InvoiceExtractorConfig,
                run_invoice_extractor,
            )
            res = await run_invoice_extractor(InvoiceExtractorConfig(**config_kwargs), ctx)
            data = {"invoices_count": len(res.invoices_processed), "invoices": res.invoices_processed}
            await offer_to_save_as_skill(ctx.workspace, "invoice-receipt-extractor", config_kwargs.get("portal_url", ""), res.execution)
            return BlueprintResult(type=workflow_type, success=True, data=data, usage=res.execution.usage, goal_checklist=res.execution.goal_checklist)

        if workflow_type == "multi-stage":
            stages = config_kwargs.get("stages") or []
            return await run_multi_stage_workflow(
                ctx, stages,
                max_stage_retries=config_kwargs.get("max_stage_retries", 2),
                stop_on_stage_failure=config_kwargs.get("stop_on_stage_failure", True),
            )

        if workflow_type == "smart-form":
            from nanoagent.agent.effector.capabilities.form_filler import smart_fill_form
            res = await smart_fill_form(
                ctx.page, config_kwargs.get("fields", {}),
                auto_submit=config_kwargs.get("auto_submit", False),
                submit_button_text=config_kwargs.get("submit_button_text"),
            )
            data = {
                "filled_fields": res.filled_fields, "skipped_fields": res.skipped_fields,
                "errors": res.errors, "is_complete": res.is_complete,
            }
            return BlueprintResult(type=workflow_type, success=True, data=data)

        raise ValueError(f"Unknown workflow type: {workflow_type}")

    except Exception as err:
        logger.warning(f"effector blueprint: {workflow_type} failed — {err}")
        return BlueprintResult(type=workflow_type, success=False, data={"error": str(err)})
