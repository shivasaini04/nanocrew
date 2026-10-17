"""What a stage 57 worker may use — applied by the adapter, kept here so it can be tested.

A worker is recognised by `reportSchema` in its payload (src/swarm/worker.ts always sends
the key, null when the task has no schema). Only then does `allowedTools` restrict
anything: an ordinary cycle keeps its whole registry, and a stale orchestrator still
sending the pre-2026-09-14 `allowedTools` field alone must not bring that allowlist back.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.agent.tools.registry import ToolRegistry


def is_worker(payload: dict[str, Any]) -> bool:
    return "reportSchema" in payload


def apply_worker_policy(registry: ToolRegistry, payload: dict[str, Any], result_path: Path) -> list[str]:
    """Register report_result and cut the registry to the allowlist. Returns what was removed.

    An allowlist rather than a denylist: withheldTools only subtracts known dangerous
    groups, so a tool added to the runtime later would reach every worker unless someone
    also added it there. Anything not named is unregistered — not withdrawn, so nothing
    can lend it back. Every allowed tool is advertised: a worker has no tool_search.
    """
    if not is_worker(payload):
        return []
    from nanoagent.agent.tools.report_result import ReportResultTool

    registry.register(ReportResultTool(result_path, payload.get("reportSchema")))
    allowed = payload.get("allowedTools")
    if not isinstance(allowed, list):
        return []
    keep = {str(t) for t in allowed}
    dropped = [n for n in registry.tool_names if n not in keep]
    for name in dropped:
        registry.unregister(name)
    registry.activate(sorted(keep))
    return dropped


REPORT_NUDGE = (
    "[System: You are a worker, and your task ends only when you call report_result — you "
    "stopped without calling it, so nothing you did counts yet. If the work is done, call "
    "report_result now. If it is not, finish it, then call report_result. If you cannot "
    "finish, call report_result with what you have and say in the summary what is missing.]"
)


def report_stop_check(result_path: Path):
    """For AgentLoop.stop_check: a worker that stops before report_result is asked once to call it.

    Found live 2026-09-29: a racer spent ten minutes
    reading node-semver's source, ended its turn with a plan, never wrote the file or called
    report_result — and the attempt was simply lost, at full cost.
    """
    return lambda: None if result_path.exists() else REPORT_NUDGE
