"""Gap-closing pass, 2026-08-23: success/cost measurement across an agent's Effector
runs. Reads persisted checkpoints (resilience/checkpoint.py) rather than keeping its
own log — the checkpoint IS the record of what a run did, so there's nothing to
duplicate or fall out of sync.

Deliberately no dollar figure here — same boundary as EffectorExecutionResult.usage:
raw token counts only, pricing stays orchestrator-side.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from nanoagent.agent.effector.resilience.checkpoint import RunCheckpoint, list_all_checkpoints

_USAGE_FIELDS = (
    "prompt_tokens", "completion_tokens", "total_tokens",
    "cache_creation_input_tokens", "cache_read_input_tokens",
    "prompt_cache_hit_tokens", "prompt_cache_miss_tokens",
)


@dataclass
class EffectorMetrics:
    total_runs: int = 0
    completed: int = 0
    failed: int = 0
    in_progress: int = 0  # running/paused/takeover — not yet a success or a failure
    success_rate: float | None = None  # completed / (completed + failed); None if none finished
    avg_turns: float | None = None
    avg_total_tokens: float | None = None
    total_usage: dict = field(default_factory=lambda: {f: 0 for f in _USAGE_FIELDS})
    by_domain: dict[str, "EffectorMetrics"] = field(default_factory=dict)


def _empty_usage() -> dict:
    return {f: 0 for f in _USAGE_FIELDS}


def _summarize(checkpoints: list[RunCheckpoint]) -> EffectorMetrics:
    m = EffectorMetrics(total_usage=_empty_usage())
    turns_sum = 0
    tokens_sum = 0
    finished = 0

    for cp in checkpoints:
        m.total_runs += 1
        if cp.status == "completed":
            m.completed += 1
        elif cp.status == "failed":
            m.failed += 1
        else:
            m.in_progress += 1

        turns_sum += cp.current_turn
        for f in _USAGE_FIELDS:
            m.total_usage[f] += cp.usage.get(f, 0) if cp.usage else 0
        tokens_sum += (cp.usage or {}).get("total_tokens", 0)

    finished = m.completed + m.failed
    if finished > 0:
        m.success_rate = m.completed / finished
    if m.total_runs > 0:
        m.avg_turns = turns_sum / m.total_runs
        m.avg_total_tokens = tokens_sum / m.total_runs

    return m


def aggregate_run_metrics(workspace: Path, run_ids: list[str] | None = None) -> EffectorMetrics:
    """Aggregate every checkpoint under `workspace`, optionally restricted to
    `run_ids`. Also buckets by `session_domain` so "how does Effector do on
    linkedin.com specifically" is answerable without a separate query."""
    checkpoints = list_all_checkpoints(workspace)
    if run_ids is not None:
        wanted = set(run_ids)
        checkpoints = [cp for cp in checkpoints if cp.run_id in wanted]

    overall = _summarize(checkpoints)

    by_domain: dict[str, list[RunCheckpoint]] = {}
    for cp in checkpoints:
        domain = cp.session_domain or "unknown"
        by_domain.setdefault(domain, []).append(cp)
    overall.by_domain = {domain: _summarize(cps) for domain, cps in by_domain.items()}

    return overall


# ─── Stage 61 phase 0: step timings from decision_log.py ─────────────────────────

_TIMING_FIELDS = {
    "decision": ("throttle_ms", "snapshot_ms", "settle_ms", "capture_ms", "prep_ms", "decision_ms"),
    "outcome": ("execute_ms", "turn_ms"),
    "run": ("session_ms", "first_page_ms", "challenge_ms", "pre_loop_other_ms",
            "loop_ms", "post_loop_ms", "teardown_ms", "total_ms"),
}


def _percentile(values: list[int], pct: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(pct / 100 * (len(ordered) - 1))))
    return ordered[index]


@dataclass
class StepTimings:
    decisions: int = 0
    failed_decisions: int = 0  # the model's reply could not be used
    outcomes: dict[str, int] = field(default_factory=dict)  # step status -> count
    actions: dict[str, int] = field(default_factory=dict)   # chosen action -> count
    models: dict[str, int] = field(default_factory=dict)    # decision model -> count
    escalated: int = 0
    with_screenshot: int = 0
    # field -> {"p50": ms, "p95": ms, "n": count}
    timings: dict[str, dict[str, int | None]] = field(default_factory=dict)


def aggregate_step_timings(workspace: Path, run_ids: list[str] | None = None) -> StepTimings:
    """Where Effector's time goes, per step, across every recorded run (or just
    `run_ids`). The phase-0 baseline every later decider is measured against."""
    from nanoagent.agent.effector.decision_log import read_records

    records = read_records(workspace)
    if run_ids is not None:
        wanted = set(run_ids)
        records = [r for r in records if r.get("run_id") in wanted]

    t = StepTimings()
    values: dict[str, list[int]] = {f: [] for fs in _TIMING_FIELDS.values() for f in fs}
    for r in records:
        kind = r.get("type")
        if kind == "decision":
            t.decisions += 1
            if r.get("error"):
                t.failed_decisions += 1
            action = (r.get("action") or {}).get("action")
            if action:
                t.actions[action] = t.actions.get(action, 0) + 1
            model = r.get("model") or "unknown"
            t.models[model] = t.models.get(model, 0) + 1
            t.escalated += bool(r.get("escalated"))
            t.with_screenshot += bool(r.get("screenshot"))
        elif kind == "outcome":
            status = r.get("status") or "unknown"
            t.outcomes[status] = t.outcomes.get(status, 0) + 1
        for f in _TIMING_FIELDS.get(kind, ()):
            if isinstance(r.get(f), int):
                values[f].append(r[f])

    t.timings = {
        f: {"p50": _percentile(v, 50), "p95": _percentile(v, 95), "n": len(v)}
        for f, v in values.items()
    }
    return t


def format_report(workspace: Path) -> str:
    runs = aggregate_run_metrics(workspace)
    steps = aggregate_step_timings(workspace)
    lines = [
        f"Runs: {runs.total_runs}  completed: {runs.completed}  failed: {runs.failed}  "
        f"in progress: {runs.in_progress}  success rate: "
        + (f"{runs.success_rate:.0%}" if runs.success_rate is not None else "n/a"),
        f"Avg turns/run: {runs.avg_turns if runs.avg_turns is not None else 'n/a'}  "
        f"avg tokens/run: {runs.avg_total_tokens if runs.avg_total_tokens is not None else 'n/a'}",
        "",
        f"Decisions: {steps.decisions}  failed: {steps.failed_decisions}  "
        f"escalated: {steps.escalated}  with screenshot: {steps.with_screenshot}",
        f"Models: {steps.models}",
        f"Actions: {steps.actions}",
        f"Step outcomes: {steps.outcomes}",
        "",
        "Timing per step (ms):   p50     p95     n",
    ]
    for name, stat in steps.timings.items():
        lines.append(f"  {name:<18} {str(stat['p50']):>7} {str(stat['p95']):>7} {stat['n']:>5}")
    lines.append("")
    lines.append("Success rate is from checkpoints (the run's own 'done' after its goal check),")
    lines.append("not an independent check — see phase0-baseline.md.")
    return "\n".join(lines)


if __name__ == "__main__":
    import sys

    print(format_report(Path(sys.argv[1] if len(sys.argv) > 1 else ".")))
