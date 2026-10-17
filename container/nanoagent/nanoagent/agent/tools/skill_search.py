"""skill_search — find relevant skill playbooks on demand (lazy skills).

With many built-in skills, listing them all in the system prompt is wasteful. Instead the
prompt carries a short pointer and the agent calls this tool to locate the right SKILL.md
for its task, then reads it with read_file. Scoring reuses SkillsLoader.get_relevant_skills.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.skills import SkillsLoader


class SkillSearchTool(Tool):
    """Search the agent's skill library (built-in + workspace) by task/keywords."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace

    @property
    def name(self) -> str:
        return "skill_search"

    @property
    def description(self) -> str:
        return (
            "Search your skill library (how-to playbooks for specific tools and tasks) by a "
            "task description or keywords. Returns the best-matching skills with their SKILL.md "
            "path — read that path with read_file to apply the skill. Use this when a request "
            "needs domain know-how you don't already have loaded."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Task or keywords to match against skill names/descriptions, e.g. 'make a diagram', 'arxiv papers', 'notion'.",
                },
                "top_k": {
                    "type": "integer",
                    "description": "Max results to return (default 6, max 15).",
                    "default": 6,
                },
            },
            "required": ["query"],
        }

    async def execute(self, query: str = "", top_k: int = 6, **kwargs: Any) -> str:
        query = (query or "").strip()
        if not query:
            return "Error: 'query' is required."
        top_k = max(1, min(int(top_k or 6), 15))

        loader = SkillsLoader(self._workspace)
        # name/path index across both sources (workspace overrides builtin)
        index = {s["name"]: s for s in loader.list_skills(filter_unavailable=False)}

        names = loader.get_relevant_skills(query, top_k=top_k)
        # Fallback: substring match on the raw name when the TF scorer finds nothing.
        if not names:
            ql = query.lower()
            names = [n for n in index if ql in n.lower().replace("-", " ")][:top_k]
        if not names:
            return f"No skills matched '{query}'. Try broader keywords, or list_dir the skills directory."

        lines = [f"Found {len(names)} skill(s) for '{query}':", ""]
        for n in names:
            info = index.get(n)
            if not info:
                continue
            desc = loader._get_skill_description(n)
            lines.append(f"• {n} — {desc}")
            lines.append(f"  read_file: {info['path']}")
        lines.append("")
        lines.append("Read the SKILL.md path of the one you need, then follow it.")
        return "\n".join(lines)
