"""emit_artifact — register a file as a typed output artifact."""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


class EmitArtifactTool(Tool):
    """Register a produced file as a structured artifact visible in the dashboard."""

    @property
    def name(self) -> str:
        return "emit_artifact"

    @property
    def description(self) -> str:
        return (
            "Register a file you produced as a named artifact so it appears in your owner's "
            "Artifacts tab. Call this after writing any final deliverable: reports, charts, "
            "datasets, videos, generated code — or an interactive page. When asked to make an "
            "artifact, a page, a form, a checklist, a tracker or a small tool, this is the tool. "
            "Do NOT call it for temporary or intermediate files.\n\n"
            "Interactive pages (type 'page'): write ONE self-contained .html file (inline <style> "
            "and <script>, nothing loaded from other sites), then register it here. When your "
            "owner opens it, it can remember what they do on it across reloads through "
            "`window.NanoCrewPage`, available as soon as your script runs:\n"
            "  await NanoCrewPage.setDoc(id, value)  — save any JSON value under a string id\n"
            "  await NanoCrewPage.getDoc(id)         — the saved value, or null\n"
            "  await NanoCrewPage.listDocs()         — every saved doc as [{id, data}]\n"
            "  await NanoCrewPage.deleteDoc(id)\n"
            "Use one id per item (e.g. per checklist row). Render the page first, then restore "
            "saved state onto it, so it still works if storage is unavailable. Nothing else "
            "persists: localStorage and cookies do not exist inside the page."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "description": (
                        "Path relative to /workspace/group/ "
                        "(e.g. 'workspace/report.md' or 'workspace/output/chart.png')"
                    ),
                },
                "type": {
                    "type": "string",
                    "enum": ["page", "report", "dataset", "chart", "video", "code", "pdf", "file"],
                    "description": (
                        "Type of artifact — controls how the dashboard renders it. "
                        "'page' is an interactive HTML page."
                    ),
                },
                "title": {
                    "type": "string",
                    "description": "Short human-readable title shown in the dashboard.",
                },
                "description": {
                    "type": "string",
                    "description": "1-2 sentences describing what this file contains (optional).",
                },
            },
            "required": ["file", "type", "title"],
        }

    async def execute(
        self,
        file: str,
        type: str,
        title: str,
        description: str = "",
        **kwargs: Any,
    ) -> str:
        manifest_path = Path("/workspace/group/workspace/artifacts.json")
        manifest_path.parent.mkdir(parents=True, exist_ok=True)

        # The manifest must hold a path relative to /workspace/group — that is what the
        # orchestrator joins onto the agent's folder to serve it. Models reach for the
        # absolute path they just wrote to, and an absolute one stored here resolves to
        # nothing on the other side: the artifact is listed but never opens.
        if file.startswith("/workspace/group/"):
            file = file[len("/workspace/group/"):]
        file = file.lstrip("/")

        # Resolve full path for size check
        full_path = Path("/workspace/group") / file
        size = 0
        if full_path.exists():
            size = full_path.stat().st_size
        else:
            return json.dumps({"error": f"File not found: {file}"})

        record: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "type": type,
            "title": title,
            "file": file,
            "description": description,
            "size": size,
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "cycleId": os.environ.get("CYCLE_ID", "unknown"),
        }

        existing: dict[str, Any] = {"artifacts": []}
        if manifest_path.exists():
            try:
                existing = json.loads(manifest_path.read_text())
            except Exception:
                existing = {"artifacts": []}

        existing["artifacts"].append(record)
        manifest_path.write_text(json.dumps(existing, indent=2))

        return json.dumps({"registered": record["id"], "title": title, "file": file})
