"""curate_skills — let the agent do its own skill housekeeping.

Stage 42 #4, the half that needs judgment. The deterministic half
(``agent/curator.py``) archives by date and needs no model. This is the other half:
deciding that two skills say the same thing, or that one has drifted and should be
rewritten.

Hermes runs that as a forked auxiliary agent with its own prompt and orchestration
(``agent/curator.py``, ~2k lines). We do not need one, for the same reason ``/learn``
needed no distillation engine: **the agent already has the tools and the judgment.**
It can read skills, compare them, and write the merged result. All this tool has to
do is show it what is eligible and give it a safe way to act.

The cycle type never reaches the container as a variable — it arrives as prose in
the prompt ("Run your self improve work cycle now") — so the trigger is the agent
calling this tool during that cycle, not a branch in Python.

Provenance is the subtle part. A merge writes under the **curator** origin rather
than the caller's, so a consolidated skill stays curator-owned and remains eligible
for future curation. Writing it as an ordinary foreground save would make the merged
result user-owned, permanently off-limits, and the skill folder would slowly ossify
into a pile nothing may ever touch again.

Safety comes from what is already built: sources are archived, never deleted, and
every write goes through the ledger, so any merge is one ``skill_ledger.rollback``
away from being undone.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from nanoagent.agent import curator, skill_ledger, skill_origins
from nanoagent.agent.skills import SkillsLoader
from nanoagent.agent.tool_origin import CURATOR
from nanoagent.agent.tools.base import Tool

# Enough context for the agent to judge overlap without pulling whole skills into
# the prompt — it can always read one in full if the descriptions look close.
_DESCRIPTION_PREVIEW = 200


class CurateSkillsTool(Tool):
    """Review, merge and retire the agent's own skills."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace

    @property
    def required_permission(self) -> "Any":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "curate_skills"

    @property
    def description(self) -> str:
        return (
            "Housekeeping for your own skill library. action='review' shows which of your "
            "skills are unused or overlapping; 'archive' retires the ones long unused; "
            "'merge' combines near-duplicates into one; 'restore' brings an archived skill "
            "back. Use during a self-improve cycle. Only skills YOU wrote autonomously are "
            "eligible — anything your manager asked for is off-limits and will not appear. "
            "Nothing is ever deleted: archived skills are recoverable and every change can "
            "be rolled back."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["review", "archive", "merge", "restore"],
                    "description": (
                        "'review' — list eligible skills with their usage and descriptions "
                        "(start here). 'archive' — retire everything past the unused "
                        "threshold. 'merge' — combine `sources` into one skill named `name` "
                        "with `content`. 'restore' — un-archive `name'."
                    ),
                    "default": "review",
                },
                "name": {
                    "type": "string",
                    "description": "Target skill name, for 'merge' and 'restore'.",
                },
                "content": {
                    "type": "string",
                    "description": (
                        "For 'merge': the full SKILL.md of the combined skill. Write it "
                        "properly — keep every distinct instruction from the sources, and "
                        "drop only what is genuinely duplicated."
                    ),
                },
                "sources": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "For 'merge': the skills being combined. They are archived, not "
                        "deleted. Include the target name here if it is one of them."
                    ),
                },
            },
            "required": [],
        }

    async def execute(
        self,
        action: str = "review",
        name: str = "",
        content: str = "",
        sources: list[str] | None = None,
        **kwargs: Any,
    ) -> str:
        if action == "review":
            return self._review()
        if action == "archive":
            result = curator.sweep(self._workspace)
            return json.dumps({
                "archived": result.archived,
                "going_stale": result.stale,
                "note": "Archived skills are recoverable with action='restore'.",
            })
        if action == "merge":
            return self._merge(name, content, sources or [])
        if action == "restore":
            ok, message = curator.restore(self._workspace, name)
            return json.dumps({"ok": ok, "message": message})
        return json.dumps({"error": f"unknown action {action!r}"})

    def _review(self) -> str:
        """What the agent needs to judge overlap, and nothing more."""
        loader = SkillsLoader(self._workspace)
        entries = skill_origins.read_all(self._workspace)
        eligible = []
        for skill in loader.list_skills(filter_unavailable=False):
            skill_name = skill["name"]
            if not skill_origins.is_agent_created_skill(self._workspace, skill_name):
                continue  # the manager's skills are not ours to touch
            entry = entries.get(skill_name, {})
            meta = loader.get_skill_metadata(skill_name) or {}
            eligible.append({
                "name": skill_name,
                "description": str(meta.get("description", ""))[:_DESCRIPTION_PREVIEW],
                "used": entry.get("usage_count", 0),
                "last_used": entry.get("last_used_at"),
                "state": skill_origins.lifecycle_state(entry),
            })

        return json.dumps({
            "eligible": eligible,
            "archived": curator.list_archived(self._workspace),
            "guidance": (
                "Merge two skills only when they cover the same task and you would never "
                "want one without the other. Overlapping-but-distinct skills should stay "
                "separate: a merge that buries a specific instruction inside a general "
                "skill loses it. Skills your manager wrote are not listed and are not "
                "yours to change."
            ),
        }, indent=2)

    def _merge(self, name: str, content: str, sources: list[str]) -> str:
        name = (name or "").strip()
        if not name or not content.strip():
            return json.dumps({"error": "merge needs both `name` and `content`"})

        # Refuse to touch anything not ours, and check BEFORE writing: a partial merge
        # that archived one source and then failed would lose it.
        forbidden = [
            s for s in sources
            if not skill_origins.is_agent_created_skill(self._workspace, s)
        ]
        if forbidden:
            return json.dumps({
                "error": (
                    f"not yours to merge: {', '.join(forbidden)}. Only skills written by "
                    "your own background review are eligible."
                )
            })

        skill_dir = self._workspace / "skills" / name
        skill_file = skill_dir / "SKILL.md"
        previous = skill_file.read_text(encoding="utf-8") if skill_file.exists() else None

        skill_dir.mkdir(parents=True, exist_ok=True)
        skill_file.write_text(content, encoding="utf-8")

        # Written as the curator, not as whoever called the tool: a consolidated skill
        # must stay curator-owned, or it becomes permanently un-curatable and the
        # library ossifies.
        skill_origins.record_write(self._workspace, name, CURATOR)
        entry_id = skill_ledger.record(
            self._workspace, name,
            action=skill_ledger.UPDATE if previous else skill_ledger.CREATE,
            before=previous, after=content, actor=CURATOR,
        )

        archived = [s for s in sources if s != name and curator.archive(self._workspace, s)]
        return json.dumps({
            "merged_into": name,
            "archived": archived,
            "ledger_entry": entry_id,
            "note": "Sources are archived, not deleted. Undo with the ledger entry above.",
        })
