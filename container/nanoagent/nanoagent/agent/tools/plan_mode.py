"""Plan mode tools: enter_plan_mode / exit_plan_mode.

Ported from claw-code's EnterPlanMode (lib.rs:669) / ExitPlanMode (lib.rs:679).

When plan mode is active the agent is instructed (and the loop enforces) that
only ReadOnly-tier tools may execute.  Write/exec tools return an error banner
instead of running, preventing premature changes while the agent is still
researching.

Usage pattern:
    1. Agent calls enter_plan_mode (optional: with reason="...")
    2. Agent uses read_file / glob_search / grep_search / web tools to research
    3. Agent calls exit_plan_mode (optional: with plan_summary="...")
    4. Agent executes the plan with write/exec tools
"""

from __future__ import annotations

from typing import Any

from nanoagent.agent.tools.base import Tool


class PlanModeState:
    """Shared mutable flag — passed to both tools and the AgentLoop permission check."""

    def __init__(self) -> None:
        self.active: bool = False


class EnterPlanModeTool(Tool):
    """Switch to read-only planning mode before making any changes."""

    def __init__(self, state: PlanModeState) -> None:
        self._state = state

    @property
    def name(self) -> str:
        return "enter_plan_mode"

    @property
    def description(self) -> str:
        return (
            "Switch to planning mode. In plan mode ONLY read-only tools are allowed "
            "(read_file, glob_search, grep_search, web_search, web_fetch). "
            "Write, edit, and exec tools will be blocked until exit_plan_mode is called. "
            "Use this before working on complex tasks to research first, then execute."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why you are entering plan mode (shown in the banner)",
                },
            },
            "required": [],
        }

    async def execute(self, reason: str = "", **kwargs: Any) -> str:
        self._state.active = True
        lines = ["**PLAN MODE ACTIVE**"]
        if reason:
            lines.append(f"Reason: {reason}")
        lines += [
            "",
            "You are now in read-only planning mode.",
            "✓ Allowed:  read_file, glob_search, grep_search, web_search, web_fetch, todo_write",
            "✗ Blocked:  write_file, edit_file, exec, and all destructive tools",
            "",
            "Research the codebase, form your plan, then call exit_plan_mode to begin execution.",
        ]
        return "\n".join(lines)


class ExitPlanModeTool(Tool):
    """Exit planning mode and return to normal execution."""

    def __init__(self, state: PlanModeState) -> None:
        self._state = state

    @property
    def name(self) -> str:
        return "exit_plan_mode"

    @property
    def description(self) -> str:
        return (
            "Exit planning mode and restore full tool access. "
            "Call this once you have a clear plan and are ready to execute it. "
            "Optionally summarise the plan you are about to run."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "plan_summary": {
                    "type": "string",
                    "description": "Brief summary of the plan you are about to execute",
                },
            },
            "required": [],
        }

    async def execute(self, plan_summary: str = "", **kwargs: Any) -> str:
        self._state.active = False
        lines = ["**PLAN MODE ENDED** — full tool access restored."]
        if plan_summary:
            lines += ["", "Plan:", plan_summary]
        lines += ["", "You may now run write_file, edit_file, exec, and other tools."]
        return "\n".join(lines)
