"""usage_report — let the agent see where its own tokens went.

Stage 42 #14's missing half. ``agent/insights.py`` shipped as a well-tested pure
reader that **nothing called** — a module with green tests over code no caller could
reach, which is precisely the failure ``CLAUDE.md`` warns about ("a file existing is
not proof it runs"). This is the caller.

Why the agent and not just a dashboard: the agent is the one deciding how to spend a
cycle. An agent that can see it burned 80% of its budget re-reading the same file, or
that its cache hit rate collapsed, can change what it does next turn. A number only
the founder sees on a page changes nothing until he intervenes.

The cache hit rate is the figure worth surfacing: on DeepSeek off-peak a cached input
token costs ~1/30th of a miss, so it moves real spend by an order of magnitude while
the token count looks identical.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.agent import insights
from nanoagent.agent.tools.base import Tool


class UsageReportTool(Tool):
    """Report this agent's own token usage and tool patterns."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace

    @property
    def name(self) -> str:
        return "usage_report"

    @property
    def description(self) -> str:
        return (
            "See where your own tokens went: how many turns you have taken, input vs "
            "output tokens, what share of your input was served from cache, and which "
            "tools you call most. Useful during a check-in or self-improve cycle, or "
            "when deciding whether an approach is worth repeating — a low cache hit "
            "rate or one tool dominating your calls is usually a sign the approach, "
            "not the budget, is the problem."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "session": {
                    "type": "string",
                    "description": (
                        "Limit to one session id. Omit for every session in this "
                        "workspace, which is usually what you want."
                    ),
                },
            },
            "required": [],
        }

    async def execute(self, session: str = "", **kwargs: Any) -> str:
        report = insights.collect(self._workspace, session=session.strip() or None)
        return report.format()
