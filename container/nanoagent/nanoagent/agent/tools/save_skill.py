"""save_skill — write a persistent skill to workspace/skills/ for future sessions."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from nanoagent.agent import skill_ledger, skill_linter, skill_origins
from nanoagent.agent.tools.base import Tool

logger = logging.getLogger(__name__)


class SaveSkillTool(Tool):
    """Write a SKILL.md to workspace/skills/{name}/ so SkillsLoader picks it up in future sessions."""

    def __init__(self, workspace: Path) -> None:
        self._workspace = workspace

    @property
    def required_permission(self) -> "Any":
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "save_skill"

    @property
    def description(self) -> str:
        return (
            "Persist a new skill or update an existing one so it is available in all future sessions. "
            "A skill is a markdown file (SKILL.md) that describes how to perform a task — it can "
            "include instructions, code snippets, API patterns, or domain knowledge. "
            "Use this when you figure out a reusable technique, a working API integration, or a "
            "repeatable process the agent should always remember and apply."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": (
                        "Skill identifier — short, lowercase, hyphen-separated (e.g. 'python-typing', "
                        "'github-api', 'data-cleaning'). Must be unique; overwrites any existing skill "
                        "with the same name."
                    ),
                },
                "content": {
                    "type": "string",
                    "description": (
                        "Full markdown content for the SKILL.md file. Should include: what the skill does, "
                        "when to use it, and any concrete instructions or code examples."
                    ),
                },
                "always_load": {
                    "type": "boolean",
                    "description": (
                        "If true, this skill is injected into every session's system prompt automatically. "
                        "Use only for small, universally-applicable skills. Default: false."
                    ),
                    "default": False,
                },
            },
            "required": ["name", "content"],
        }

    async def execute(
        self,
        name: str,
        content: str,
        always_load: bool = False,
        **kwargs: Any,
    ) -> str:
        # Sanitise name — only alphanumeric + hyphens
        safe_name = re.sub(r"[^a-z0-9\-]", "-", name.strip().lower())
        safe_name = re.sub(r"-+", "-", safe_name).strip("-")
        if not safe_name:
            return "Error: skill name is invalid after sanitisation."

        skill_dir = self._workspace / "skills" / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)

        skill_file = skill_dir / "SKILL.md"

        # Read BEFORE the write: skill_file.exists() is trivially true afterwards, which
        # is why this tool used to report "Updated" for every brand-new skill.
        existed = skill_file.exists()
        previous = self._read_existing(skill_file) if existed else None

        # Prepend frontmatter if always_load requested and not already present
        if always_load and "always: true" not in content[:200]:
            frontmatter = "---\nalways: true\n---\n\n"
            full_content = frontmatter + content
        else:
            full_content = content

        skill_file.write_text(full_content, encoding="utf-8")

        # Provenance (stage 42 #2) — records who wrote this so the curator knows what
        # it may later touch. Best-effort by design: a sidecar failure never fails the
        # save. Origin comes from the ContextVar the tool registry stamps at dispatch.
        skill_origins.record_write(self._workspace, safe_name)

        # Audit + recovery (stage 42 #5). Overwriting is a documented feature of this
        # tool; being unrecoverable was not. Contents are content-addressed, so a
        # rewrite that changes nothing costs no extra storage.
        entry_id = skill_ledger.record(
            self._workspace,
            safe_name,
            action=skill_ledger.UPDATE if existed else skill_ledger.CREATE,
            before=previous,
            after=full_content,
        )

        action = "Updated" if existed else "Created"
        note = ""
        if existed and entry_id:
            note = f" Previous version recoverable — ledger entry {entry_id}."

        # Conventions (stage 42 #6) — advisory, appended after the success message.
        # Never a refusal: the agent has just finished work and is writing down what it
        # learned, and losing that lesson over a house-style nit is the worse outcome.
        advice = skill_linter.summarize(
            skill_linter.lint(full_content, name=safe_name, skill_dir=skill_dir)
        )

        return (
            f"{action} skill '{safe_name}' at {skill_file}. "
            f"It will be available from the next session."
            + (" (always-loaded)" if always_load else "")
            + note
            + advice
        )

    def _read_existing(self, skill_file: Path) -> str | None:
        """Contents about to be overwritten, or ``None`` if unreadable.

        Unreadable is not a reason to refuse the write — losing one recovery copy is
        bad, blocking the agent from recording what it just learned is worse.
        """
        try:
            return skill_file.read_text(encoding="utf-8")
        except OSError as e:
            logger.debug("could not read %s before overwrite: %s", skill_file, e)
            return None

