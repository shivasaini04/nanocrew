"""Ported from computer-use/checkpoint.ts. Task-level step cursor, idempotency
ledger, and resume support for a long-running Effector task.

Storage note (the actual point of doing this in Python, not a port detail): the TS
original persisted under the orchestrator's `agentsDir` — outside any agent's own
workspace, since it ran in the TS control plane. Here, checkpoints live under
`workspace/.effector/checkpoints/<run_id>.json` — inside the agent's own workspace —
so they ride the existing per-turn shadow-git snapshot (`agent/checkpoints.py`) for
free instead of needing their own versioning/backup mechanism. Only the step-cursor
logic itself is new; the durability comes from infrastructure that already exists.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, TypeVar

from loguru import logger

from nanoagent.agent.effector.types import DOMSnapshot, EffectorTurnLog, Step, StepResult

RunStatus = Literal["running", "paused", "takeover", "completed", "failed"]


@dataclass
class DeadLetterEntry:
    item: str
    reason: str
    timestamp: str
    turn: int | None = None


@dataclass
class RunCheckpoint:
    run_id: str
    agent_id: str
    goal: str
    status: RunStatus = "running"
    current_turn: int = 0
    max_turns: int = 20
    session_domain: str | None = None
    last_url: str | None = None
    completed_items: list[str] = field(default_factory=list)
    executed_idempotency_keys: list[str] = field(default_factory=list)
    dead_letter_items: list[DeadLetterEntry] = field(default_factory=list)
    extracted_data: dict[str, Any] = field(default_factory=dict)
    turns: list[EffectorTurnLog] = field(default_factory=list)
    # Gap-closing pass, 2026-08-23: aggregated token usage, same 7-field shape as
    # EffectorExecutionResult.usage — persisted so a resumed run's totals include
    # tokens spent before the pause, not just the tokens spent after resuming.
    usage: dict[str, int] = field(default_factory=lambda: {
        "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
        "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
    })
    # God-level pillar 05, 2026-08-23: the goal's decomposed checklist, decided
    # once and reused across a resume rather than re-decomposed (and possibly
    # re-worded) every time the same run_id continues.
    goal_checklist: list[str] | None = None
    created_at: str = ""
    updated_at: str = ""

    def __post_init__(self):
        now = datetime.now(timezone.utc).isoformat()
        if not self.created_at:
            self.created_at = now
        if not self.updated_at:
            self.updated_at = now


_MUTATING_ACTIONS = frozenset({"click", "type", "upload", "select", "clear", "select_combobox"})


def _stable_target_identity(target: str | None, snapshot: DOMSnapshot | None) -> str:
    """@ref tags (e.g. "@e15") are reassigned fresh every DOM snapshot by
    document-order index — the same label can point at a completely different
    element on a later turn. Found live, 2026-08-23: "click @e15" at turn 9
    selected a State dropdown option (NCR); "click @e15" at turn 14 selected a
    DIFFERENT, later-rendered City dropdown option (Delhi) — two genuinely
    different real-world actions, colliding only because the label was recycled.
    The idempotency ledger silently skipped the second one, believing it had
    already run. Resolve to the element's own selector (id/name/class-derived —
    stable across snapshots because it's derived from the element's actual DOM
    identity, not its transient position in that snapshot's element list)
    before it becomes part of the identity. Falls back to the raw target when
    it isn't a @ref (already stable — a real CSS selector or literal text
    doesn't get reassigned between snapshots) or no snapshot is available to
    resolve against."""
    if not target:
        return ""
    if snapshot is not None:
        from nanoagent.agent.effector.dom_snapshot import find_element_by_ref, is_ref_tag
        if is_ref_tag(target):
            element = find_element_by_ref(target, snapshot)
            if element is not None:
                return element.selector
    return target


def compute_idempotency_key(
    step: Step, run_id: str, current_url: str = "", snapshot: DOMSnapshot | None = None,
) -> str:
    """Deterministic key for a step's external side effect — the same click/type
    resolved from a resumed run never fires twice. `snapshot` (the current
    turn's DOM snapshot, when available) lets a @ref target resolve to a stable
    identity instead of its raw, recyclable label — see _stable_target_identity."""
    payload = json.dumps({
        "runId": run_id,
        "action": step.action,
        "target": _stable_target_identity(step.target, snapshot),
        "text": step.text or "",
        "key": step.key or "",
        "value": step.value or "",
        "filePath": step.file_path or "",
        "filePaths": step.file_paths or [],
        "url": step.url or current_url,
    }, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()


def is_action_already_executed(
    checkpoint: RunCheckpoint, step: Step, current_url: str = "", snapshot: DOMSnapshot | None = None,
    prior_keys: frozenset[str] | None = None,
) -> bool:
    """Real bug, found live 2026-08-27: a click that resolved and dispatched fine
    but had zero observable effect (e.g. an ad overlay over demoqa.com's homepage
    cards silently absorbing the click) got recorded as "executed" after turn 1 —
    then every identical retry on turns 2+ of the SAME live run was silently
    vetoed forever, with no feedback telling the model why. The ledger's actual
    documented purpose (this module's docstring: "the same click/type resolved
    from a RESUMED run never fires twice") is protecting against re-firing an
    action from a PRIOR PROCESS ATTEMPT after a crash+resume — not preventing a
    live model from retrying something that visibly didn't work yet within its
    own current run.

    `prior_keys`, when given, scopes the check to exactly that: keys that
    existed BEFORE this process's own turns began (react_loop.py's
    `checkpoint_prior_keys`, snapshotted once right after the checkpoint is
    loaded/created — empty for a fresh run, the persisted ledger for a resumed
    one). None (the default) preserves the old, whole-ledger check, for direct/
    unit-level callers that aren't running the full react_loop integration."""
    if step.action not in _MUTATING_ACTIONS:
        return False  # read-only/navigation actions can always be re-evaluated
    key = compute_idempotency_key(step, checkpoint.run_id, current_url, snapshot)
    keys = checkpoint.executed_idempotency_keys if prior_keys is None else prior_keys
    return key in keys


def record_executed_action(
    checkpoint: RunCheckpoint, step: Step, current_url: str = "", snapshot: DOMSnapshot | None = None,
) -> None:
    key = compute_idempotency_key(step, checkpoint.run_id, current_url, snapshot)
    if key not in checkpoint.executed_idempotency_keys:
        checkpoint.executed_idempotency_keys.append(key)


def record_dead_letter_item(checkpoint: RunCheckpoint, item: str, reason: str, turn: int | None = None) -> None:
    checkpoint.dead_letter_items.append(DeadLetterEntry(
        item=item, reason=reason, timestamp=datetime.now(timezone.utc).isoformat(), turn=turn,
    ))


T = TypeVar("T")


async def retry_with_exponential_backoff(
    fn: Callable[[], Awaitable[T]],
    max_retries: int = 3,
    base_delay_ms: int = 500,
    max_delay_ms: int = 8000,
    on_retry: Callable[[int, Exception, int], None] | None = None,
) -> T:
    """Full-jitter exponential backoff: delay = min(max, base * 2^attempt) * U(0.5, 1.0)."""
    last_error: Exception | None = None

    for attempt in range(1, max_retries + 1):
        try:
            return await fn()
        except Exception as err:
            last_error = err
            if attempt == max_retries:
                break
            raw_delay = min(max_delay_ms, base_delay_ms * (2 ** attempt))
            jitter_delay = round(raw_delay * (0.5 + random.random() * 0.5))
            if on_retry:
                on_retry(attempt, err, jitter_delay)
            logger.warning(f"effector checkpoint: retrying transient failure, attempt={attempt}/{max_retries} delay={jitter_delay}ms — {err}")
            await asyncio.sleep(jitter_delay / 1000)

    assert last_error is not None
    raise last_error


async def verify_session_health(page, domain: str | None = None) -> dict[str, Any]:
    """Lightweight check before resuming an older task: did we get redirected to a
    login/auth wall, or do we have no cookies at all for the target domain?"""
    try:
        current_url = page.url
        if any(marker in current_url for marker in ("/login", "/signin", "/auth", "/challenge")):
            return {"is_healthy": False, "reason": f"Page redirected to authentication: {current_url}"}

        urls = [f"https://{domain}"] if domain else None
        cookies = await page.context.cookies(urls) if urls else await page.context.cookies()
        if domain and not cookies:
            return {"is_healthy": False, "reason": f"No stored cookies found for domain {domain}"}

        return {"is_healthy": True}
    except Exception as err:
        return {"is_healthy": False, "reason": str(err)}


# ─── Persistence ────────────────────────────────────────────────────────────────

def _checkpoints_dir(workspace: Path) -> Path:
    d = Path(workspace) / ".effector" / "checkpoints"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _checkpoint_file(workspace: Path, run_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in run_id)
    return _checkpoints_dir(workspace) / f"{safe}.json"


def _turn_to_dict(t: EffectorTurnLog) -> dict[str, Any]:
    return {
        "turn": t.turn, "thought": t.thought,
        "action": asdict(t.action),
        "result": asdict(t.result) if t.result else None,
        "snapshot_summary": t.snapshot_summary, "self_healed": t.self_healed,
    }


def _turn_from_dict(d: dict[str, Any]) -> EffectorTurnLog:
    action = Step.from_dict(d["action"])
    result_d = d.get("result")
    result = StepResult(**result_d) if result_d else None
    return EffectorTurnLog(
        turn=d["turn"], thought=d.get("thought", ""), action=action, result=result,
        snapshot_summary=d.get("snapshot_summary"), self_healed=d.get("self_healed", False),
    )


def _checkpoint_sig_file(workspace: Path, run_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in run_id)
    return _checkpoints_dir(workspace) / f"{safe}.sig"


def save_checkpoint(workspace: Path, checkpoint: RunCheckpoint) -> None:
    try:
        checkpoint.updated_at = datetime.now(timezone.utc).isoformat()
        file = _checkpoint_file(workspace, checkpoint.run_id)
        data = asdict(checkpoint)
        data["turns"] = [_turn_to_dict(t) for t in checkpoint.turns]
        raw_json = json.dumps(data, indent=2, ensure_ascii=False)
        raw_bytes = raw_json.encode("utf-8")
        file.write_bytes(raw_bytes)

        # Cryptographic HMAC signature. Only meaningful with a real cycle secret: an
        # ephemeral per-process key cannot be reproduced by the process that resumes
        # this run, so signing with one would guarantee a verify failure on resume.
        # Skip the signature entirely in that case rather than write an unverifiable
        # one — get_checkpoint treats "no signature" as unverified-but-usable.
        from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger
        ledger = MerkleActionLedger()
        sig_file = _checkpoint_sig_file(workspace, checkpoint.run_id)
        if ledger.trusted:
            sig_file.write_text(ledger.sign_checkpoint(raw_bytes), encoding="utf-8")
        else:
            logger.warning(
                "effector checkpoint: no cycle token in the agent environment — "
                f"checkpoint {checkpoint.run_id} saved UNSIGNED (resume still works, "
                "on-disk tampering will not be detected)"
            )
            # A stale signature from an earlier trusted run would fail against this
            # unsigned content and silently discard a valid checkpoint.
            sig_file.unlink(missing_ok=True)
    except Exception as err:
        logger.warning(f"effector checkpoint: failed to save {checkpoint.run_id} — {err}")


def get_checkpoint(workspace: Path, run_id: str) -> RunCheckpoint | None:
    try:
        file = _checkpoint_file(workspace, run_id)
        if not file.exists():
            return None

        raw_bytes = file.read_bytes()
        sig_file = _checkpoint_sig_file(workspace, run_id)
        if sig_file.exists():
            from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger
            ledger = MerkleActionLedger()
            expected_sig = sig_file.read_text(encoding="utf-8").strip()
            if not ledger.trusted:
                # Signed by a process that had the cycle secret; this one doesn't. We
                # cannot distinguish tampering from a missing key, so don't claim
                # either — discarding a valid checkpoint would lose real work.
                logger.warning(
                    f"effector checkpoint: {run_id} carries a signature but no cycle token "
                    "is available to check it — resuming UNVERIFIED"
                )
            elif not ledger.verify_checkpoint(raw_bytes, expected_sig):
                logger.critical(f"effector checkpoint: TAMPERING DETECTED for checkpoint {run_id}. Signature verification failed!")
                return None

        data = json.loads(raw_bytes.decode("utf-8"))
        turns = [_turn_from_dict(t) for t in data.get("turns", [])]
        dead_letters = [DeadLetterEntry(**d) for d in data.get("dead_letter_items", [])]
        return RunCheckpoint(
            run_id=data["run_id"], agent_id=data["agent_id"], goal=data["goal"],
            status=data.get("status", "running"),
            current_turn=data.get("current_turn", 0), max_turns=data.get("max_turns", 20),
            session_domain=data.get("session_domain"), last_url=data.get("last_url"),
            completed_items=data.get("completed_items", []),
            executed_idempotency_keys=data.get("executed_idempotency_keys", []),
            dead_letter_items=dead_letters,
            extracted_data=data.get("extracted_data", {}),
            turns=turns,
            usage=data.get("usage") or {
                "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
                "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                "prompt_cache_hit_tokens": 0, "prompt_cache_miss_tokens": 0,
            },
            goal_checklist=data.get("goal_checklist"),
            created_at=data.get("created_at", ""), updated_at=data.get("updated_at", ""),
        )
    except Exception as err:
        logger.warning(f"effector checkpoint: failed to load {run_id} — {err}")
        return None


def list_all_checkpoints(workspace: Path) -> list[RunCheckpoint]:
    """Every checkpoint on disk regardless of status — the raw material for
    metrics.py's aggregation (success rate needs completed AND failed runs, not
    just the still-running ones list_interrupted_checkpoints returns)."""
    d = _checkpoints_dir(workspace)
    results: list[RunCheckpoint] = []
    for f in d.glob("*.json"):
        cp = get_checkpoint(workspace, f.stem)
        if cp:
            results.append(cp)
    return sorted(results, key=lambda cp: cp.updated_at, reverse=True)


def list_interrupted_checkpoints(workspace: Path) -> list[RunCheckpoint]:
    return [cp for cp in list_all_checkpoints(workspace) if cp.status in ("running", "paused", "takeover")]


def clear_checkpoint(workspace: Path, run_id: str) -> bool:
    file = _checkpoint_file(workspace, run_id)
    if file.exists():
        file.unlink()
        return True
    return False
