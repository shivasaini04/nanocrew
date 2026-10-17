"""Four-tier runtime settings loader for nanocrew.

Single source of truth for agent-runtime configuration (permissions, hooks,
compaction, telemetry, MCP servers, credentials).  Intentionally separate from
``nanoagent/config/schema.py`` which handles channel / provider / gateway config.

Precedence (lowest → highest — later layers override earlier ones):

1. **Built-in defaults** — hardcoded in ``nanocrewSettings`` field defaults.
2. **User config** — ``~/.config/nanocrew/settings.json`` (personal, not project-specific).
3. **Project config** — ``<workspace>/.nanocrew/settings.json`` (checked into git; team conventions).
4. **Project local** — ``<workspace>/.nanocrew/settings.local.json`` (gitignored; personal overrides + credentials).
5. **Environment variables** — ``nanocrew_*`` (CI / container overrides).

Lists (``permissions.rules``, ``hooks``) are **concatenated** across layers so
adding a rule in ``.local.json`` never silently drops the project rules.
Scalars and dicts use last-write-wins.

Credentials in ``.local.json``::

    {
      "credentials": {
        "apollo":   { "api_key": "my-key" },
        "gmail":    { "refresh_token": "..." }
      }
    }

These are injected into the process environment using the same mapping as
``nanoagent/agent/tools/credentials.py`` so ``get_credential()`` works without
the NanoCrew orchestrator being present (useful for local dev).
"""

from __future__ import annotations

import json
import os
from copy import deepcopy
from dataclasses import dataclass, field
import sys
from pathlib import Path
from typing import Any


# ---------------------------------------------------------------------------
# Sub-settings dataclasses
# ---------------------------------------------------------------------------

@dataclass
class PermissionRule:
    decision: str   # "allow" | "deny" | "ask"
    pattern: str    # glob over "tool_name" or "tool_name:args[:200]"


@dataclass
class PermissionsSettings:
    mode: str = "workspace_write"
    # "read_only" | "workspace_write" | "danger_full_access" | "prompt" | "allow"
    rules: list[PermissionRule] = field(default_factory=list)


@dataclass
class HookEntry:
    event: str       # "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
    command: str
    matcher: str = "*"
    timeout_ms: int = 5000
    on_error: str = "continue"   # "continue" | "deny"


@dataclass
class CompactionSettings:
    threshold_tokens: int = 100_000
    keep_tail: int = 8


@dataclass
class TelemetrySettings:
    log_dir: str | None = None   # None → <workspace>/.nanocrew/telemetry/
    redact_content: bool = False


@dataclass
class McpServerEntry:
    """Stdio MCP server spawned by the agent at startup."""
    command: str
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    enabled: bool = True
    startup_timeout_ms: int = 10_000


@dataclass
class ToolsSettings:
    disabled: list[str] = field(default_factory=list)   # tool names to skip


@dataclass
class SecuritySettings:
    # "strict" | "auto" | "dangerous"; empty falls back to NANOCREW_SECURITY_POSTURE.
    posture: str = ""


# ---------------------------------------------------------------------------
# Root settings
# ---------------------------------------------------------------------------


#: Settings an agent may never set for itself, whatever grants it holds. These are not
#: self-management — they are "run arbitrary code as this container" wearing the same
#: file. The orchestrator never includes them in NANOCREW_ALLOWED_SETTINGS; this list is
#: the second lock, so a bug there cannot open them.
_NEVER_AGENT_WRITABLE = frozenset({"permissions", "hooks", "mcp_servers"})


def _filter_agent_keys(data: dict[str, Any]) -> dict[str, Any]:
    """Drop settings keys this agent's grants do not cover.

    NANOCREW_ALLOWED_SETTINGS is a comma-separated allowlist set per cycle by the
    orchestrator. UNSET means no policy — every key applies, which is the pre-stage-55
    behaviour and the right answer for a standalone nanoagent with no orchestrator. An
    EMPTY string is a real policy meaning "this agent may set nothing", and is not the
    same as unset.
    """
    if not data:
        return data

    raw = os.environ.get("NANOCREW_ALLOWED_SETTINGS")
    if raw is None:
        return data  # standalone / no policy

    allowed = {k.strip() for k in raw.split(",") if k.strip()} - _NEVER_AGENT_WRITABLE
    dropped = [k for k in data if k not in allowed]
    if dropped:
        print(
            f"[settings] dropped {len(dropped)} key(s) this agent may not set: "
            f"{', '.join(sorted(dropped))}",
            file=sys.stderr,
        )
    return {k: v for k, v in data.items() if k in allowed}


@dataclass
class nanocrewSettings:
    """Merged runtime settings for the nanocrew agent loop."""

    model: str | None = None
    permissions: PermissionsSettings = field(default_factory=PermissionsSettings)
    hooks: list[HookEntry] = field(default_factory=list)
    compaction: CompactionSettings = field(default_factory=CompactionSettings)
    telemetry: TelemetrySettings = field(default_factory=TelemetrySettings)
    mcp_servers: dict[str, McpServerEntry] = field(default_factory=dict)
    tools: ToolsSettings = field(default_factory=ToolsSettings)
    security: SecuritySettings = field(default_factory=SecuritySettings)
    credentials: dict[str, dict[str, str]] = field(default_factory=dict)

    # ------------------------------------------------------------------
    # Public loader
    # ------------------------------------------------------------------

    @classmethod
    def load(cls, workspace: Path) -> "nanocrewSettings":
        """Load and merge all four config tiers for ``workspace``.

        Also injects any credentials found in ``.local.json`` into the process
        environment so ``get_credential()`` works without NanoCrew.
        """
        raw: dict[str, Any] = {}

        # 1. User config
        user_path = Path.home() / ".config" / "nanocrew" / "settings.json"
        _deep_merge(raw, _load_json(user_path))

        # 2. Project config
        #
        # Tiers 2 and 3 live INSIDE the agent's own writable workspace, so on the NanoCrew
        # path they are agent-authored input, not operator config. Before stage 55 phase 1
        # that meant any agent could write one JSON file and hand itself
        # permissions.mode="danger_full_access", a shell command on every tool call (hooks)
        # and arbitrary subprocesses (mcp_servers) — no grant, no audit row, nothing.
        #
        # So these two tiers are filtered to the keys the orchestrator says this agent's
        # grants cover. Tier 1 (~/.config) is not filtered: it is in the image, outside the
        # agent's reach, and is genuine operator config.
        project_path = workspace / ".nanocrew" / "settings.json"
        _deep_merge(raw, _filter_agent_keys(_load_json(project_path)))

        # 3. Project local (gitignored)
        local_path = workspace / ".nanocrew" / "settings.local.json"
        _deep_merge(raw, _filter_agent_keys(_load_json(local_path)))

        # 4. Env vars (nanocrew_* overrides)
        _apply_env(raw)

        settings = cls._from_dict(raw)

        # Inject credentials into env so tools can use get_credential()
        settings._inject_credentials()

        return settings

    # ------------------------------------------------------------------
    # Helpers for permissions / hooks subsystems
    # ------------------------------------------------------------------

    def permission_mode_enum(self):
        """Return the ``PermissionMode`` enum value for the configured mode string."""
        from nanoagent.agent.permissions import PermissionMode
        return {
            "read_only": PermissionMode.ReadOnly,
            "workspace_write": PermissionMode.WorkspaceWrite,
            "danger_full_access": PermissionMode.DangerFullAccess,
            "prompt": PermissionMode.Prompt,
            "allow": PermissionMode.Allow,
        }.get(self.permissions.mode, PermissionMode.WorkspaceWrite)

    def security_posture(self):
        """Return the ``SecurityPosture`` for this agent.

        Settings win over the environment so a workspace can tighten what the
        platform handed it; the env var is the platform-level default.
        """
        from nanoagent.agent.security import SecurityPosture
        if self.security.posture:
            return SecurityPosture.parse(self.security.posture)
        return SecurityPosture.from_env()

    def build_permission_policy(self, prompter=None):
        """Construct a ``PermissionPolicy`` from these settings.

        Under the Strict posture, a caller that supplied no prompter gets one
        wired to the orchestrator — otherwise Strict would deny every outside-world
        call instead of routing it to a human.
        """
        from nanoagent.agent.permissions import HostApprovalPrompter, PermissionPolicy, PolicyRule as PR
        from nanoagent.agent.security import SecurityPosture
        rules = [PR(decision=r.decision, pattern=r.pattern) for r in self.permissions.rules]
        posture = self.security_posture()
        if prompter is None and posture is SecurityPosture.Strict:
            agent_id = os.environ.get("AGENT_ID", "")
            host = os.environ.get("NanoCrew_HOST", "")
            if agent_id and host:
                prompter = HostApprovalPrompter(
                    agent_id=agent_id,
                    host=host,
                    cycle_id=os.environ.get("CYCLE_ID") or None,
                )
        return PermissionPolicy(
            active_mode=self.permission_mode_enum(),
            rules=rules,
            prompter=prompter,
            posture=posture,
        )

    def build_hook_runner(self, workspace: Path, abort_signal=None):
        """Construct a ``HookRunner`` from these settings."""
        from nanoagent.agent.hooks import HookConfig, HookEvent, HookRunner
        configs = [
            HookConfig(
                event=HookEvent(h.event),
                command=h.command,
                matcher=h.matcher,
                timeout_ms=h.timeout_ms,
                on_error=h.on_error,
            )
            for h in self.hooks
        ]
        return HookRunner(configs=configs, workspace=workspace, abort_signal=abort_signal)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _inject_credentials(self) -> None:
        """Inject settings.credentials into env using the CREDENTIAL_ENV_MAP."""
        if not self.credentials:
            return
        try:
            from nanoagent.agent.tools.credentials import CREDENTIAL_ENV_MAP
        except ImportError:
            return

        for service, fields in self.credentials.items():
            svc_map = CREDENTIAL_ENV_MAP.get(service, {})
            for field_name, value in fields.items():
                env_var = svc_map.get(field_name) or f"{service.upper()}_{field_name.upper()}"
                if value and not os.environ.get(env_var):
                    os.environ[env_var] = value

    @classmethod
    def _from_dict(cls, raw: dict[str, Any]) -> "nanocrewSettings":
        s = cls()
        if not raw:
            return s

        if "model" in raw:
            s.model = raw["model"]

        # permissions
        perm = raw.get("permissions", {})
        if isinstance(perm, dict):
            s.permissions.mode = perm.get("mode", s.permissions.mode)
            for r in perm.get("rules", []):
                if isinstance(r, dict) and "decision" in r and "pattern" in r:
                    s.permissions.rules.append(PermissionRule(
                        decision=r["decision"], pattern=r["pattern"]
                    ))

        # hooks
        for h in raw.get("hooks", []):
            if isinstance(h, dict) and "event" in h and "command" in h:
                s.hooks.append(HookEntry(
                    event=h["event"],
                    command=h["command"],
                    matcher=h.get("matcher", "*"),
                    timeout_ms=h.get("timeout_ms", 5000),
                    on_error=h.get("on_error", "continue"),
                ))

        # compaction
        cmp = raw.get("compaction", {})
        if isinstance(cmp, dict):
            s.compaction.threshold_tokens = int(cmp.get("threshold_tokens", s.compaction.threshold_tokens))
            s.compaction.keep_tail = int(cmp.get("keep_tail", s.compaction.keep_tail))

        # telemetry
        tel = raw.get("telemetry", {})
        if isinstance(tel, dict):
            s.telemetry.log_dir = tel.get("log_dir", s.telemetry.log_dir)
            s.telemetry.redact_content = bool(tel.get("redact_content", s.telemetry.redact_content))

        # mcp_servers
        for name, srv in raw.get("mcp_servers", {}).items():
            if isinstance(srv, dict):
                s.mcp_servers[name] = McpServerEntry(
                    command=srv.get("command", ""),
                    args=list(srv.get("args", [])),
                    env=dict(srv.get("env", {})),
                    enabled=bool(srv.get("enabled", True)),
                    startup_timeout_ms=int(srv.get("startup_timeout_ms", 10_000)),
                )

        # tools
        tools_raw = raw.get("tools", {})
        if isinstance(tools_raw, dict):
            s.tools.disabled = list(tools_raw.get("disabled", []))

        # security
        sec_raw = raw.get("security", {})
        if isinstance(sec_raw, dict):
            s.security.posture = str(sec_raw.get("posture", s.security.posture))

        # credentials
        creds = raw.get("credentials", {})
        if isinstance(creds, dict):
            for svc, fields in creds.items():
                if isinstance(fields, dict):
                    s.credentials[svc] = {k: str(v) for k, v in fields.items()}

        return s


# ---------------------------------------------------------------------------
# Merge helpers
# ---------------------------------------------------------------------------

def _load_json(path: Path) -> dict[str, Any]:
    """Load a JSON file, returning an empty dict on any failure."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> None:
    """Merge ``override`` into ``base`` in-place.

    - Dicts are merged recursively.
    - Lists are **concatenated** (so rules accumulate across tiers).
    - Scalars are overwritten by ``override``.
    """
    for key, val in override.items():
        if key in base:
            existing = base[key]
            if isinstance(existing, dict) and isinstance(val, dict):
                _deep_merge(existing, val)
            elif isinstance(existing, list) and isinstance(val, list):
                base[key] = existing + val   # accumulate — don't replace
            else:
                base[key] = deepcopy(val)
        else:
            base[key] = deepcopy(val)


def _apply_env(raw: dict[str, Any]) -> None:
    """Override scalar settings from nanocrew_* environment variables."""
    _env_str = os.environ.get

    # Model
    if v := _env_str("nanocrew_MODEL"):
        raw["model"] = v

    # Permission mode
    if v := _env_str("nanocrew_PERMISSION_MODE"):
        raw.setdefault("permissions", {})["mode"] = v

    # Security posture
    if v := _env_str("NANOCREW_SECURITY_POSTURE") or _env_str("nanocrew_SECURITY_POSTURE"):
        raw.setdefault("security", {})["posture"] = v

    # Compaction
    if v := _env_str("nanocrew_COMPACT_THRESHOLD"):
        raw.setdefault("compaction", {})["threshold_tokens"] = int(v)
    if v := _env_str("nanocrew_COMPACT_TAIL"):
        raw.setdefault("compaction", {})["keep_tail"] = int(v)

    # Telemetry
    if v := _env_str("nanocrew_LOG_DIR"):
        raw.setdefault("telemetry", {})["log_dir"] = v
    if v := _env_str("nanocrew_TELEMETRY_REDACT_CONTENT"):
        raw.setdefault("telemetry", {})["redact_content"] = v.lower() in ("1", "true", "yes")
