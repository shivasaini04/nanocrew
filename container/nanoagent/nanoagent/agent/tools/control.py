"""Control-flow tools: sleep.

Ported from claw-code's Sleep (lib.rs:619).
Essential for long-running job patterns: start a background process with exec,
sleep until it should be done, then check the output.
"""

from __future__ import annotations

import asyncio
from typing import Any

from nanoagent.agent.tools.base import Tool

_MAX_SLEEP_SECONDS = 300  # 5-minute hard cap


class SleepTool(Tool):
    """Park the agent for N seconds — ideal for waiting on builds, deploys, or test runs."""

    @property
    def name(self) -> str:
        return "sleep"

    @property
    def description(self) -> str:
        return (
            "Pause execution for N seconds (max 300). "
            "Use this to wait for a background process — build, deploy, migration, test run — "
            "to complete before reading its output. "
            "Pattern: exec('npm run build &'), sleep(60), exec('cat build.log')."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "seconds": {
                    "type": "number",
                    "description": "Seconds to sleep. Max 300 (5 minutes).",
                    "minimum": 1,
                    "maximum": 300,
                },
                "reason": {
                    "type": "string",
                    "description": "Optional: what you are waiting for (shown in progress output)",
                },
            },
            "required": ["seconds"],
        }

    async def execute(self, seconds: float, reason: str = "", **kwargs: Any) -> str:
        duration = min(float(seconds), _MAX_SLEEP_SECONDS)
        if reason:
            progress = f"Sleeping {duration:.0f}s — waiting for: {reason}"
        else:
            progress = f"Sleeping {duration:.0f}s..."
        # Yield immediately so callers can display the progress message,
        # then actually sleep.
        await asyncio.sleep(0)
        await asyncio.sleep(duration)
        return f"Done. Slept {duration:.0f}s" + (f" ({reason})" if reason else "") + "."
