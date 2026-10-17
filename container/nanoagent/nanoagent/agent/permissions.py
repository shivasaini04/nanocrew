"""Permission modes, policy engine, prompters, and workspace path enforcement.

Three cooperating pieces (mirrors claw-code permission_enforcer.rs / permissions.rs):

1. ``PermissionMode``  — coarse tier: ReadOnly < WorkspaceWrite < DangerFullAccess.
2. ``PermissionPolicy`` — rule engine: allow / deny / ask, glob-matched per tool.
3. ``WorkspaceEnforcer`` — hard filesystem boundary; enforced *after* policy so
   a blanket-allow rule still cannot escape the workspace.
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
from dataclasses import dataclass, field
from enum import IntEnum
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from nanoagent.agent.security import SecurityPosture, check_hard_deny, requires_strict_approval


# ---------------------------------------------------------------------------
# Permission tier
# ---------------------------------------------------------------------------

class PermissionMode(IntEnum):
    """Coarse permission tier.

    Ordered: ``ReadOnly < WorkspaceWrite < DangerFullAccess``.
    ``Prompt`` and ``Allow`` are special modes outside the numeric ordering.
    """

    ReadOnly = 0
    WorkspaceWrite = 1
    DangerFullAccess = 2
    Prompt = 10   # Always ask the user, regardless of tier
    Allow = 99    # Blanket yes — only for Docker containers / test harnesses


# ---------------------------------------------------------------------------
# Decision + rules
# ---------------------------------------------------------------------------

class PermissionDecision:
    Allow = "allow"
    Deny = "deny"
    Ask = "ask"


@dataclass
class PolicyRule:
    """Single allow/deny/ask rule with a glob pattern.

    Pattern format: ``tool_name`` or ``tool_name:input_fragment``.
    Examples::

        PolicyRule("deny",  "exec:rm -rf*")
        PolicyRule("ask",   "exec:*")
        PolicyRule("allow", "read_file:*")
    """

    decision: str  # "allow" | "deny" | "ask"
    pattern: str   # glob over "tool_name" or "tool_name:serialised_args[:200]"


# ---------------------------------------------------------------------------
# Prompters
# ---------------------------------------------------------------------------

@runtime_checkable
class Prompter(Protocol):
    """Async protocol for prompting the user about a pending tool call."""

    async def ask(self, tool: str, args: dict[str, Any], reason: str) -> bool:
        """Return ``True`` to allow, ``False`` to deny."""
        ...


class CliPrompter:
    """Interactive stdin prompter for CLI sessions."""

    async def ask(self, tool: str, args: dict[str, Any], reason: str) -> bool:
        args_preview = json.dumps(args, ensure_ascii=False)[:200]
        print(f"\n[Permission required] {tool}({args_preview})")
        if reason:
            print(f"  Reason: {reason}")
        try:
            answer = input("  Allow? [y/N]: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False
        return answer in ("y", "yes")


class DashboardPrompter:
    """Emits a pending-permission event to the dashboard without waiting.

    Kept for callers that only want the notification. It cannot approve anything,
    so it always denies — use ``HostApprovalPrompter`` for a real decision.
    """

    def __init__(self, emit_callback) -> None:
        self._emit = emit_callback

    async def ask(self, tool: str, args: dict[str, Any], reason: str) -> bool:
        await self._emit({
            "type": "permission_required",
            "tool": tool,
            "args": args,
            "reason": reason,
        })
        return False


class HostApprovalPrompter:
    """Blocks the cycle on a real human decision, taken in the dashboard.

    Posts the pending call to the orchestrator, then polls until somebody answers
    or the wait budget runs out. Three properties matter:

    * **Default deny.** A timeout, a transport error, or an unreachable host all
      resolve to "no". The failure mode of an approval gate must be refusing work,
      never performing it unreviewed.
    * **Bounded.** The wait is capped well under the cycle timeout, so a request
      nobody answers ends the tool call rather than holding the container open.
    * **Argument preview only.** The full arguments can carry file contents and
      secrets; the human sees a truncated preview, and the orchestrator stores
      that preview rather than the raw payload.
    """

    DEFAULT_WAIT_SECONDS = 300.0
    POLL_INTERVAL_SECONDS = 2.0
    _PREVIEW_LIMIT = 300

    def __init__(
        self,
        agent_id: str,
        host: str,
        cycle_id: str | None = None,
        wait_seconds: float | None = None,
        http_client_factory=None,
    ) -> None:
        self._agent_id = agent_id
        self._host = host.rstrip("/")
        self._cycle_id = cycle_id
        self._wait_seconds = wait_seconds if wait_seconds is not None else self.DEFAULT_WAIT_SECONDS
        self._client_factory = http_client_factory

    def _preview(self, args: dict[str, Any]) -> str:
        try:
            rendered = json.dumps(args, ensure_ascii=False, default=str)
        except (TypeError, ValueError):
            rendered = str(args)
        if len(rendered) > self._PREVIEW_LIMIT:
            return rendered[: self._PREVIEW_LIMIT] + f"… (+{len(rendered) - self._PREVIEW_LIMIT} chars)"
        return rendered

    def _client(self):
        if self._client_factory is not None:
            return self._client_factory()
        import httpx
        return httpx.AsyncClient(timeout=10.0)

    async def ask(self, tool: str, args: dict[str, Any], reason: str) -> bool:
        loop = asyncio.get_running_loop()
        base = f"{self._host}/api/agents/{self._agent_id}/tool-approvals"
        try:
            async with self._client() as client:
                created = await client.post(base, json={
                    "tool": tool,
                    "args_preview": self._preview(args),
                    "reason": reason,
                    "cycle_id": self._cycle_id,
                })
                if not created.is_success:
                    return False
                approval_id = created.json().get("id")
                if not approval_id:
                    return False

                deadline = loop.time() + self._wait_seconds
                while loop.time() < deadline:
                    await asyncio.sleep(self.POLL_INTERVAL_SECONDS)
                    polled = await client.get(f"{base}/{approval_id}")
                    if not polled.is_success:
                        continue
                    status = polled.json().get("status")
                    if status == "approved":
                        return True
                    if status in ("denied", "expired"):
                        return False

                # Nobody answered in time. Tell the orchestrator so the request
                # stops sitting in the inbox as if it were still live.
                try:
                    await client.post(f"{base}/{approval_id}/expire", json={})
                except Exception:
                    pass
                return False
        except Exception:
            return False


# ---------------------------------------------------------------------------
# Policy engine
# ---------------------------------------------------------------------------

class PermissionPolicy:
    """Rule-based permission engine.

    Evaluation order (mirrors claw-code permissions.rs ``authorize_with_context``,
    with the predeclared floor from ``security.py`` in front):

    0. Predeclared hard-deny match → ``Deny``. Unliftable by mode or posture.
    1. Strict posture + effectful tool → prompt user.
    2. First deny rule match → ``Deny`` (terminal).
    3. First ask rule match → prompt user.
    4. First allow rule match OR ``active_mode >= required_mode`` → ``Allow``.
    5. Needs escalation → prompt if prompter available, else ``Deny``.

    Rules are glob-matched against ``tool_name`` *and* against
    ``tool_name:serialised_args[:200]`` so patterns like ``exec:git *`` work.

    Settings file format (``.nanocrew/settings.json``)::

        {
          "permissions": {
            "mode": "workspace_write",
            "rules": [
              {"decision": "deny",  "pattern": "exec:rm -rf*"},
              {"decision": "ask",   "pattern": "exec:*"},
              {"decision": "allow", "pattern": "read_file:*"}
            ]
          }
        }
    """

    def __init__(
        self,
        active_mode: PermissionMode = PermissionMode.WorkspaceWrite,
        rules: list[PolicyRule] | None = None,
        prompter: Prompter | None = None,
        posture: SecurityPosture | None = None,
    ) -> None:
        self._mode = active_mode
        self._rules = rules or []
        self._prompter = prompter
        self._posture = posture if posture is not None else SecurityPosture.from_env()

    @property
    def posture(self) -> SecurityPosture:
        return self._posture

    @classmethod
    def from_settings(
        cls,
        settings_path: Path,
        prompter: Prompter | None = None,
    ) -> "PermissionPolicy":
        """Load policy from ``.nanocrew/settings.json``.  Falls back to safe defaults."""
        rules: list[PolicyRule] = []
        active_mode = PermissionMode.WorkspaceWrite
        posture = SecurityPosture.from_env()

        if settings_path.exists():
            try:
                data = json.loads(settings_path.read_text(encoding="utf-8"))
                perm = data.get("permissions", {})
                if "posture" in data.get("security", {}):
                    posture = SecurityPosture.parse(data["security"]["posture"])
                for entry in perm.get("rules", []):
                    rules.append(PolicyRule(
                        decision=entry["decision"],
                        pattern=entry["pattern"],
                    ))
                mode_map = {
                    "read_only": PermissionMode.ReadOnly,
                    "workspace_write": PermissionMode.WorkspaceWrite,
                    "danger_full_access": PermissionMode.DangerFullAccess,
                    "prompt": PermissionMode.Prompt,
                    "allow": PermissionMode.Allow,
                }
                active_mode = mode_map.get(
                    perm.get("mode", "workspace_write"),
                    PermissionMode.WorkspaceWrite,
                )
            except Exception:
                pass  # Corrupt settings → safe defaults

        return cls(active_mode=active_mode, rules=rules, prompter=prompter, posture=posture)

    @property
    def mode(self) -> PermissionMode:
        return self._mode

    async def authorize(
        self,
        tool_name: str,
        args: dict[str, Any],
        required_mode: PermissionMode,
    ) -> tuple[str, str]:
        """Return ``(decision, reason)``.

        Decision is one of ``PermissionDecision.Allow`` or ``PermissionDecision.Deny``.
        """
        # Rule zero: predeclared denials. Evaluated before the blanket-allow
        # short-circuit and before the tier check, so no permission mode and no
        # security posture — Dangerous included — can lift them.
        violated = check_hard_deny(tool_name, args)
        if violated is not None:
            return PermissionDecision.Deny, f"hard deny rule: {violated}"

        # Strict posture pauses calls that reach outside the workspace, whatever
        # the tier says. Ordinary work — reads, workspace writes, running tests —
        # still goes through unattended, because an approval queue nobody can keep
        # up with gets rubber-stamped.
        if self._posture is SecurityPosture.Strict:
            strict_reason = requires_strict_approval(tool_name, args)
            if strict_reason is not None:
                allowed = await self._prompt(tool_name, args, strict_reason)
                return (
                    PermissionDecision.Allow if allowed else PermissionDecision.Deny,
                    f"strict posture approval: {strict_reason}",
                )

        # Blanket allow (Docker/CI/test)
        if self._mode == PermissionMode.Allow:
            return PermissionDecision.Allow, "blanket allow mode"

        subject = f"{tool_name}:{json.dumps(args, ensure_ascii=False)[:200]}"

        for rule in self._rules:
            if fnmatch.fnmatch(tool_name, rule.pattern) or fnmatch.fnmatch(subject, rule.pattern):
                if rule.decision == PermissionDecision.Deny:
                    return PermissionDecision.Deny, f"matched deny rule: {rule.pattern}"
                if rule.decision == PermissionDecision.Ask:
                    allowed = await self._prompt(tool_name, args, f"matched ask rule: {rule.pattern}")
                    return (
                        PermissionDecision.Allow if allowed else PermissionDecision.Deny,
                        f"ask rule: {rule.pattern}",
                    )
                if rule.decision == PermissionDecision.Allow:
                    return PermissionDecision.Allow, f"matched allow rule: {rule.pattern}"

        # Always-prompt mode
        if self._mode == PermissionMode.Prompt:
            allowed = await self._prompt(tool_name, args, "active mode is Prompt")
            return (
                PermissionDecision.Allow if allowed else PermissionDecision.Deny,
                "prompt mode",
            )

        # Tier check
        if required_mode <= self._mode:
            return PermissionDecision.Allow, f"mode {self._mode.name} >= required {required_mode.name}"

        # Needs escalation
        if self._prompter:
            allowed = await self._prompt(tool_name, args, f"requires {required_mode.name}")
            return (
                PermissionDecision.Allow if allowed else PermissionDecision.Deny,
                "escalation prompt",
            )

        return (
            PermissionDecision.Deny,
            f"active mode {self._mode.name} is insufficient for {required_mode.name}",
        )

    async def _prompt(self, tool: str, args: dict[str, Any], reason: str) -> bool:
        if self._prompter:
            return await self._prompter.ask(tool, args, reason)
        return False


# ---------------------------------------------------------------------------
# Workspace enforcer
# ---------------------------------------------------------------------------

@dataclass
class WorkspaceEnforcer:
    """Hard filesystem boundary for file operations.

    Runs *after* policy checks — even a blanket-allow policy cannot escape
    the workspace through here.

    Checks:
    - Target path resolves inside ``workspace``.
    - If path is a symlink, its realpath also stays inside ``workspace``.
    """

    workspace: Path

    def check(self, path: str | Path) -> tuple[bool, str]:
        """Return ``(ok, error_message)``.  ``error_message`` is empty when ok."""
        try:
            target = Path(path).expanduser()
            if not target.is_absolute():
                target = self.workspace / target
            resolved = target.resolve()
        except Exception as exc:
            return False, f"Cannot resolve path {path!r}: {exc}"

        workspace_resolved = self.workspace.resolve()

        try:
            resolved.relative_to(workspace_resolved)
        except ValueError:
            return False, f"Path {path!r} is outside the workspace ({workspace_resolved})"

        # Symlink escape: if the path itself is a symlink, its target must
        # also be inside the workspace.
        try:
            raw = Path(path).expanduser()
            if not raw.is_absolute():
                raw = self.workspace / raw
            if raw.is_symlink():
                link_target = raw.resolve()
                link_target.relative_to(workspace_resolved)
        except ValueError:
            return False, f"Symlink {path!r} escapes the workspace"
        except Exception:
            pass  # Non-existent paths are fine — the tool will fail on its own

        return True, ""
