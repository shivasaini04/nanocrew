"""Structural and convention checks for SKILL.md — advisory, never blocking.

Stage 42 #6, following Hermes Agent's ``tools/skill_linter.py``
(NousResearch/hermes-agent @ a7cd15e), which splits hard validation from soft
convention on purpose:

* ``save_skill`` owns the **blockers** — a name that sanitises to nothing is
  rejected outright.
* This module owns the **conventions** — the things a careful reviewer would catch
  and nothing currently does.

Findings are advisory by default. ``lint`` returns a list; the caller decides what
to do with it, and ``save_skill`` surfaces them as guidance rather than a refusal.
The reasoning is the same as Hermes': the agent has just finished a piece of work
and is trying to write down what it learned. Refusing that write over a house-style
nit loses the lesson, which is a far worse outcome than a slightly scruffy skill.

Why it matters here specifically: ``SkillsLoader.get_relevant_skills`` scores on the
description, so a vague or missing one directly degrades retrieval. A skill nobody
can find is a skill that will go stale and be archived by the curator — the linter
is what stops that happening for an avoidable reason.

Pure functions, no I/O beyond reading what it is pointed at, so a test, the
create-path and a human all run the same implementation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# The prompt budget: descriptions are what the model reads when choosing a skill,
# and every one of them is in context during relevance scoring.
MAX_DESCRIPTION_CHARS = 220
MIN_DESCRIPTION_CHARS = 20

# Words that describe how good a skill is rather than when to use it. They cost
# retrieval quality because they match every query weakly and none of them well.
MARKETING_WORDS = (
    "powerful", "comprehensive", "seamless", "robust", "cutting-edge", "world-class",
    "advanced", "ultimate", "revolutionary", "best-in-class", "state-of-the-art",
)

_FRONTMATTER = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
_REFERENCE_LINK = re.compile(r"\[[^\]]*\]\((references/[^)]+)\)")


@dataclass(frozen=True)
class LintFinding:
    """One convention issue. ``severity`` is advice to the caller, not enforcement."""

    severity: str  # "warn" | "info"
    code: str
    message: str

    def __str__(self) -> str:
        return f"[{self.severity}] {self.code}: {self.message}"


def lint(content: str, *, name: str | None = None, skill_dir: Path | None = None) -> list[LintFinding]:
    """Check one SKILL.md. Returns findings, worst first. Never raises."""
    findings: list[LintFinding] = []
    try:
        frontmatter = _parse_frontmatter(content)
        body = _FRONTMATTER.sub("", content, count=1).strip()

        findings += _check_description(frontmatter)
        findings += _check_name(frontmatter, name)
        findings += _check_body(body)
        findings += _check_references(body, skill_dir)
    except Exception:  # noqa: BLE001 — a linter that breaks a save is worse than no linter
        return findings
    return sorted(findings, key=lambda f: 0 if f.severity == "warn" else 1)


def summarize(findings: list[LintFinding], limit: int = 3) -> str:
    """One-line advisory for the tool result, or "" when there is nothing to say."""
    if not findings:
        return ""
    shown = "; ".join(f.message for f in findings[:limit])
    more = f" (+{len(findings) - limit} more)" if len(findings) > limit else ""
    return f" Note: {shown}{more}"


def _parse_frontmatter(content: str) -> dict[str, str]:
    match = _FRONTMATTER.match(content.lstrip())
    if not match:
        return {}
    out: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" in line and not line.startswith((" ", "\t", "-")):
            key, value = line.split(":", 1)
            out[key.strip()] = value.strip().strip("\"'")
    return out


def _check_description(frontmatter: dict[str, str]) -> list[LintFinding]:
    description = frontmatter.get("description", "").strip()
    if not description:
        return [LintFinding(
            "warn", "no-description",
            "no description in frontmatter — relevance scoring reads it, so the skill "
            "will rarely be retrieved",
        )]

    out: list[LintFinding] = []
    if len(description) < MIN_DESCRIPTION_CHARS:
        out.append(LintFinding(
            "warn", "thin-description",
            f"description is only {len(description)} chars — say when to use this, not "
            "just what it is",
        ))
    if len(description) > MAX_DESCRIPTION_CHARS:
        out.append(LintFinding(
            "info", "long-description",
            f"description is {len(description)} chars; every skill's description sits in "
            f"context during scoring, so keep it under {MAX_DESCRIPTION_CHARS}",
        ))
    found = [w for w in MARKETING_WORDS if w in description.lower()]
    if found:
        out.append(LintFinding(
            "info", "marketing-language",
            f"description uses {', '.join(found)} — describe when to use the skill "
            "instead; vague praise matches every query weakly and none of them well",
        ))
    return out


def _check_name(frontmatter: dict[str, str], name: str | None) -> list[LintFinding]:
    declared = frontmatter.get("name", "").strip()
    if name and declared and declared != name:
        return [LintFinding(
            "warn", "name-mismatch",
            f"frontmatter name {declared!r} does not match the directory {name!r}; the "
            "loader keys on the directory, so the frontmatter name is what will be wrong",
        )]
    if name and not declared:
        return [LintFinding("info", "no-name", "no name in frontmatter")]
    return []


def _check_body(body: str) -> list[LintFinding]:
    if not body:
        return [LintFinding("warn", "empty-body", "skill has frontmatter but no content")]
    if len(body) < 80:
        return [LintFinding(
            "info", "thin-body",
            "body is very short — a skill worth loading should carry the actual steps",
        )]
    return []


def _check_references(body: str, skill_dir: Path | None) -> list[LintFinding]:
    """Dangling references/ links: the classic rot in a knowledge-base skill."""
    if skill_dir is None:
        return []
    missing = [
        target for target in _REFERENCE_LINK.findall(body)
        if not (skill_dir / target).exists()
    ]
    if not missing:
        return []
    return [LintFinding(
        "warn", "dangling-reference",
        f"links to missing file(s): {', '.join(sorted(set(missing))[:3])}",
    )]
