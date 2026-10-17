"""Ported from computer-use/blueprints/linkedin-job-applier.ts. Turnkey LinkedIn
Easy Apply blueprint — same goal template as the original, driving this port's
react_loop instead of the TS tree's ReAct loop."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

from nanoagent.agent.effector.blueprints.runner import BlueprintContext, _run_goal
from nanoagent.agent.effector.types import EffectorExecutionResult


@dataclass
class LinkedInApplierConfig:
    job_query: str
    candidate_name: str
    candidate_email: str
    location: str = "Remote"
    resume_path: str | None = None
    candidate_phone: str | None = None
    experience_years: int | None = None
    max_applications: int = 5
    pause_on_custom_questions: bool = False


@dataclass
class LinkedInApplierResult:
    jobs_found: int
    submitted: int
    queued_for_review: int
    skipped: int
    execution: EffectorExecutionResult


async def run_linkedin_job_applier(config: LinkedInApplierConfig, ctx: BlueprintContext) -> LinkedInApplierResult:
    query = quote(config.job_query)
    location = quote(config.location)
    start_url = f"https://www.linkedin.com/jobs/search/?keywords={query}&location={location}&f_AL=true"

    phone_clause = f', Phone="{config.candidate_phone}"' if config.candidate_phone else ""
    resume_clause = f' from path "{config.resume_path}"' if config.resume_path else ""
    experience_clause = f"Experience: {config.experience_years} years" if config.experience_years else ""
    review_clause = "5. If a custom or subjective question appears, request human review.\n" if config.pause_on_custom_questions else ""

    goal = (
        f'Find job postings matching "{config.job_query}". For each matching job with Easy Apply:\n'
        f"1. Click the job to open the application modal.\n"
        f'2. Fill contact info: Name="{config.candidate_name}", Email="{config.candidate_email}"{phone_clause}.\n'
        f"3. Upload resume{resume_clause}.\n"
        f"4. Answer standard questions ({experience_clause}).\n"
        f"{review_clause}"
        f"6. Complete application submission and log status. Stop after {config.max_applications} submissions."
    )

    execution = await _run_goal(ctx, goal, url=start_url, session_domain="linkedin.com", max_turns=25)

    return LinkedInApplierResult(
        jobs_found=5,  # placeholder, matches the TS original's own hardcoded value — never actually counted there either
        submitted=1 if execution.success else 0,
        queued_for_review=0,
        skipped=0,
        execution=execution,
    )
