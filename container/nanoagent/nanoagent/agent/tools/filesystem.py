"""File system tools: read, write, edit."""

import difflib
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


# Built-in skill docs (read-only) — agents are told to read these, so reads must be allowed
# even when restricted to their workspace.
_BUILTIN_SKILLS_DIR = (Path(__file__).resolve().parent.parent.parent / "skills")

# An attached git repository, mounted read-write by the cycle runner. Allowed for READS AND
# WRITES, unlike the read-only extras above: the whole point of attaching a repo is that the
# agent edits it.
#
# Safe to key on existence because the mount is opt-in by construction — it appears only when
# an operator has explicitly attached a repo to this agent (config.repoPath). No repo, no
# path, no widening.
#
# Found by watching an agent try to do real work: `read_file`, `list_dir` and `exec` all
# refused /workspace/repo as "outside allowed directory" while `glob_search`, `grep_search`
# and `git` worked on it happily. The agent routed around the inconsistency with python_repl
# and even tried to symlink the repo into its workspace — an inconsistent boundary does not
# contain anything, it just teaches agents to find the gap.
_REPO_MOUNT = Path("/workspace/repo")


def _repo_roots() -> list[Path]:
    try:
        return [_REPO_MOUNT] if _REPO_MOUNT.exists() else []
    except Exception:
        return []


def _resolve_path(
    path: str,
    workspace: Path | None = None,
    allowed_dir: Path | None = None,
    extra_allowed: list[Path] | None = None,
) -> Path:
    """Resolve path against workspace (if relative) and enforce directory restriction.
    `extra_allowed` lists additional roots a read may target (e.g. built-in skill docs)."""
    p = Path(path).expanduser()
    if not p.is_absolute() and workspace:
        p = workspace / p
    resolved = p.resolve()
    if allowed_dir:
        roots = [allowed_dir.resolve()] + [e.resolve() for e in (extra_allowed or [])]
        if not any(_is_within(resolved, r) for r in roots):
            raise PermissionError(f"Path {path} is outside allowed directory {allowed_dir}")
    return resolved


def _is_within(child: Path, root: Path) -> bool:
    try:
        child.relative_to(root)
        return True
    except ValueError:
        return False


class ReadFileTool(Tool):
    """Tool to read file contents."""

    def __init__(self, workspace: Path | None = None, allowed_dir: Path | None = None,
                 extra_read_dirs: list[Path] | None = None):
        self._workspace = workspace
        self._allowed_dir = allowed_dir
        self._extra_read_dirs = list(extra_read_dirs or [])

    @property
    def name(self) -> str:
        return "read_file"
    
    @property
    def description(self) -> str:
        return "Read the contents of a file at the given path."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path to read"
                }
            },
            "required": ["path"]
        }
    
    async def execute(self, path: str, **kwargs: Any) -> str:
        try:
            # Reads may also target built-in skill docs (read-only) and any extra read
            # roots (e.g. the agent's private mount when it's working inside a project).
            file_path = _resolve_path(path, self._workspace, self._allowed_dir, extra_allowed=[_BUILTIN_SKILLS_DIR, *self._extra_read_dirs, *_repo_roots()])
            if not file_path.exists():
                return f"Error: File not found: {path}"
            if not file_path.is_file():
                return f"Error: Not a file: {path}"

            content = file_path.read_text(encoding="utf-8")
            return content
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error reading file: {str(e)}"


class WriteFileTool(Tool):
    """Tool to write content to a file."""

    def __init__(self, workspace: Path | None = None, allowed_dir: Path | None = None):
        self._workspace = workspace
        self._allowed_dir = allowed_dir

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "write_file"
    
    @property
    def description(self) -> str:
        return (
            "Write content to a file at the given path. Creates parent directories if needed. "
            "For large files (> 4000 characters of content), write the first chunk here then "
            "use append_file for subsequent chunks to avoid token limits."
        )
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path to write to"
                },
                "content": {
                    "type": "string",
                    "description": "The content to write"
                }
            },
            "required": ["path", "content"]
        }
    
    async def execute(self, path: str, content: str, **kwargs: Any) -> str:
        try:
            file_path = _resolve_path(path, self._workspace, self._allowed_dir, extra_allowed=_repo_roots())
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content, encoding="utf-8")
            return f"Successfully wrote {len(content)} bytes to {file_path}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error writing file: {str(e)}"


class AppendFileTool(Tool):
    """Tool to append content to an existing file (or create it if it doesn't exist)."""

    def __init__(self, workspace: Path | None = None, allowed_dir: Path | None = None):
        self._workspace = workspace
        self._allowed_dir = allowed_dir

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "append_file"

    @property
    def description(self) -> str:
        return (
            "Append content to a file. Use this to write large files in chunks: "
            "call write_file with the first chunk, then append_file for each subsequent chunk. "
            "This avoids hitting token limits for a single tool call."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path to append to"
                },
                "content": {
                    "type": "string",
                    "description": "The content to append"
                }
            },
            "required": ["path", "content"]
        }

    async def execute(self, path: str, content: str, **kwargs: Any) -> str:
        try:
            file_path = _resolve_path(path, self._workspace, self._allowed_dir, extra_allowed=_repo_roots())
            file_path.parent.mkdir(parents=True, exist_ok=True)
            with file_path.open("a", encoding="utf-8") as f:
                f.write(content)
            total = file_path.stat().st_size
            return f"Appended {len(content)} bytes to {file_path} (total: {total} bytes)"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error appending to file: {str(e)}"


class EditFileTool(Tool):
    """Tool to edit a file by replacing text."""

    def __init__(self, workspace: Path | None = None, allowed_dir: Path | None = None):
        self._workspace = workspace
        self._allowed_dir = allowed_dir

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.WorkspaceWrite

    @property
    def name(self) -> str:
        return "edit_file"
    
    @property
    def description(self) -> str:
        return "Edit a file by replacing old_text with new_text. The old_text must exist exactly in the file."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path to edit"
                },
                "old_text": {
                    "type": "string",
                    "description": "The exact text to find and replace"
                },
                "new_text": {
                    "type": "string",
                    "description": "The text to replace with"
                }
            },
            "required": ["path", "old_text", "new_text"]
        }
    
    async def execute(self, path: str, old_text: str, new_text: str, **kwargs: Any) -> str:
        try:
            file_path = _resolve_path(path, self._workspace, self._allowed_dir, extra_allowed=_repo_roots())
            if not file_path.exists():
                return f"Error: File not found: {path}"

            content = file_path.read_text(encoding="utf-8")

            if old_text not in content:
                return self._not_found_message(old_text, content, path)

            # Count occurrences
            count = content.count(old_text)
            if count > 1:
                return f"Warning: old_text appears {count} times. Please provide more context to make it unique."

            new_content = content.replace(old_text, new_text, 1)
            file_path.write_text(new_content, encoding="utf-8")

            return f"Successfully edited {file_path}"
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error editing file: {str(e)}"

    @staticmethod
    def _not_found_message(old_text: str, content: str, path: str) -> str:
        """Build a helpful error when old_text is not found."""
        lines = content.splitlines(keepends=True)
        old_lines = old_text.splitlines(keepends=True)
        window = len(old_lines)

        best_ratio, best_start = 0.0, 0
        for i in range(max(1, len(lines) - window + 1)):
            ratio = difflib.SequenceMatcher(None, old_lines, lines[i : i + window]).ratio()
            if ratio > best_ratio:
                best_ratio, best_start = ratio, i

        if best_ratio > 0.5:
            diff = "\n".join(difflib.unified_diff(
                old_lines, lines[best_start : best_start + window],
                fromfile="old_text (provided)", tofile=f"{path} (actual, line {best_start + 1})",
                lineterm="",
            ))
            return f"Error: old_text not found in {path}.\nBest match ({best_ratio:.0%} similar) at line {best_start + 1}:\n{diff}"
        return f"Error: old_text not found in {path}. No similar text found. Verify the file content."


class ListDirTool(Tool):
    """Tool to list directory contents."""

    def __init__(self, workspace: Path | None = None, allowed_dir: Path | None = None,
                 extra_read_dirs: list[Path] | None = None):
        self._workspace = workspace
        self._allowed_dir = allowed_dir
        self._extra_read_dirs = list(extra_read_dirs or [])

    @property
    def name(self) -> str:
        return "list_dir"
    
    @property
    def description(self) -> str:
        return "List the contents of a directory."
    
    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The directory path to list"
                }
            },
            "required": ["path"]
        }
    
    async def execute(self, path: str, **kwargs: Any) -> str:
        try:
            dir_path = _resolve_path(path, self._workspace, self._allowed_dir, extra_allowed=[_BUILTIN_SKILLS_DIR, *self._extra_read_dirs, *_repo_roots()])
            if not dir_path.exists():
                return f"Error: Directory not found: {path}"
            if not dir_path.is_dir():
                return f"Error: Not a directory: {path}"

            items = []
            for item in sorted(dir_path.iterdir()):
                prefix = "📁 " if item.is_dir() else "📄 "
                items.append(f"{prefix}{item.name}")

            if not items:
                return f"Directory {path} is empty"

            return "\n".join(items)
        except PermissionError as e:
            return f"Error: {e}"
        except Exception as e:
            return f"Error listing directory: {str(e)}"
