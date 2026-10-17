"""bulletin — read and update the project bulletin board on demand."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


class ReadBulletinTool(Tool):
    """Read the project bulletin board when you need project context."""

    @property
    def name(self) -> str:
        return "read_bulletin"

    @property
    def description(self) -> str:
        return (
            "Read the project bulletin board to get current project state, progress, "
            "and notes from other agents. Only call this when you actually need project "
            "context — not every cycle."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs: Any) -> str:
        # Try nanocrew API first, fall back to direct file read
        try:
            import httpx
            agent_id = os.environ.get("AGENT_ID", "")
            host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
            if agent_id:
                resp = await httpx.AsyncClient().get(
                    f"{host}/api/agents/{agent_id}/bulletin", timeout=10
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return data.get("content") or "(bulletin is empty — agent is not linked to a project)"
        except Exception:
            pass

        # Direct file fallback (works in both project and non-project contexts)
        for candidate in ["/workspace/shared/BULLETIN.md", "/workspace/group/BULLETIN.md"]:
            p = Path(candidate)
            if p.exists():
                return p.read_text(encoding="utf-8")

        return "(no bulletin board found — this agent may not be part of a project)"


class UpdateBulletinTool(Tool):
    """Update a section of the project bulletin board."""

    @property
    def name(self) -> str:
        return "update_bulletin"

    @property
    def description(self) -> str:
        return (
            "Update the project bulletin board with new progress, findings, or status. "
            "The update is merged into the bulletin safely by nanocrew — "
            "do NOT write directly to BULLETIN.md."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "section": {
                    "type": "string",
                    "description": "Section heading to update e.g. 'progress', 'findings', 'next_steps'.",
                },
                "content": {
                    "type": "string",
                    "description": "New content for this section.",
                },
            },
            "required": ["section", "content"],
        }

    async def execute(self, section: str, content: str, **kwargs: Any) -> str:
        try:
            import httpx
        except ImportError:
            return json.dumps({"error": "httpx not installed"})

        agent_id = os.environ.get("AGENT_ID", "")
        host     = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")

        if not agent_id:
            return json.dumps({"error": "AGENT_ID not set"})

        try:
            resp = await httpx.AsyncClient().post(
                f"{host}/api/agents/{agent_id}/bulletin",
                json={"section": section, "content": content},
                timeout=10,
            )
            data = resp.json()
            if resp.status_code >= 400:
                return json.dumps({"error": data.get("error", f"HTTP {resp.status_code}")})
            return json.dumps({"updated": True, "version": data.get("version", 1)})
        except Exception as exc:
            return json.dumps({"error": str(exc)})
