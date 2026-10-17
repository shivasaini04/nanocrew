"""The `effector_workflow` tool — runs a named turnkey blueprint end to end.

Phase 3 of the stage43 Effector port. Second of the three tools doc 03 specifies
(`effector`, `effector_workflow`) — kept as its own tool rather
than folded into `effector`, since a blueprint is a complete, pre-scoped workflow
(LinkedIn Easy Apply, B2B lead enrichment, invoice extraction, smart-form fill) with
its own config shape, not an open-ended goal.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.tools.base import Tool

_WORKFLOW_TYPES = ["linkedin-apply", "b2b-lead-enrich", "invoice-extract", "smart-form", "multi-stage"]


class EffectorWorkflowTool(Tool):
    """Run a pre-built turnkey workflow (blueprint) — LinkedIn Easy Apply, B2B lead
    enrichment, invoice/expense extraction, or a smart-form fill — rather than
    describing the task as an open-ended goal for `effector`."""

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
        firewall_protection: bool = True,
        merkle_audit: bool = True,
        autonomous_challenges: bool = True,
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
        self._firewall_protection = firewall_protection
        self._merkle_audit = merkle_audit
        self._autonomous_challenges = autonomous_challenges
        self._tool_registry = tool_registry
        self._tool_persistence = tool_persistence
        self._job_id = job_id
        self._health_monitor = health_monitor
        self._synthesis_provider = synthesis_provider
        self._synthesis_model = synthesis_model

    @property
    def name(self) -> str:
        return "effector_workflow"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess

    @property
    def description(self) -> str:
        return (
            "Run a pre-built turnkey browser workflow (a 'blueprint') rather than "
            "describing an open-ended goal. Use this when the task IS one of the "
            "named workflows below — it's cheaper and more reliable than `effector` "
            "for these specific shapes, since the goal template is already tuned.\n"
            "Workflows:\n"
            "  linkedin-apply  — LinkedIn Easy Apply for jobs matching a query.\n"
            "  b2b-lead-enrich — find and extract B2B decision-maker leads matching an ICP.\n"
            "  invoice-extract — extract structured invoice/expense records from a portal.\n"
            "  smart-form      — fill a form on the CURRENT page by semantic field-name matching "
            "(no navigation, no react_loop — for a single form-fill call).\n"
            "  multi-stage     — run a SEQUENCE of named stages (each its own goal) with "
            "precondition/retry/rollback gates between them, for tasks that touch several "
            "apps/pages in order and where a later stage's failure should NOT be silently "
            "treated as if the earlier stages' work was still safe to build on."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "workflow_type": {"type": "string", "enum": _WORKFLOW_TYPES},
                "session_domain": {"type": "string", "description": "Domain key for session cookie reuse."},
                # linkedin-apply
                "job_query": {"type": "string"},
                "candidate_name": {"type": "string"},
                "candidate_email": {"type": "string"},
                "location": {"type": "string"},
                "resume_path": {"type": "string"},
                "candidate_phone": {"type": "string"},
                "experience_years": {"type": "integer"},
                "max_applications": {"type": "integer"},
                "pause_on_custom_questions": {"type": "boolean"},
                # b2b-lead-enrich
                "icp_title": {"type": "string"},
                "company_size": {"type": "string"},
                "industry": {"type": "string"},
                "max_leads": {"type": "integer"},
                # invoice-extract
                "portal_url": {"type": "string"},
                "target_software": {"type": "string", "enum": ["quickbooks", "xero", "expensify", "generic"]},
                "currency": {"type": "string"},
                # smart-form
                "fields": {"type": "object", "description": "field_name -> value, for smart-form."},
                "auto_submit": {"type": "boolean"},
                "submit_button_text": {"type": "string"},
                # multi-stage
                "stages": {
                    "type": "array",
                    "description": "Ordered stages for multi-stage. Each: {id, name, app, goal, "
                                    "url?, session_domain?, max_turns?}. All stages share ONE "
                                    "browser session/page, run in order; a stage failing stops "
                                    "the sequence (stop_on_stage_failure) and reports which one.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "app": {"type": "string"},
                            "goal": {"type": "string"},
                            "url": {"type": "string"},
                            "session_domain": {"type": "string"},
                            "max_turns": {"type": "integer"},
                        },
                        "required": ["goal"],
                    },
                },
                "max_stage_retries": {"type": "integer", "description": "multi-stage only. Default 2."},
                "stop_on_stage_failure": {"type": "boolean", "description": "multi-stage only. Default true."},
                "verify_goal": {
                    "type": "boolean",
                    "description": "Decompose the workflow's goal into a checklist and verify it "
                                   "against the real page before accepting \"done\". Costs 1-2 extra "
                                   "LLM calls. Default false. Not used by smart-form (no react_loop).",
                },
            },
            "required": ["workflow_type"],
        }

    async def execute(
        self, workflow_type: str, session_domain: str | None = None, verify_goal: bool = False, **kwargs: Any,
    ) -> str:
        import os
        import uuid

        from nanoagent.agent.effector.blueprints.runner import BlueprintContext, run_digital_employee_workflow
        from nanoagent.agent.effector.browser_session import EffectorSession
        from nanoagent.agent.effector.capabilities.tab_manager import TabManager

        if workflow_type not in _WORKFLOW_TYPES:
            return json.dumps({"error": f"Unknown workflow_type: {workflow_type}. Must be one of {_WORKFLOW_TYPES}"})

        agent_id = os.environ.get("AGENT_ID", "unknown")
        run_id = str(uuid.uuid4())
        artifacts_dir = self._workspace / "artifacts"

        try:
            async with EffectorSession(
                self._workspace, session_domain=session_domain,
                stealth=self._stealth, network_shield=self._network_shield,
                # allow_remote=False, stated rather than inherited — and here it is
                # correctness, not just a lane preference. This builds a TabManager from
                # `session.context`, which is None on the user-browser lane (that lane has
                # no Playwright context; the browser is its own tab manager). Left to
                # default, an opted-in run would have sent blueprints down a path that
                # cannot work there.
                allow_remote=False,
            ) as session:
                ctx = BlueprintContext(
                    page=session.page, provider=self._decision_provider, model=self._decision_model,
                    workspace=self._workspace, agent_id=agent_id, run_id=run_id,
                    vision_provider=self._vision_provider or self._provider, vision_model=self._vision_model,
                    use_human_cadence=self._use_human_cadence,
                    tool_registry=self._tool_registry, tool_persistence=self._tool_persistence,
                    job_id=self._job_id, health_monitor=self._health_monitor,
                    synthesis_provider=self._synthesis_provider, synthesis_model=self._synthesis_model,
                    tab_manager=TabManager(session.context, initial_page=session.page),
                    frame_source=lambda: session.last_frame_data_url,
                    verify_goal=verify_goal,
                    download_manager=getattr(session, "downloads", None),
                )
                result = await run_digital_employee_workflow(workflow_type, ctx, artifacts_dir=artifacts_dir, **kwargs)
        except Exception as err:
            logger.warning(f"effector_workflow: {workflow_type} failed — {err}")
            return json.dumps({"error": str(err), "workflow_type": workflow_type})

        return json.dumps({
            "workflow_type": result.type, "success": result.success,
            "run_id": run_id, "data": result.data, "artifact_path": result.artifact_path,
            "usage": result.usage, "goal_checklist": result.goal_checklist,
        }, ensure_ascii=False)
