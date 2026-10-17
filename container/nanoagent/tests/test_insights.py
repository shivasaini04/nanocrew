""""This agent spent $2 today" is not actionable. Where the tokens went is.

Stage 42 item #14. We enforce cycle budgets but had no retrospective view of what
they were spent on.

Source matters here. Per-cycle token counts are not persisted anywhere queryable --
agent_cycles.cost is one number computed at cycle end, episode_log is empty, and
cycle_steps carries no usage block -- so a reader pointed at the database could only
repeat what the dashboard already shows. The telemetry JSONL the agent writes every
turn is the real per-turn record, so that is what this reads.

The number that earns its place is the cache hit rate: on DeepSeek off-peak a cached
input token costs ~1/30th of a miss, so it moves spend by an order of magnitude while
the token count looks identical.
"""
import json
from pathlib import Path

import pytest

from nanoagent.agent import insights


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    insights.telemetry_dir(tmp_path).mkdir(parents=True)
    return tmp_path


def write_log(workspace: Path, session: str, *events: dict, rotation: str = "") -> Path:
    path = insights.telemetry_dir(workspace) / f"session-{session}{rotation}.jsonl"
    with path.open("a", encoding="utf-8") as fh:
        for event in events:
            fh.write(json.dumps(event) + "\n")
    return path


def turn(**kwargs) -> dict:
    base = {
        "ts": "2026-08-22T10:00:00Z",
        "event": "turn_completed",
        "tools_used": [],
        "prompt_tokens": 1000,
        "completion_tokens": 100,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
    }
    return {**base, **kwargs}


# ─── aggregation ────────────────────────────────────────────────────────────


def test_turns_and_tokens_are_summed(workspace):
    write_log(workspace, "cli_a", turn(), turn(prompt_tokens=2000))

    result = insights.collect(workspace)

    assert result.turns == 2
    assert result.prompt_tokens == 3000
    assert result.completion_tokens == 200
    assert result.total_tokens == 3200


def test_the_cache_hit_rate_is_reported(workspace):
    """The number that actually moves spend."""
    write_log(workspace, "cli_a", turn(prompt_tokens=1000, cache_read_tokens=900))

    assert insights.collect(workspace).cache_hit_rate == pytest.approx(0.9)


def test_tool_usage_is_counted(workspace):
    write_log(
        workspace, "cli_a",
        turn(tools_used=["exec", "read_file", "exec"]),
        turn(tools_used=["exec"]),
    )

    result = insights.collect(workspace)

    assert result.tool_counts["exec"] == 3
    assert result.tools_per_turn == 2.0


def test_several_sessions_are_distinguished(workspace):
    write_log(workspace, "cli_a", turn())
    write_log(workspace, "cli_b", turn())

    assert insights.collect(workspace).sessions == {"cli_a", "cli_b"}


def test_one_session_can_be_isolated(workspace):
    write_log(workspace, "cli_a", turn(prompt_tokens=500))
    write_log(workspace, "cli_b", turn(prompt_tokens=9000))

    assert insights.collect(workspace, session="cli_a").prompt_tokens == 500


def test_rotated_logs_are_included(workspace):
    """Dropping them would under-report exactly the busiest agents."""
    write_log(workspace, "cli_a", turn())
    write_log(workspace, "cli_a", turn(), rotation=".1")

    result = insights.collect(workspace)

    assert result.turns == 2
    assert result.sessions == {"cli_a"}, "a rotated file is the same session"


def test_compactions_are_tracked(workspace):
    write_log(workspace, "cli_a", turn(compacted=True), turn())

    assert insights.collect(workspace).compactions == 1


# ─── it must never be the thing that breaks ─────────────────────────────────


def test_a_truncated_final_line_is_skipped(workspace):
    """The sink is line-buffered and a container can die mid-write."""
    path = write_log(workspace, "cli_a", turn())
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"event": "turn_completed", "prompt_toke')

    assert insights.collect(workspace).turns == 1


def test_non_turn_events_are_ignored(workspace):
    write_log(workspace, "cli_a", {"event": "turn_started"}, turn())

    assert insights.collect(workspace).turns == 1


def test_missing_or_malformed_fields_do_not_break_the_sum(workspace):
    write_log(
        workspace, "cli_a",
        {"event": "turn_completed"},
        turn(prompt_tokens="lots", tools_used="exec"),
    )

    result = insights.collect(workspace)

    assert result.turns == 2
    assert result.prompt_tokens == 0


def test_no_telemetry_yields_an_empty_report(tmp_path: Path):
    result = insights.collect(tmp_path)

    assert result.turns == 0
    assert result.format() == "No completed turns recorded."


# ─── the report ─────────────────────────────────────────────────────────────


def test_the_report_leads_with_what_is_actionable(workspace):
    write_log(
        workspace, "cli_a",
        turn(prompt_tokens=10_000, cache_read_tokens=8_000, tools_used=["exec"]),
    )

    report = insights.collect(workspace).format()

    assert "80% served from cache" in report
    assert "exec" in report
    assert "1 turns across 1 session(s)" in report
