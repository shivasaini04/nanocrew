"""File-system search tools: glob_search and grep_search.

Ported from claw-code's glob_search (lib.rs:453) and grep_search (lib.rs:467).
Pure-Python implementation — no shell out, no regex injection risk.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool

_SKIP_DIRS = frozenset({
    ".git", "__pycache__", "node_modules", ".venv", "venv", ".tox",
    "dist", "build", ".next", ".nuxt", ".mypy_cache", ".ruff_cache",
    "target", ".cargo",
})


class GlobSearchTool(Tool):
    """Pattern-based file search, skipping common noise directories."""

    def __init__(self, workspace: Path | None = None):
        self._workspace = workspace

    @property
    def name(self) -> str:
        return "glob_search"

    @property
    def description(self) -> str:
        return (
            "Find files by glob pattern (e.g. '**/*.py', 'src/**/*.ts'). "
            "Skips .git, __pycache__, node_modules, .venv, dist, build. "
            "Returns paths relative to the search root, sorted by modification time (newest first). "
            "Use this instead of exec+find for file discovery."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern, e.g. '**/*.py' or 'src/**/*.ts'",
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in. Defaults to workspace root.",
                },
            },
            "required": ["pattern"],
        }

    async def execute(self, pattern: str, path: str = "", **kwargs: Any) -> str:
        base = self._resolve_base(path)
        try:
            matches: list[Path] = []
            for m in base.glob(pattern):
                if not m.is_file():
                    continue
                rel_parts = m.relative_to(base).parts
                # Skip if any parent component is a known noise dir
                if any(p in _SKIP_DIRS for p in rel_parts[:-1]):
                    continue
                matches.append(m)

            if not matches:
                return f"No files found matching '{pattern}' in {base}"

            matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            lines = [str(m.relative_to(base)) for m in matches]
            return f"{len(lines)} file(s) matching '{pattern}':\n" + "\n".join(lines)
        except Exception as e:
            return f"Error: {e}"

    def _resolve_base(self, path: str) -> Path:
        if path:
            p = Path(path)
            if not p.is_absolute() and self._workspace:
                p = self._workspace / p
            return p
        return self._workspace or Path.cwd()


class GrepSearchTool(Tool):
    """Regex content search across files — ripgrep-style output modes."""

    def __init__(self, workspace: Path | None = None):
        self._workspace = workspace

    @property
    def name(self) -> str:
        return "grep_search"

    @property
    def description(self) -> str:
        return (
            "Search file contents for a regex pattern. "
            "output_mode: 'files_with_matches' (default) | 'content' (matching lines with context) | 'count'. "
            "Supports glob file filter, case-insensitive flag, context lines (-C), and head_limit. "
            "Use this instead of exec+grep for structured, injection-safe search."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for",
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file to search in. Defaults to workspace root.",
                },
                "glob": {
                    "type": "string",
                    "description": "File glob filter, e.g. '*.py' or '**/*.{ts,tsx}'",
                },
                "output_mode": {
                    "type": "string",
                    "enum": ["files_with_matches", "content", "count"],
                    "description": "Output format. Default: files_with_matches",
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Case-insensitive search. Default: false",
                },
                "context": {
                    "type": "integer",
                    "description": "Lines of context before and after each match (like -C). Default: 0",
                    "minimum": 0,
                    "maximum": 10,
                },
                "head_limit": {
                    "type": "integer",
                    "description": "Limit output to first N results. Default: 250",
                    "minimum": 1,
                    "maximum": 1000,
                },
            },
            "required": ["pattern"],
        }

    async def execute(
        self,
        pattern: str,
        path: str = "",
        glob: str = "",
        output_mode: str = "files_with_matches",
        case_insensitive: bool = False,
        context: int = 0,
        head_limit: int = 250,
        **kwargs: Any,
    ) -> str:
        base = self._resolve_base(path)
        flags = re.IGNORECASE if case_insensitive else 0
        try:
            rx = re.compile(pattern, flags)
        except re.error as e:
            return f"Invalid regex '{pattern}': {e}"

        files = self._collect_files(base, glob)
        if not files:
            return f"No files to search in {base}"

        matched_files: list[str] = []
        content_lines: list[str] = []
        count_pairs: list[tuple[str, int]] = []

        for f in sorted(files):
            try:
                text = f.read_text(encoding="utf-8", errors="replace")
            except Exception:
                continue

            file_lines = text.splitlines()
            hit_indices = [i for i, ln in enumerate(file_lines) if rx.search(ln)]
            if not hit_indices:
                continue

            rel = str(f.relative_to(base)) if base.is_dir() else f.name
            matched_files.append(rel)
            count_pairs.append((rel, len(hit_indices)))

            if output_mode == "content":
                seen: set[int] = set()
                for mi in hit_indices:
                    start = max(0, mi - context)
                    end = min(len(file_lines), mi + context + 1)
                    for li in range(start, end):
                        if li not in seen:
                            seen.add(li)
                            marker = ">" if li == mi else " "
                            content_lines.append(f"{rel}:{li + 1}{marker} {file_lines[li]}")

        if not matched_files:
            return f"No matches for '{pattern}'"

        if output_mode == "files_with_matches":
            out = matched_files[:head_limit]
            suffix = (
                f"\n(showing {len(out)} of {len(matched_files)} files)"
                if len(matched_files) > head_limit else ""
            )
            return f"{len(matched_files)} file(s) match '{pattern}':\n" + "\n".join(out) + suffix

        if output_mode == "count":
            total = sum(c for _, c in count_pairs)
            rows = [f"{f}: {c}" for f, c in count_pairs[:head_limit]]
            suffix = (
                f"\n(showing {len(rows)} of {len(count_pairs)} files)"
                if len(count_pairs) > head_limit else ""
            )
            return f"Total: {total} match(es) in {len(count_pairs)} file(s)\n" + "\n".join(rows) + suffix

        # content mode
        out = content_lines[:head_limit]
        suffix = (
            f"\n(showing {len(out)} of {len(content_lines)} lines)"
            if len(content_lines) > head_limit else ""
        )
        return "\n".join(out) + suffix

    def _resolve_base(self, path: str) -> Path:
        if path:
            p = Path(path)
            if not p.is_absolute() and self._workspace:
                p = self._workspace / p
            return p
        return self._workspace or Path.cwd()

    def _collect_files(self, base: Path, glob: str) -> list[Path]:
        if base.is_file():
            return [base]
        g = glob or "**/*"
        result = []
        for f in base.glob(g):
            if not f.is_file():
                continue
            rel_parts = f.relative_to(base).parts
            if any(p in _SKIP_DIRS for p in rel_parts[:-1]):
                continue
            result.append(f)
        return result
