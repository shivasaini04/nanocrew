"""The `learn_from_recording` tool — turns a human-recorded Playwright codegen
script into domain-memory notes future Effector runs on that domain will see.

God-level pillar 03 — see effector/recording.py's module
docstring for why this reads an uploaded script rather than watching a live human
session (the container's browser has no human-visible display).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


class LearnFromRecordingTool(Tool):
    """Parse a human-recorded Playwright codegen script (a workspace file) and save
    its action sequence as domain-memory notes, so future `effector` runs against
    that domain start from a demonstrated working path instead of discovering it
    turn by turn."""

    def __init__(self, workspace: Path):
        self._workspace = Path(workspace)

    @property
    def name(self) -> str:
        return "learn_from_recording"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def description(self) -> str:
        return (
            "Learn from a human-recorded browser session. The human records a task "
            "ONCE on their own machine with Playwright's standard `codegen` tool "
            "(`playwright codegen <url> -o recording.py`) and puts the resulting "
            "script in the workspace; this tool parses it (a static read of the "
            "click/fill/select/navigate calls — no code execution) and saves the "
            "sequence as domain-memory notes, so future `effector` runs against "
            "that domain start from a demonstrated working path instead of "
            "discovering it turn by turn. Use once per domain after a human "
            "provides a recording, not as a substitute for `effector` itself."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "Path to the recorded .py codegen script, relative to the "
                                    "workspace or absolute.",
                },
                "domain": {
                    "type": "string",
                    "description": "Domain these notes apply to, e.g. 'demoqa.com' — must match "
                                    "the session_domain effector runs against that site will use.",
                },
            },
            "required": ["file_path", "domain"],
        }

    async def execute(self, file_path: str, domain: str, **kwargs: Any) -> str:
        from nanoagent.agent.effector.domain_memory import append_domain_note
        from nanoagent.agent.effector.recording import parse_codegen_script, summarize_for_domain_memory

        path = Path(file_path)
        if not path.is_absolute():
            path = self._workspace / path

        try:
            source = path.read_text(encoding="utf-8")
        except OSError as err:
            return json.dumps({"success": False, "error": f"Could not read {file_path}: {err}"})

        steps = parse_codegen_script(source)
        if not steps:
            return json.dumps({
                "success": False,
                "error": "No recognizable browser actions found in the recording — expected a "
                         "Playwright codegen-style script (page.click/fill/select_option/goto calls).",
            })

        notes = summarize_for_domain_memory(steps)
        for note in notes:
            append_domain_note(self._workspace, domain, note)

        return json.dumps({
            "success": True, "domain": domain, "steps_parsed": len(steps), "notes_saved": len(notes),
        }, ensure_ascii=False)
