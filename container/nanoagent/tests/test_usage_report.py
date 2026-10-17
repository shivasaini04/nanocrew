"""The insights reader must actually be reachable by the agent.

Stage 42 #14's missing half. `agent/insights.py` shipped with green tests over code
NOTHING called -- the exact failure CLAUDE.md names: a file existing is not proof it
runs, and a passing suite over an unreachable module proves less than nothing.

So the first test here is the one that matters: the tool is registered on a real
AgentLoop. The rest check it reports honestly when there is nothing to report.
"""
import json
from pathlib import Path

import pytest

from nanoagent.agent import insights
from nanoagent.agent.tools.usage_report import UsageReportTool


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    insights.telemetry_dir(tmp_path).mkdir(parents=True)
    return tmp_path


def turn(**kw):
    base = {"event": "turn_completed", "prompt_tokens": 1000, "completion_tokens": 100,
            "cache_read_tokens": 0, "tools_used": []}
    return {**base, **kw}


def write(workspace: Path, *events):
    p = insights.telemetry_dir(workspace) / "session-default.jsonl"
    with p.open("a", encoding="utf-8") as fh:
        for e in events:
            fh.write(json.dumps(e) + "\n")


def test_the_tool_is_registered_on_a_real_loop():
    """The whole point: insights was unreachable until something called it."""
    pytest.importorskip("loguru", reason="needs the full agent runtime")
    import inspect

    from nanoagent.agent.loop import AgentLoop

    assert "UsageReportTool(self.workspace)" in inspect.getsource(AgentLoop)


async def test_it_reports_the_cache_hit_rate(workspace):
    """The figure that moves spend by an order of magnitude."""
    write(workspace, turn(prompt_tokens=10_000, cache_read_tokens=9_000))

    out = await UsageReportTool(workspace).execute()

    assert "90% served from cache" in out


async def test_it_reports_tool_usage(workspace):
    write(workspace, turn(tools_used=["exec", "exec", "read_file"]))

    out = await UsageReportTool(workspace).execute()

    assert "exec" in out and "read_file" in out


async def test_an_agent_with_no_history_is_told_so_plainly(workspace):
    out = await UsageReportTool(workspace).execute()

    assert out == "No completed turns recorded."


async def test_a_session_filter_narrows_the_report(workspace):
    write(workspace, turn(prompt_tokens=500))

    assert "1 turns" in await UsageReportTool(workspace).execute(session="default")
    assert "No completed turns" in await UsageReportTool(workspace).execute(session="other")
