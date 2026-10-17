"""Stage 61 phase 0: one record per Effector decision and one per executed step,
with timings.

Two jobs. First, the baseline: nobody had measured how long an Effector step takes
or where that time goes (snapshot, model, execution), so every "faster" claim for a
new decider had nothing to be compared against. Second, replay: each decision record
keeps the element table and the exact prompt the model saw, so a different decider
(Jev, phase 1) can be scored against the same turns offline — no extra live runs, no
risk to a real page.

Written under workspace/.effector/decisions/<run_id>.jsonl, beside the action log and
checkpoints (same `.effector/` convention). Best-effort like the action log: a failed
write is a lost record, never a failed turn.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from loguru import logger

# Big pages produce big element tables. Enough to replay a decision; bounded so one
# run's log stays a few MB at most.
_MAX_TEXT_CHARS = 30_000

# The action fields a replay needs. `text` is left out when a credential_ref is set —
# the executor swaps the secret in later, but a record must never be the place it
# first gets written down.
_ACTION_FIELDS = (
    "action", "target", "text", "url", "key", "value", "direction",
    "credential_ref", "accept_dialog",
)


def _decisions_dir(workspace: Path) -> Path:
    return Path(workspace) / ".effector" / "decisions"


def _log_path(workspace: Path, run_id: str) -> Path:
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in run_id)
    d = _decisions_dir(workspace)
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{safe}.jsonl"


def _cap(text: str | None) -> str | None:
    if text is None:
        return None
    return text if len(text) <= _MAX_TEXT_CHARS else text[:_MAX_TEXT_CHARS] + "…[truncated]"


def _ms(start: float | None, end: float | None) -> int | None:
    if start is None or end is None:
        return None
    return int((end - start) * 1000)


def action_fields(action_dict: dict[str, Any]) -> dict[str, Any]:
    out = {k: action_dict.get(k) for k in _ACTION_FIELDS if action_dict.get(k) is not None}
    if out.get("credential_ref"):
        out.pop("text", None)
    return out


def append_record(workspace: Path | None, run_id: str, record: dict[str, Any]) -> None:
    if workspace is None:
        return
    try:
        record = {"ts": datetime.now(timezone.utc).isoformat(), "run_id": run_id, **record}
        with _log_path(workspace, run_id).open("a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    except Exception as err:  # noqa: BLE001
        logger.debug(f"effector: decision log write failed — {err}")


def record_decision(
    workspace: Path | None,
    run_id: str,
    *,
    turn: int,
    goal: str,
    url: str,
    model: str | None,
    escalated: bool,
    screenshot: bool,
    elements: str | None,
    prompt: str | None,
    action_dict: dict[str, Any] | None,
    thought: str | None,
    t_turn: float | None,
    t_throttled: float | None,
    t_settled: float | None,
    t_snapshot: float | None,
    t_decision_start: float | None,
    t_decision_end: float | None,
    error: str | None = None,
) -> None:
    append_record(workspace, run_id, {
        "type": "decision",
        "turn": turn,
        "goal": goal,
        "url": url,
        "model": model,
        "escalated": escalated,
        "screenshot": screenshot,
        "elements": _cap(elements),
        "prompt": _cap(prompt),
        "action": action_fields(action_dict) if action_dict else None,
        "thought": thought,
        "error": error,
        "throttle_ms": _ms(t_turn, t_throttled),
        # snapshot_ms = settle_ms + capture_ms: waiting for the page to go quiet, then
        # reading and pruning it. Split because they are fixed in different places.
        "snapshot_ms": _ms(t_throttled, t_snapshot),
        "settle_ms": _ms(t_throttled, t_settled),
        "capture_ms": _ms(t_settled, t_snapshot),
        # Everything between having the page and asking the model: challenge check,
        # injection scan, steering notes, prompt building.
        "prep_ms": _ms(t_snapshot, t_decision_start),
        "decision_ms": _ms(t_decision_start, t_decision_end),
    })


def record_outcome(
    workspace: Path | None,
    run_id: str,
    *,
    turn: int,
    status: str | None,
    error: str | None,
    url_after: str | None,
    resolved_target: Any,
    t_turn: float | None,
    t_execute_start: float | None,
    t_execute_end: float | None,
    t_end: float | None,
) -> None:
    append_record(workspace, run_id, {
        "type": "outcome",
        "turn": turn,
        "status": status,
        "error": error,
        "url_after": url_after,
        "resolved_target": resolved_target,
        "execute_ms": _ms(t_execute_start, t_execute_end),
        "turn_ms": _ms(t_turn, t_end),
    })


def read_records(workspace: Path, run_id: str | None = None) -> list[dict[str, Any]]:
    """Every record for one run, or for all runs when run_id is None. A corrupt line is
    skipped rather than failing the whole read."""
    d = _decisions_dir(workspace)
    if not d.exists():
        return []
    if run_id is not None:
        paths = [_log_path(workspace, run_id)]
    else:
        paths = sorted(d.glob("*.jsonl"))
    records: list[dict[str, Any]] = []
    for path in paths:
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


# Consecutive marks set by EffectorTool.execute, and the span each pair measures.
_RUN_SPANS = (
    ("session_ms", "start", "session"),        # browser + context launch, stealth setup
    ("first_page_ms", "session", "navigated"),  # the starting URL loading
    ("challenge_ms", "navigated", "challenge"),  # anti-bot challenge check on that page
    ("loop_ms", "loop_start", "loop_end"),      # every turn of the react loop
    ("post_loop_ms", "loop_end", "post_loop"),   # download drain, firewall, audit ledger
    ("teardown_ms", "post_loop", "end"),        # closing the session
    ("total_ms", "start", "end"),
)


def run_timings(marks: dict[str, float]) -> dict[str, int | None]:
    out = {name: _ms(marks.get(a), marks.get(b)) for name, a, b in _RUN_SPANS}
    # Whatever sits between the session being up and the loop starting that the named
    # spans above did not cover (no starting URL, capability probing, live view setup).
    pre = marks.get("challenge") or marks.get("navigated") or marks.get("session")
    out["pre_loop_other_ms"] = _ms(pre, marks.get("loop_start"))
    return out


def record_run_timings(
    workspace: Path | None,
    run_id: str,
    marks: dict[str, float],
    *,
    engine: str | None = None,
    warm_browser: bool | None = None,
) -> dict[str, int | None]:
    """Write the run's spans, and what produced them.

    `engine` and `warm_browser` are recorded next to the numbers because `session_ms`
    means nothing on its own: 5.5 s is a camoufox launch, 1.6 s is a Chromium launch and
    0.2 s is a warm browser handing over a tab. A timing table that mixes them is
    comparing three different things and reporting one median.
    """
    timings = run_timings(marks)
    record: dict[str, Any] = {"type": "run", **timings}
    if engine is not None:
        record["engine"] = engine
    if warm_browser is not None:
        record["warm_browser"] = bool(warm_browser)
    append_record(workspace, run_id, record)
    return timings
