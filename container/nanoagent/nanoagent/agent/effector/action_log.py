"""Ported from computer-use/action-log.ts, adapted for this package's own storage
convention. The kept TS-side `action-log.ts` (src/agents/runtime/computer-use/,
per stage43 doc 03) still backs the dashboard's direct-run route under `agentsDir`
— an orchestrator-owned path. This is Effector's own copy for its own runs
(react_loop/executor, not the static-step-list `/run` route), written under
`workspace/.effector/logs/` — the agent's own workspace, per this package's
established `.effector/` convention (browser_session.py's sessions,
resilience/checkpoint.py's checkpoints).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from nanoagent.agent.effector.types import Step, StepResult

_DANGER_RE = re.compile(r"delete|remove|cancel|close-account|submit|send|pay|confirm|buy", re.IGNORECASE)


def classify_step(step: Step) -> str:
    """Classify an action step as 'read' / 'write' / 'external'."""
    if step.is_external:
        return "external"

    if step.action in ("navigate", "screenshot", "wait"):
        return "read"
    if step.action in ("type", "select", "clear"):
        return "write"
    if step.action in ("click", "right_click", "double_click"):
        if step.target and _DANGER_RE.search(step.target):
            return "external"
        return "write"
    return "write"


@dataclass
class ActionLogEntry:
    run_id: str
    agent_id: str
    step: int
    timestamp: str
    action: dict[str, Any]
    classification: str
    approval_status: str
    result: dict[str, Any]
    operator_visible: bool = True


def build_log_entry(
    step: Step,
    result: StepResult,
    run_id: str,
    agent_id: str,
    approval_status: str = "auto-approved",
) -> ActionLogEntry:
    # `approval_status` is the caller's business because only the caller ran the gate.
    #
    # Stage 49 phase 1: this was a hardcoded "auto-approved" literal, so the signed
    # ledger recorded a human-approved click identically to one nobody was asked
    # about. Proven live 2026-09-02 a live cycle: the "Send it →" click sat 2m53s
    # waiting for an operator, `escalation_approvals` recorded `decided_by: operator`,
    # and this file wrote "auto-approved" beside it. The default stays "auto-approved"
    # because an ungated step genuinely is — every gated call site passes the real
    # outcome via escalation.ledger_status().
    # Never log credential values — replace with a redaction marker, same as the
    # TS original (this matters more here than there: credential_inject.py mutates
    # the in-memory Step to carry the resolved plaintext, so this check is the only
    # thing standing between a real credential and a persisted NDJSON line).
    logged_text = "[CREDENTIAL_REDACTED]" if step.credential_ref else step.text

    return ActionLogEntry(
        run_id=run_id, agent_id=agent_id, step=step.step,
        timestamp=datetime.now(timezone.utc).isoformat(),
        action={
            "type": step.action, "target": step.target, "text": logged_text,
            "url": step.url, "key": step.key, "value": step.value,
            "extract_schema": step.extract_schema,
            # The vault KEY, never the secret — logging it is what lets a distilled
            # macro re-resolve the credential live on replay instead of carrying
            # either a plaintext password or the "[CREDENTIAL_REDACTED]" marker
            # forward as if it were the real value.
            "credential_ref": step.credential_ref,
        },
        classification=classify_step(step),
        approval_status=approval_status,
        result={
            "status": result.status, "url_after": result.url_after, "error": result.error,
            # The durable identity of the element this step actually acted on, recorded
            # by the executor at resolution time. Without it the log holds only the @ref
            # the model named, which means nothing outside the one snapshot it was
            # planned against — so nothing downstream could replay this run.
            "resolved_target": result.resolved_target,
        },
        operator_visible=True,
    )


def _log_path(workspace: Path, run_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in run_id)
    d = Path(workspace) / ".effector" / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.ndjson"


def append_action_log(workspace: Path, run_id: str, entry: ActionLogEntry) -> None:
    path = _log_path(workspace, run_id)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry.__dict__, ensure_ascii=False) + "\n")


def read_action_log(workspace: Path, run_id: str) -> list[dict[str, Any]]:
    path = _log_path(workspace, run_id)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
