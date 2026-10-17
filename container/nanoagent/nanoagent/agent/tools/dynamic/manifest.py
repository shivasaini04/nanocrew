"""Core data structures for dynamically generated tools."""

import re
from dataclasses import dataclass, field, asdict
from datetime import datetime
from typing import Any, Optional


@dataclass
class SandboxConfig:
    """Defines resource limits and permissions for the tool's execution environment."""
    memory_limit_mb: int = 256
    cpu_timeout_seconds: int = 5
    network_allowed: bool = True
    allowed_domains: list[str] = field(default_factory=lambda: ["*"])
    filesystem_readonly: bool = True
    allowed_write_paths: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SandboxConfig":
        return cls(**data)


@dataclass
class TestCase:
    """Defines a single unit test for the generated tool."""
    input: dict[str, Any]
    expected_contains: Optional[str] = None
    expected_type: Optional[str] = None
    expected_schema: Optional[dict[str, Any]] = None
    expected_status: str = "success"  # "success" | "error"

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "TestCase":
        # Tolerate extra keys (e.g. a "name"/label the model adds) instead of crashing —
        # only pass through the fields TestCase actually defines.
        known = {"input", "expected_contains", "expected_type", "expected_schema", "expected_status"}
        return cls(**{k: v for k, v in data.items() if k in known})


# ── Phase 1 (stage25): automatic tier selection ────────────────────────────────
# The SYSTEM decides where a tool runs — the agent never picks. A tool that needs
# real power (third-party deps, shell/subprocess, broad network) goes to the isolated
# sidecar container; a pure-compute tool gets the cheap in-process sandbox. The
# TOOL_ISOLATION env knob can force everything to the sidecar on a resource-rich host.
_POWER_CAPABILITIES = {"shell", "subprocess", "net", "network", "apt", "fs_write"}
# Host-RPC capabilities (Phase 3): the `host.*` bridge is injected only in the sidecar,
# so declaring any of these forces the sidecar tier in addition to gating the call.
# `handoff` is a HITL-gated agent-coordination method (operator approves before the
# action fires) — high-privilege, so it's opt-in via capabilities like the rest.
_HOST_CAPABILITIES = {
    "search_memory", "send_message", "message", "call_tool", "handoff",
}
_SIDECAR_CAPABILITIES = _POWER_CAPABILITIES | _HOST_CAPABILITIES


def classify_tier(dependencies: Optional[list] = None,
                  capabilities: Optional[list] = None) -> str:
    """Decide a tool's execution tier from what it declares. Pure → 'sandbox';
    anything needing install/shell/network OR a host.* capability → 'sidecar'."""
    import os
    if os.environ.get("TOOL_ISOLATION", "auto").lower() == "always-sidecar":
        return "sidecar"
    if dependencies:  # any declared third-party package → needs install → sidecar
        return "sidecar"
    if capabilities and any(c in _SIDECAR_CAPABILITIES for c in capabilities):
        return "sidecar"
    return "sandbox"


@dataclass
class ToolManifest:
    """The primary container for a tool's definition."""
    name: str
    description: str
    parameters: dict[str, Any]
    implementation: str
    # Multi-file tools: {relative_path: code}. `entrypoint` is the file that defines main().
    # Single-file tools leave `files` empty; it's normalized to {entrypoint: implementation}.
    files: dict[str, str] = field(default_factory=dict)
    entrypoint: str = "implementation.py"
    return_type: str = "text"  # "json" | "text" | "array"
    language: str = "python"  # "python" | "bash" | "javascript"
    dependencies: list[str] = field(default_factory=list)
    timeout: int = 30
    sandbox_config: SandboxConfig = field(default_factory=SandboxConfig)
    test_cases: list[TestCase] = field(default_factory=list)
    version: str = "0.1.0"
    created_at: str = field(default_factory=lambda: datetime.utcnow().isoformat() + "Z")
    job_scope: Optional[str] = None
    tags: list[str] = field(default_factory=list)  # e.g. ["scraping", "data", "web"]
    # ── Phase 0 (stage25): unified execution model ──────────────────────────────
    # `tier` is the single source of truth for HOW a tool runs, replacing the split
    # between the in-cycle factory (subprocess sandbox) and the orchestrator's
    # requiresSidecar flag (Docker container). Defaults to "sandbox" so every
    # existing manifest keeps its current behavior.
    #   "sandbox" → isolated subprocess; AST-blocklisted (no os/subprocess/open).
    #   "sidecar" → per-agent Docker container; heavier deps + subprocess allowed,
    #               isolation (not the blocklist) is the safety boundary.
    tier: str = "sandbox"
    # Forward-looking declaration of powers a tool needs (e.g. ["net", "fs", "shell"]).
    # Recorded now; enforced by the capability gradient in later phases.
    capabilities: list[str] = field(default_factory=list)

    def __post_init__(self):
        self._normalize_files()
        self.validate()

    def _normalize_files(self):
        """Keep single-file (`implementation`) and multi-file (`files`) representations in
        sync. After this, `files` always holds the full set and `implementation` is the
        entrypoint file's code — so legacy code that reads `.implementation` still works."""
        if self.files:
            if self.entrypoint not in self.files:
                # Pick a sensible entrypoint if the given one isn't present.
                for cand in ("implementation.py", "impl.py", "main.py"):
                    if cand in self.files:
                        self.entrypoint = cand
                        break
                else:
                    self.entrypoint = next(iter(self.files))
            if not self.implementation:
                self.implementation = self.files[self.entrypoint]
        else:
            self.files = {self.entrypoint: self.implementation or ""}

    def validate(self):
        """Run all validations for the manifest."""
        self.validate_name(self.name)
        self.validate_parameters(self.parameters)
        if self.language not in ("python", "bash", "javascript", "typescript"):
            raise ValueError(f"Invalid language: {self.language}")
        if self.return_type not in ("json", "text", "array"):
            raise ValueError(f"Invalid return_type: {self.return_type}")
        if self.tier not in ("sandbox", "sidecar"):
            raise ValueError(f"Invalid tier: {self.tier!r} (expected 'sandbox' or 'sidecar')")
        # Multi-file guards
        if len(self.files) > 12:
            raise ValueError("Too many files in a tool (max 12).")
        if sum(len(c) for c in self.files.values()) > 262144:
            raise ValueError("Tool code too large (max 256KB total).")
        for rel in self.files:
            if rel.startswith("/") or rel.startswith("\\") or ".." in re.split(r"[\\/]", rel):
                raise ValueError(f"Invalid file path in tool: {rel!r}")

    @staticmethod
    def validate_name(name: str):
        """Ensures name is kebab-case and alphanumeric."""
        if not re.match(r"^[a-z0-9]+(-[a-z0-9]+)*$", name):
            raise ValueError(
                f"Invalid tool name: {name!r}. Must be kebab-case (e.g., 'scrape-leads')."
            )

    @staticmethod
    def validate_parameters(parameters: dict[str, Any]):
        """Ensures parameters is a valid JSON Schema object."""
        if not isinstance(parameters, dict):
            raise ValueError("Parameters must be a dictionary (JSON Schema).")
        if parameters.get("type") != "object":
            raise ValueError("Parameter schema must have 'type': 'object' at the top level.")

    def to_dict(self) -> dict[str, Any]:
        """Convert manifest to a JSON-serializable dictionary."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ToolManifest":
        """Reconstruct manifest from a dictionary."""
        data = data.copy()
        if "sandbox_config" in data:
            data["sandbox_config"] = SandboxConfig.from_dict(data["sandbox_config"])
        if "test_cases" in data:
            data["test_cases"] = [TestCase.from_dict(tc) for tc in data["test_cases"]]
        return cls(**data)
