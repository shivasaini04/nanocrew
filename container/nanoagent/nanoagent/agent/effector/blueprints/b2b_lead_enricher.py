"""Ported from computer-use/blueprints/b2b-lead-enricher.ts. Turnkey B2B lead
discovery and enrichment blueprint."""

from __future__ import annotations

from dataclasses import dataclass, field

from nanoagent.agent.effector.blueprints.runner import BlueprintContext, _run_goal
from nanoagent.agent.effector.types import EffectorExecutionResult


@dataclass
class LeadEnricherConfig:
    icp_title: str
    company_size: str | None = None
    industry: str | None = None
    max_leads: int = 10


@dataclass
class LeadRecord:
    name: str | None = None
    title: str | None = None
    company: str | None = None
    email: str | None = None
    linkedin_url: str | None = None


@dataclass
class LeadEnricherResult:
    leads_extracted: list[dict] = field(default_factory=list)
    execution: EffectorExecutionResult | None = None


async def run_b2b_lead_enricher(config: LeadEnricherConfig, ctx: BlueprintContext) -> LeadEnricherResult:
    size_clause = f', Company Size="{config.company_size}"' if config.company_size else ""
    industry_clause = f', Industry="{config.industry}"' if config.industry else ""

    goal = (
        f'Find and extract verified B2B leads matching ICP: Title="{config.icp_title}"{size_clause}{industry_clause}.\n'
        f"1. Search and list decision makers.\n"
        f"2. For each profile, extract full name, job title, company name, and work email if visible.\n"
        f"3. Collect up to {config.max_leads} leads into structured records."
    )

    execution = await _run_goal(ctx, goal, url=None, session_domain=None, max_turns=15)

    leads = (execution.extracted_data or {}).get("leads") or []
    return LeadEnricherResult(leads_extracted=leads, execution=execution)
