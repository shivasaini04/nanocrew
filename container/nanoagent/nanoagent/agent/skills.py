"""Skills loader for agent capabilities."""

import json
import os
import re
import shutil
from pathlib import Path

try:
    import yaml as _yaml
    _YAML_AVAILABLE = True
except ImportError:
    _YAML_AVAILABLE = False

# Default builtin skills directory (relative to this file)
BUILTIN_SKILLS_DIR = Path(__file__).parent.parent / "skills"

# Process-level cache of parsed skill frontmatter, keyed by skill name. Skill metadata is read
# MANY times per turn (relevance scoring + requirement checks + always-skills + summary), and on
# a Docker bind mount each file read is expensive — this turned every chat turn into a ~20s stall.
# The daemon is long-lived & per-agent, so caching by name is safe (built-ins are immutable; a
# newly saved skill is simply a cache miss the first time it's seen).
_MISS = object()
_SKILL_META_CACHE: dict[str, object] = {}


class SkillsLoader:
    """
    Loader for agent skills.
    
    Skills are markdown files (SKILL.md) that teach the agent how to use
    specific tools or perform certain tasks.
    """
    
    def __init__(self, workspace: Path, builtin_skills_dir: Path | None = None):
        self.workspace = workspace
        self.workspace_skills = workspace / "skills"
        self.builtin_skills = builtin_skills_dir or BUILTIN_SKILLS_DIR
    
    def list_skills(self, filter_unavailable: bool = True) -> list[dict[str, str]]:
        """
        List all available skills.
        
        Args:
            filter_unavailable: If True, filter out skills with unmet requirements.
        
        Returns:
            List of skill info dicts with 'name', 'path', 'source'.
        """
        skills = []
        
        # Workspace skills (highest priority)
        if self.workspace_skills.exists():
            for skill_dir in self.workspace_skills.iterdir():
                if skill_dir.is_dir():
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.exists():
                        skills.append({"name": skill_dir.name, "path": str(skill_file), "source": "workspace"})
        
        # Built-in skills
        if self.builtin_skills and self.builtin_skills.exists():
            for skill_dir in self.builtin_skills.iterdir():
                if skill_dir.is_dir():
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.exists() and not any(s["name"] == skill_dir.name for s in skills):
                        skills.append({"name": skill_dir.name, "path": str(skill_file), "source": "builtin"})
        
        # Filter by requirements
        if filter_unavailable:
            return [s for s in skills if self._check_requirements(self._get_skill_meta(s["name"]))]
        return skills
    
    def load_skill(self, name: str) -> str | None:
        """
        Load a skill by name.
        
        Args:
            name: Skill name (directory name).
        
        Returns:
            Skill content or None if not found.
        """
        # Check workspace first
        workspace_skill = self.workspace_skills / name / "SKILL.md"
        if workspace_skill.exists():
            return workspace_skill.read_text(encoding="utf-8")
        
        # Check built-in
        if self.builtin_skills:
            builtin_skill = self.builtin_skills / name / "SKILL.md"
            if builtin_skill.exists():
                return builtin_skill.read_text(encoding="utf-8")
        
        return None
    
    def load_skills_for_context(self, skill_names: list[str]) -> str:
        """
        Load specific skills for inclusion in agent context.
        
        Args:
            skill_names: List of skill names to load.
        
        Returns:
            Formatted skills content.
        """
        parts = []
        used: list[str] = []
        for name in skill_names:
            content = self.load_skill(name)
            if content:
                content = self._strip_frontmatter(content)
                parts.append(f"### Skill: {name}\n\n{content}")
                used.append(name)

        # Stage 42 #3 — this is the only place a skill actually reaches the model, so
        # it is the only honest definition of "used". Counted here rather than in
        # skill_search because a search hit the agent then ignored is not evidence the
        # skill earned its tokens. Batched into one atomic write, and best-effort: the
        # telemetry never gets to break the context build.
        if used:
            from nanoagent.agent import skill_origins

            skill_origins.record_use(self.workspace, used)

        return "\n\n---\n\n".join(parts) if parts else ""
    
    def build_skills_summary(self, compact: bool = False) -> str:
        """
        Build a summary of all skills (name, description, path, availability).

        This is used for progressive loading - the agent can read the full
        skill content using read_file when needed.

        When ``compact`` is True (lazy mode), we DO NOT enumerate every skill in the
        prompt (that scales badly — hundreds of skills would dominate the context).
        Instead we emit a short pointer: the always-on + per-turn-relevant skills are
        already injected elsewhere, and the agent uses the ``skill_search`` tool to find
        the rest on demand. This keeps the system prompt slim regardless of library size.

        Returns:
            XML-formatted skills summary.
        """
        all_skills = self.list_skills(filter_unavailable=False)
        if not all_skills:
            return ""

        if compact:
            return (
                f"<skills total=\"{len(all_skills)}\">\n"
                f"  You have {len(all_skills)} skill playbooks (how-to guides for specific tools and tasks). "
                f"The ones most relevant to each request are surfaced automatically. "
                f"To find others, call the <b>skill_search</b> tool with a task/keyword query, then read "
                f"the returned SKILL.md path with <b>read_file</b> to apply it.\n"
                f"</skills>"
            )

        def escape_xml(s: str) -> str:
            return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        
        lines = ["<skills>"]
        for s in all_skills:
            name = escape_xml(s["name"])
            path = s["path"]
            desc = escape_xml(self._get_skill_description(s["name"]))
            skill_meta = self._get_skill_meta(s["name"])
            available = self._check_requirements(skill_meta)
            
            lines.append(f"  <skill available=\"{str(available).lower()}\">")
            lines.append(f"    <name>{name}</name>")
            lines.append(f"    <description>{desc}</description>")
            lines.append(f"    <location>{path}</location>")
            
            # Show missing requirements for unavailable skills
            if not available:
                missing = self._get_missing_requirements(skill_meta)
                if missing:
                    lines.append(f"    <requires>{escape_xml(missing)}</requires>")
            
            lines.append(f"  </skill>")
        lines.append("</skills>")
        
        return "\n".join(lines)
    
    def _get_missing_requirements(self, skill_meta: dict) -> str:
        """Get a description of missing requirements."""
        missing = []
        requires = skill_meta.get("requires", {})
        for b in requires.get("bins", []):
            if not shutil.which(b):
                missing.append(f"CLI: {b}")
        for env in requires.get("env", []):
            if not os.environ.get(env):
                missing.append(f"ENV: {env}")
        return ", ".join(missing)
    
    def _get_skill_description(self, name: str) -> str:
        """Get the description of a skill from its frontmatter."""
        meta = self.get_skill_metadata(name)
        if meta and meta.get("description"):
            return meta["description"]
        return name  # Fallback to skill name
    
    def _strip_frontmatter(self, content: str) -> str:
        """Remove YAML frontmatter from markdown content."""
        if content.startswith("---"):
            match = re.match(r"^---\n.*?\n---\n", content, re.DOTALL)
            if match:
                return content[match.end():].strip()
        return content
    
    def _parse_nanoagent_metadata(self, raw: str) -> dict:
        """Parse skill metadata JSON from frontmatter (supports nanoagent and openclaw keys)."""
        try:
            data = json.loads(raw)
            return data.get("nanoagent", data.get("openclaw", {})) if isinstance(data, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    
    def _check_requirements(self, skill_meta: dict) -> bool:
        """Check if skill requirements are met (bins, env vars)."""
        requires = skill_meta.get("requires", {})
        for b in requires.get("bins", []):
            if not shutil.which(b):
                return False
        for env in requires.get("env", []):
            if not os.environ.get(env):
                return False
        return True
    
    def _get_skill_meta(self, name: str) -> dict:
        """Get nanoagent metadata for a skill (cached in frontmatter)."""
        meta = self.get_skill_metadata(name) or {}
        return self._parse_nanoagent_metadata(meta.get("metadata", ""))
    
    def get_always_skills(self) -> list[str]:
        """Get skills marked as always=true that meet requirements."""
        result = []
        for s in self.list_skills(filter_unavailable=True):
            meta = self.get_skill_metadata(s["name"]) or {}
            skill_meta = self._parse_nanoagent_metadata(meta.get("metadata", ""))
            if skill_meta.get("always") or meta.get("always"):
                result.append(s["name"])
        return result
    
    def get_skill_metadata(self, name: str) -> dict | None:
        """Cached metadata read (see _SKILL_META_CACHE) — avoids re-reading SKILL.md every turn."""
        cached = _SKILL_META_CACHE.get(name, _MISS)
        if cached is not _MISS:
            return cached  # type: ignore[return-value]
        meta = self._read_skill_metadata(name)
        _SKILL_META_CACHE[name] = meta
        return meta

    def _read_skill_metadata(self, name: str) -> dict | None:
        """Get metadata from a skill's frontmatter using YAML parser with simple fallback."""
        content = self.load_skill(name)
        if not content:
            return None

        if not content.startswith("---"):
            return None

        match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
        if not match:
            return None

        fm_text = match.group(1)

        if _YAML_AVAILABLE:
            try:
                parsed = _yaml.safe_load(fm_text)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass

        # Fallback: simple key: value parser
        metadata: dict = {}
        for line in fm_text.split("\n"):
            if ":" in line:
                key, value = line.split(":", 1)
                metadata[key.strip()] = value.strip().strip("\"'")
        return metadata

    def get_relevant_skills(self, task_query: str, top_k: int = 3) -> list[str]:
        """Return skill names whose description/tags best match the task query.

        Uses simple term-frequency scoring over description + tags — fast,
        zero-dependency, good enough for skill selection.
        """
        if not task_query.strip():
            return []

        query_terms = set(re.findall(r"[a-z0-9]+", task_query.lower()))
        # common stop words to ignore
        stop = {"the", "a", "an", "is", "in", "to", "of", "and", "or", "for",
                "with", "this", "that", "i", "you", "we", "it", "be", "on"}
        query_terms -= stop
        if not query_terms:
            return []

        scored: list[tuple[float, str]] = []
        for skill in self.list_skills(filter_unavailable=True):
            name = skill["name"]
            meta = self.get_skill_metadata(name) or {}

            # Build searchable text: description + tags + name
            text_parts = [
                str(meta.get("description", "")),
                name.replace("-", " "),
            ]
            tags = meta.get("tags", [])
            if isinstance(tags, list):
                text_parts.extend(str(t) for t in tags)
            elif isinstance(tags, str):
                text_parts.append(tags)

            text = " ".join(text_parts).lower()
            terms_in_text = set(re.findall(r"[a-z0-9]+", text))

            # Score = fraction of query terms that hit (exact or prefix match)
            hits = 0
            for qt in query_terms:
                if qt in terms_in_text:
                    hits += 1
                elif any(tt.startswith(qt) or qt.startswith(tt) for tt in terms_in_text if len(tt) >= 4):
                    hits += 0.6  # partial credit for prefix matches
            if hits > 0:
                score = hits / len(query_terms)
                # Boost if query term appears in skill name
                name_terms = set(re.findall(r"[a-z0-9]+", name))
                if query_terms & name_terms:
                    score += 0.3
                scored.append((score, name))

        scored.sort(reverse=True)
        return [name for _, name in scored[:top_k]]
