"""Meta-tools for managing dynamic tools at runtime."""

import asyncio
import json
from typing import Any, Optional
from loguru import logger

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.dynamic.manifest import ToolManifest, TestCase, classify_tier
from nanoagent.agent.tools.dynamic.tool import DynamicTool
from nanoagent.agent.tools.dynamic.manager import DynamicToolManager
from nanoagent.agent.tools.dynamic.events import ToolEventEmitter
from nanoagent.agent.tools.dynamic.patterns import PatternStore
from pathlib import Path


def _dedup_check(registry: Any, name: str, description: str) -> str | None:
    """Return a steering message if a same-name or near-twin tool already exists, else None.

    Exact name match → always steer to update_tool (re-creating silently overwrites).
    Description word-overlap ≥ 0.6 Jaccard → nudge toward update_tool; the agent can
    proceed by providing a clearly distinct description on a second call.
    """
    existing = registry.get_dynamic_tools() if hasattr(registry, "get_dynamic_tools") else []

    # 1. Exact name — already exists as a dynamic tool.
    for t in existing:
        if t.name == name:
            desc_snippet = (getattr(t, "description", "") or "")[:100]
            return (
                f"Tool '{name}' already exists: \"{desc_snippet}\". "
                f"Use update_tool to modify it instead of re-creating it."
            )

    # 2. Near-twin: Jaccard similarity on description word tokens.
    def _tok(s: str) -> set:
        return {w for w in s.lower().split() if len(w) > 2}

    new_tok = _tok(description)
    if not new_tok:
        return None

    for t in existing:
        ex_tok = _tok(getattr(t, "description", "") or "")
        if not ex_tok:
            continue
        union = new_tok | ex_tok
        if not union:
            continue
        jaccard = len(new_tok & ex_tok) / len(union)
        if jaccard >= 0.6:
            desc_snippet = (getattr(t, "description", "") or "")[:120]
            return (
                f"A very similar tool '{t.name}' already exists: \"{desc_snippet}\". "
                f"Use update_tool '{t.name}' to extend it instead of creating a near-duplicate. "
                f"Only proceed with generate_tool if this genuinely does something different "
                f"(re-call with a more specific description that distinguishes it)."
            )

    return None


def _pattern_hint(pattern_store: Any, description: str) -> str:
    """Phase 5c — on a failed verification, surface proven skeletons from similar tools
    that DID pass, so the agent's retry is informed by what works (not a blind re-try)."""
    try:
        pats = pattern_store.get_similar_patterns(description)[:2]
        if not pats:
            return ""
        blocks = "\n---\n".join(
            f"# {p.tool_name} (passed {p.success_count}x)\n{(p.implementation_skeleton or '')[:600]}"
            for p in pats
        )
        return f"\n\nProven patterns from similar tools that passed verification — adapt one of these:\n{blocks}"
    except Exception:
        return ""


class GenerateToolTool(Tool):
    """
    A meta-tool that allows the agent to generate and register new dynamic tools.
    """

    def __init__(self, registry: Any, persistence: Any = None, job_id: Optional[str] = None, event_emitter: Optional[ToolEventEmitter] = None, pattern_store: Optional[PatternStore] = None, health_monitor: Any = None):
        self._registry = registry
        self._persistence = persistence
        self._job_id = job_id
        self._event_emitter = event_emitter
        self._pattern_store = pattern_store or PatternStore(Path("workspace/patterns/patterns.json"))
        self._manager = DynamicToolManager(registry=registry, persistence=persistence, health_monitor=health_monitor)
        self._health_monitor = health_monitor
        
        # Milestone 4.5: Link health monitor to auto-rollback if available
        if self._health_monitor and hasattr(self._health_monitor, "_rollback_trigger"):
            self._health_monitor._rollback_trigger = self._manager.rollback_tool

    @property
    def name(self) -> str:
        return "generate_tool"

    @property
    def description(self) -> str:
        return (
            "Generate, verify, and register a new callable tool. Use when you need a capability that doesn't exist yet. "
            "The tool persists and is versioned (it does NOT vanish at session end). On success it's available to call by its name.\n"
            "RULES (the verifier enforces these — follow them up front to avoid retries):\n"
            "- Entry point: `def main(**kwargs)` returning JSON-serializable data (str / list / dict).\n"
            "- Runs in a security sandbox. FORBIDDEN: importing os, subprocess, shutil, importlib, socket; calling eval, exec, compile, __import__, getattr, setattr; and the bare builtin open().\n"
            "- File I/O: use pathlib instead of open() — e.g. `from pathlib import Path; Path(p).read_text()`, `Path(p).write_text(s)`, or `Path(p).open('a')`. Persist data under /workspace/group/workspace/.\n"
            "- Allowed: standard libs like json, re, math, datetime, pathlib, itertools, collections.\n"
            "- Web requests: NEVER import httpx/requests/aiohttp/urllib.request — the verifier rejects them. "
            "Use `from nanoagent.agent.source_fetch import fetch, record_yield`, then `res = await fetch(url)` "
            "(check `res.ok`, read `res.text`, surface `res.error`). It gives you residential-proxy routing for "
            "sites that need it, the per-domain crawl delay, a shared per-cycle request budget, and a 429 that "
            "stops rather than retries. Call `record_yield(url, len(items))` after parsing so a broken selector "
            "raises a canary instead of looking like a quiet day.\n"
            "- test_cases: a list of {\"input\": {<kwargs for main>}, \"expected_contains\"?: str, \"expected_type\"?: str, \"expected_status\"?: \"success\"|\"error\"}. Provide at least one. Do NOT add a 'name' key.\n"
            "- If verification fails, READ the error and call generate_tool again with the fix — don't resubmit the same code.\n"
            + self._known_sources_line()
        )

    @staticmethod
    def _known_sources_line() -> str:
        """Hard-won rules per source, in front of the model while it writes the tool.

        The scanner can stop a generated tool from building its own client, but it cannot
        stop it writing `for attempt in range(3): await fetch(...)` around a 429 — that
        retry lives in the caller. The only thing that prevents it is the model knowing,
        at authoring time, that the 429 is terminal here.
        """
        try:
            from nanoagent.agent.source_fetch import known_sources_brief

            brief = known_sources_brief()
        except Exception:
            return ""
        if not brief:
            return ""
        return (
            "KNOWN SOURCES (these limits are enforced for you by source_fetch — do not add "
            "your own retry loop around a stop status; when fetch() returns exhausted=True "
            "the source is finished for this cycle and trying again costs the endpoint):\n"
            + brief
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Tool name in kebab-case"},
                "description": {"type": "string"},
                "parameters": {"type": "object", "description": "JSON Schema for parameters"},
                "implementation": {"type": "string", "description": "Single-file tool code (defines main()). Use this OR 'files'."},
                "files": {
                    "type": "array",
                    "description": "Multi-file tool: a list of {path, content}. The entrypoint file must define main(). Use instead of 'implementation' for complex tools.",
                    "items": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
                        "required": ["path", "content"]
                    }
                },
                "entrypoint": {"type": "string", "description": "For multi-file tools: the path (in files) that defines main(). Default 'implementation.py'."},
                "dependencies": {"type": "array", "items": {"type": "string"}, "description": "Packages the tool needs. A bare name is a pip package (e.g. 'matplotlib'); prefix a SYSTEM package with 'apt:' (e.g. 'apt:tesseract-ocr', 'apt:ffmpeg'). Sidecar-tier tools may declare ANY package; declaring deps runs the tool in the isolated sidecar where they're installed + cached."},
                "tags": {"type": "array", "items": {"type": "string"}, "description": "Categories/tags for this tool"},
                "capabilities": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Agent powers this tool needs via the injected `host` object. Declaring one runs the tool in the sidecar (where `host` lives) and authorizes that call. Available: [\"search_memory\"] → call host.search_memory(query) to read the agent's long-term memory."
                },
                "test_cases": {
                    "type": "array",
                    "description": "At least one. Each: {input, expected_contains?, expected_type?, expected_status?}. No 'name' key.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "input": {"type": "object", "description": "kwargs passed to main()"},
                            "expected_contains": {"type": "string"},
                            "expected_type": {"type": "string"},
                            "expected_status": {"type": "string", "enum": ["success", "error"]}
                        },
                        "required": ["input"]
                    }
                }
            },
            "required": ["name", "description", "parameters"]
        }

    async def execute(self, **kwargs: Any) -> str:
        try:
            # Dedup check — before any manifest/verify work.
            dedup_msg = _dedup_check(self._registry, kwargs.get("name", ""), kwargs.get("description", ""))
            if dedup_msg:
                return dedup_msg

            test_cases_data = kwargs.get("test_cases", [])
            test_cases = [TestCase.from_dict(tc) for tc in test_cases_data]

            # Multi-file: accept `files` as a {path: code} object OR a [{path, content}] list.
            files_raw = kwargs.get("files")
            files: dict[str, str] = {}
            if isinstance(files_raw, dict):
                files = {str(k): str(v) for k, v in files_raw.items()}
            elif isinstance(files_raw, list):
                for f in files_raw:
                    if isinstance(f, dict) and f.get("path"):
                        files[str(f["path"])] = str(f.get("content", ""))

            if not kwargs.get("implementation") and not files:
                return "Error: provide either 'implementation' (single-file) or 'files' (multi-file)."

            manifest = ToolManifest(
                name=kwargs["name"],
                description=kwargs["description"],
                parameters=kwargs["parameters"],
                implementation=kwargs.get("implementation", ""),
                files=files,
                entrypoint=kwargs.get("entrypoint", "implementation.py"),
                language=kwargs.get("language", "python"),
                dependencies=kwargs.get("dependencies", []),
                # System decides the tier from what the tool needs (agent doesn't pick).
                tier=classify_tier(kwargs.get("dependencies", []), kwargs.get("capabilities")),
                # Declared host.* powers (e.g. ["search_memory"]) — gated by the broker.
                capabilities=kwargs.get("capabilities", []) or [],
                test_cases=test_cases,
                job_scope=self._job_id,
                tags=kwargs.get("tags", [])
            )

            success, message, test_results = await self._manager.prepare_and_verify(manifest)
            if not success:
                self._pattern_store.record_failure(manifest, message)
                return message + _pattern_hint(self._pattern_store, manifest.description)

            self._pattern_store.record_success(manifest)
            # Register
            dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
            if hasattr(self._registry, "register_dynamic"):
                self._registry.register_dynamic(dynamic_tool)
            else:
                self._registry.register(dynamic_tool)
            # Advertise the just-built tool past the deferred catalog so the agent can
            # CALL IT THIS SAME CYCLE — i.e. build a tool mid-task and immediately use it.
            if hasattr(self._registry, "activate"):
                self._registry.activate([manifest.name])

            # Persist
            if self._persistence:
                self._persistence.save(manifest, test_result=test_results)

            # Emit IPC event
            if self._event_emitter:
                self._event_emitter.emit_created(manifest.name, manifest.version, manifest.to_dict())

            return (
                f"Successfully generated tool '{manifest.name}'.\n"
                f"It is now registered and available for use.\n"
                f"Signature: {manifest.name}({', '.join(manifest.parameters.get('properties', {}).keys())})"
            )

        except Exception as e:
            return f"Error: Failed to generate tool: {str(e)}"


class RegisterToolFromDirTool(Tool):
    """Register a tool the agent BUILT itself in a workspace folder (the coding-loop path).

    Instead of describing a whole tool in one `generate_tool` call, the agent develops it
    like an engineer — write files, run them, read failures, fix — then points this tool at
    the folder. It re-verifies (security scan + the agent's test_cases) and registers it.
    """

    def __init__(self, registry: Any, persistence: Any = None, job_id: Optional[str] = None,
                 event_emitter: Optional[ToolEventEmitter] = None, pattern_store: Optional[PatternStore] = None,
                 workspace: Any = None, health_monitor: Any = None):
        self._registry = registry
        self._persistence = persistence
        self._job_id = job_id
        self._event_emitter = event_emitter
        self._pattern_store = pattern_store or PatternStore(Path("workspace/patterns/patterns.json"))
        self._health_monitor = health_monitor
        self._manager = DynamicToolManager(registry=registry, persistence=persistence, health_monitor=health_monitor)
        self._workspace = Path(workspace) if workspace else Path("/workspace/group")

    @property
    def name(self) -> str:
        return "register_tool_from_dir"

    @property
    def description(self) -> str:
        return (
            "Register a tool you BUILT yourself in a workspace folder — the engineer's path for complex/multi-file tools. "
            "Workflow: (1) make a folder in your workspace, (2) write the tool's files there with write_file (an entrypoint that "
            "defines `main(**kwargs)`, plus any helper modules it imports), (3) RUN/test them yourself (exec/python_repl) until they work, "
            "(4) call this with the folder path. It re-verifies (security scan of every file + your test_cases) and registers the folder as a callable tool. "
            "Same sandbox rules apply (no os/subprocess/socket; no open()/eval/exec; use pathlib; persist data under /workspace/group/workspace/). "
            "Use generate_tool instead for a simple single-file tool."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Tool name in kebab-case"},
                "description": {"type": "string"},
                "parameters": {"type": "object", "description": "JSON Schema for the tool's call parameters"},
                "dir": {"type": "string", "description": "Folder (in your workspace) holding the built files"},
                "entrypoint": {"type": "string", "description": "File in the folder that defines main(). Default 'impl.py'."},
                "dependencies": {"type": "array", "items": {"type": "string"}, "description": "Packages the tool needs. A bare name is a pip package (e.g. 'matplotlib'); prefix a SYSTEM package with 'apt:' (e.g. 'apt:tesseract-ocr', 'apt:ffmpeg'). Sidecar-tier tools may declare ANY package; declaring deps runs the tool in the isolated sidecar where they're installed + cached."},
                "tags": {"type": "array", "items": {"type": "string"}},
                "capabilities": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Agent powers this tool needs via the injected `host` object (e.g. [\"search_memory\"] → host.search_memory(query)). Declaring one runs the tool in the sidecar and authorizes that call."
                },
                "test_cases": {
                    "type": "array",
                    "description": "At least one. Each: {input, expected_contains?, expected_type?, expected_status?}.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "input": {"type": "object"},
                            "expected_contains": {"type": "string"},
                            "expected_type": {"type": "string"},
                            "expected_status": {"type": "string", "enum": ["success", "error"]},
                        },
                        "required": ["input"],
                    },
                },
            },
            "required": ["name", "description", "parameters", "dir"],
        }

    async def execute(self, **kwargs: Any) -> str:
        try:
            # Dedup check — before file collection or verify work.
            dedup_msg = _dedup_check(self._registry, kwargs.get("name", ""), kwargs.get("description", ""))
            if dedup_msg:
                return dedup_msg

            dir_arg = kwargs.get("dir") or kwargs.get("path")
            if not dir_arg:
                return "Error: 'dir' (the folder containing your built tool files) is required."
            base = Path(dir_arg)
            if not base.is_absolute():
                base = self._workspace / dir_arg
            base = base.resolve()
            ws = self._workspace.resolve()
            try:
                base.relative_to(ws)
            except ValueError:
                return f"Error: directory must be inside your workspace ({ws})."
            if not base.is_dir():
                return f"Error: directory not found: {base}"

            # Collect source files (skip caches/hidden/binaries).
            SKIP_DIRS = {"__pycache__", ".git", "node_modules", ".pytest_cache", "versions"}
            files: dict[str, str] = {}
            for p in sorted(base.rglob("*")):
                if p.is_dir():
                    continue
                rel = p.relative_to(base).as_posix()
                if any(part in SKIP_DIRS for part in rel.split("/")):
                    continue
                if p.suffix == ".pyc" or p.name.startswith("."):
                    continue
                try:
                    files[rel] = p.read_text(encoding="utf-8")
                except Exception:
                    continue  # skip unreadable/binary files
            if not files:
                return f"Error: no readable source files found in {base}."

            test_cases = [TestCase.from_dict(tc) for tc in kwargs.get("test_cases", [])]
            manifest = ToolManifest(
                name=kwargs["name"],
                description=kwargs["description"],
                parameters=kwargs["parameters"],
                implementation="",
                files=files,
                entrypoint=kwargs.get("entrypoint", "impl.py"),
                language=kwargs.get("language", "python"),
                dependencies=kwargs.get("dependencies", []),
                # System decides the tier from what the tool needs (agent doesn't pick).
                tier=classify_tier(kwargs.get("dependencies", []), kwargs.get("capabilities")),
                # Declared host.* powers (e.g. ["search_memory"]) — gated by the broker.
                capabilities=kwargs.get("capabilities", []) or [],
                test_cases=test_cases,
                job_scope=self._job_id,
                tags=kwargs.get("tags", []),
            )

            success, message, test_results = await self._manager.prepare_and_verify(manifest)
            if not success:
                self._pattern_store.record_failure(manifest, message)
                return message + _pattern_hint(self._pattern_store, manifest.description)

            self._pattern_store.record_success(manifest)
            dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
            if hasattr(self._registry, "register_dynamic"):
                self._registry.register_dynamic(dynamic_tool)
            else:
                self._registry.register(dynamic_tool)
            # Advertise the just-built tool so it's callable THIS cycle (same-cycle use).
            if hasattr(self._registry, "activate"):
                self._registry.activate([manifest.name])
            if self._persistence:
                self._persistence.save(manifest, test_result=test_results)
            if self._event_emitter:
                self._event_emitter.emit_created(manifest.name, manifest.version, manifest.to_dict())

            # Clean up build scratch: the tool is now persisted canonically (versioned) under
            # the agent's tools/<name>/ dir, so the source folder left in the workspace is
            # redundant and just clutters the tree. Remove it (best-effort, never the ws root).
            scratch_cleaned = False
            try:
                import shutil as _shutil
                if base.resolve() != ws.resolve() and base.is_dir():
                    _shutil.rmtree(base, ignore_errors=True)
                    scratch_cleaned = not base.exists()
            except Exception:
                pass

            shown = ", ".join(list(files)[:6]) + (" …" if len(files) > 6 else "")
            tail = " Build folder cleaned up (the tool is saved under tools/)." if scratch_cleaned else ""
            return (
                f"Successfully registered tool '{manifest.name}' from {len(files)} file(s) [{shown}] (entrypoint: {manifest.entrypoint}).\n"
                f"It is now callable. Signature: {manifest.name}({', '.join(manifest.parameters.get('properties', {}).keys())}).{tail}"
            )
        except Exception as e:
            return f"Error: Failed to register tool from dir: {str(e)}"


class UpdateToolTool(Tool):
    """Updates an existing dynamic tool with new implementation or tests."""

    def __init__(self, registry: Any, persistence: Any = None, job_id: Optional[str] = None, event_emitter: Optional[ToolEventEmitter] = None, health_monitor: Any = None):
        self._registry = registry
        self._persistence = persistence
        self._job_id = job_id
        self._event_emitter = event_emitter
        # An update re-registers the tool. Without carrying the monitor across, updating a
        # tool silently stripped its rollback protection for the rest of the process.
        self._health_monitor = health_monitor
        self._manager = DynamicToolManager(registry=registry, persistence=persistence, health_monitor=health_monitor)

    @property
    def name(self) -> str:
        return "update_tool"

    @property
    def description(self) -> str:
        return "Updates an existing dynamic tool with a new implementation, dependencies, or test cases. Increments version."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "description": {"type": "string"},
                "implementation": {"type": "string"},
                "test_cases": {"type": "array", "items": {"type": "object"}},
                "dependencies": {"type": "array", "items": {"type": "string"}, "description": "Packages the tool needs. A bare name is a pip package (e.g. 'matplotlib'); prefix a SYSTEM package with 'apt:' (e.g. 'apt:tesseract-ocr', 'apt:ffmpeg'). Sidecar-tier tools may declare ANY package; declaring deps runs the tool in the isolated sidecar where they're installed + cached."},
                "tags": {"type": "array", "items": {"type": "string"}},
                "bump_type": {"type": "string", "enum": ["patch", "minor", "major"], "default": "patch"}
            },
            "required": ["name"]
        }

    async def execute(self, **kwargs: Any) -> str:
        name = kwargs["name"]
        if not self._persistence or not self._persistence.exists(name, job_id=self._job_id):
            return f"Error: Tool '{name}' not found or not a dynamic tool in the current scope."

        try:
            manifest = self._persistence.load(name, job_id=self._job_id)
            if not manifest:
                return f"Error: Failed to load manifest for '{name}'."

            # Update fields if provided
            if "description" in kwargs: manifest.description = kwargs["description"]
            if "implementation" in kwargs: manifest.implementation = kwargs["implementation"]
            if "dependencies" in kwargs: manifest.dependencies = kwargs["dependencies"]
            if "tags" in kwargs: manifest.tags = kwargs["tags"]
            if "test_cases" in kwargs:
                manifest.test_cases = [TestCase.from_dict(tc) for tc in kwargs["test_cases"]]

            success, message, test_results = await self._manager.prepare_and_verify(manifest)
            if not success:
                return f"Update failed: {message}"

            # Persist with version bump
            await self._persistence.update(
                manifest, 
                test_result=test_results, 
                bump_type=kwargs.get("bump_type", "patch")
            )

            # Re-register
            dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
            self._registry.unregister_dynamic(name)
            self._registry.register_dynamic(dynamic_tool)

            # Emit IPC event
            if self._event_emitter:
                self._event_emitter.emit_updated(manifest.name, manifest.version, manifest.to_dict())

            return f"Successfully updated tool '{name}' to v{manifest.version}."
        except Exception as e:
            return f"Error: Failed to update tool: {str(e)}"


class RollbackToolTool(Tool):
    """Rolls back a dynamic tool to a previous version."""

    def __init__(self, registry: Any, persistence: Any = None, job_id: Optional[str] = None, event_emitter: Optional[ToolEventEmitter] = None, health_monitor: Any = None):
        self._registry = registry
        self._persistence = persistence
        self._job_id = job_id
        self._event_emitter = event_emitter
        # A tool that has been rolled back once is the one most worth still watching;
        # re-registering it unmonitored is how a bad tool becomes permanently invisible.
        self._health_monitor = health_monitor

    @property
    def name(self) -> str:
        return "rollback_tool"

    @property
    def description(self) -> str:
        return "Rolls back a dynamically generated tool to its previous version or a specified version."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "version": {"type": "string", "description": "Specific version to rollback to (optional)"}
            },
            "required": ["name"]
        }

    async def execute(self, **kwargs: Any) -> str:
        name = kwargs["name"]
        version = kwargs.get("version")
        
        if not self._persistence:
            return "Error: Persistence layer not available."

        try:
            manifest = self._persistence.rollback(name, version=version, job_id=self._job_id)
            if not manifest:
                return f"Error: Could not rollback tool '{name}'. Old version might not exist in the current scope."

            # Re-register the rolled back version
            dynamic_tool = DynamicTool(manifest, health_monitor=self._health_monitor)
            self._registry.unregister_dynamic(name)
            self._registry.register_dynamic(dynamic_tool)

            # Emit IPC event
            if self._event_emitter:
                self._event_emitter.emit_updated(manifest.name, manifest.version, manifest.to_dict())

            return f"Successfully rolled back tool '{name}' to v{manifest.version}."
        except Exception as e:
            return f"Error: Failed to rollback tool: {str(e)}"

class CreatePipelineTool(Tool):
    """A meta-tool that allows the agent to define and save a reusable multi-step pipeline."""
    def __init__(self, registry: Any, pipeline_persistence: Any = None, job_id: Optional[str] = None):
        self._registry = registry
        self._pipeline_persistence = pipeline_persistence
        self._job_id = job_id

    @property
    def name(self) -> str:
        return "create_pipeline"

    @property
    def description(self) -> str:
        return "Defines a reusable multi-step pipeline that chains existing tools together."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Pipeline name (kebab-case)"},
                "description": {"type": "string"},
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tool_name": {"type": "string"},
                            "params": {"type": "object", "description": "Args. Variables: $input.field, $step.output"},
                            "output_key": {"type": "string"},
                            "parallel": {"type": "boolean"},
                            "on_error": {"type": "string", "enum": ["fail", "skip", "retry"]},
                            "max_retries": {"type": "integer"},
                            "condition": {"type": "string"}
                        },
                        "required": ["tool_name", "params", "output_key"]
                    }
                },
                "input_schema": {"type": "object", "description": "JSON Schema for pipeline inputs"}
            },
            "required": ["name", "description", "steps", "input_schema"]
        }

    async def execute(self, **kwargs: Any) -> str:
        if not self._pipeline_persistence:
            return "Error: Pipeline persistence layer not available."
            
        try:
            from nanoagent.agent.tools.dynamic.pipeline import Pipeline, PipelineStep
            
            steps = [PipelineStep.from_dict(s) for s in kwargs["steps"]]
            
            pipeline = Pipeline(
                name=kwargs["name"],
                description=kwargs["description"],
                steps=steps,
                input_schema=kwargs["input_schema"]
            )
            
            self._pipeline_persistence.save(pipeline, job_id=self._job_id)
            
            return f"Successfully created and saved pipeline '{pipeline.name}'."
        except Exception as e:
            return f"Error creating pipeline: {str(e)}"


class RunPipelineTool(Tool):
    """Executes a previously saved pipeline."""
    def __init__(self, registry: Any, pipeline_persistence: Any = None, job_id: Optional[str] = None):
        self._registry = registry
        self._pipeline_persistence = pipeline_persistence
        self._job_id = job_id
        
    @property
    def name(self) -> str:
        return "run_pipeline"

    @property
    def description(self) -> str:
        return "Executes a saved multi-step tool pipeline with the given inputs."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "The name of the pipeline to run"},
                "inputs": {"type": "object", "description": "Inputs matching the pipeline's input_schema"}
            },
            "required": ["name", "inputs"]
        }

    async def execute(self, **kwargs: Any) -> str:
        if not self._pipeline_persistence:
            return "Error: Pipeline persistence layer not available."
            
        pipeline_name = kwargs["name"]
        inputs = kwargs.get("inputs", {})
        
        try:
            pipeline = self._pipeline_persistence.load(pipeline_name, job_id=self._job_id)
            if not pipeline:
                return f"Error: Pipeline '{pipeline_name}' not found."
                
            from nanoagent.agent.tools.dynamic.pipeline import PipelineExecutor
            executor = PipelineExecutor(self._registry, job_id=self._job_id)
            
            result = await executor.execute(pipeline, inputs)
            
            import json
            return json.dumps(result.to_dict(), indent=2)
            
        except Exception as e:
            return f"Error executing pipeline '{pipeline_name}': {str(e)}"

class GetToolPatternsTool(Tool):
    """Searches for successful tool patterns to help with generating new tools."""
    def __init__(self, pattern_store: Optional[PatternStore] = None):
        self._pattern_store = pattern_store or PatternStore(Path("workspace/patterns/patterns.json"))

    @property
    def name(self) -> str:
        return "get_tool_patterns"

    @property
    def description(self) -> str:
        return "Searches the pattern store for successful code skeletons matching a description."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "description": {"type": "string", "description": "What the tool should do"}
            },
            "required": ["description"]
        }

    async def execute(self, **kwargs: Any) -> str:
        patterns = self._pattern_store.get_similar_patterns(kwargs["description"])
        if not patterns:
            return "No matching patterns found."
            
        return json.dumps([p.to_dict() for p in patterns], indent=2)

