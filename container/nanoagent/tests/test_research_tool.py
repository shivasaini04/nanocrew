"""Integration and unit tests for the unified ResearchTool."""

import json
import sys
from pathlib import Path
import pytest

from nanoagent.agent.tools.research import ResearchTool


@pytest.mark.asyncio
async def test_research_tool_verify_citations(tmp_path: Path):
    tool = ResearchTool(workspace=tmp_path)

    sources = {
        "s1": "Gradient checkpointing trades computation for GPU memory during deep neural network training.",
    }
    claims = [
        {"claim": "Gradient checkpointing reduces GPU memory by trading computation.", "source_id": "s1"},
        {"claim": "Cold fusion produces abundant electrical power at ambient pressure.", "source_id": "s1"},
    ]

    res_json = await tool.execute(action="verify_citations", claims=claims, sources=sources)
    res = json.loads(res_json)

    assert res["status"] == "success"
    assert res["total_claims"] == 2
    assert res["verified_count"] == 1
    assert res["unverified_count"] == 1


@pytest.mark.asyncio
async def test_research_tool_run_experiment(tmp_path: Path):
    tool = ResearchTool(workspace=tmp_path)
    script = tmp_path / "exp.py"
    script.write_text("print('TEST_ACCURACY: 0.982')\n", encoding="utf-8")

    res_json = await tool.execute(
        action="run_experiment",
        goal="Maximize test accuracy",
        run_command=f"{sys.executable} exp.py",
        metric_key="TEST_ACCURACY",
    )
    res = json.loads(res_json)

    assert res["status"] == "success"
    assert res["metrics"]["TEST_ACCURACY"] == 0.982


@pytest.mark.asyncio
async def test_research_tool_adversarial_audit(tmp_path: Path):
    tool = ResearchTool(workspace=tmp_path)

    res_json = await tool.execute(
        action="adversarial_audit",
        thesis="Speculative decoding achieves 2.5x latency speedup without quality loss.",
        evidence=[
            {"source": "benchmarks", "description": "Llama-3 latency benchmark", "value": "2.5x", "metric": 2.5}
        ],
    )
    res = json.loads(res_json)

    assert res["status"] == "success"
    assert res["outcome"] == "accepted"
    assert res["score"] >= 0.8


@pytest.mark.asyncio
async def test_research_tool_draft_report(tmp_path: Path):
    tool = ResearchTool(workspace=tmp_path)

    res_json = await tool.execute(
        action="draft_report",
        report_title="Autonomous Agent Systems for Research",
        outline_sections=["Introduction", "Related Work", "System Architecture", "Evaluation"],
        export_format="all",
    )
    res = json.loads(res_json)

    assert res["status"] == "success"
    assert res["sections_count"] == 4
    assert "markdown" in res["exported_files"]
    assert "latex" in res["exported_files"]
    assert Path(res["exported_files"]["markdown"]).exists()


@pytest.mark.asyncio
async def test_research_tool_distill_knowledge(tmp_path: Path):
    tool = ResearchTool(workspace=tmp_path)

    findings = [
        {
            "thesis": "Speculative decoding accelerates inference by 2.5x.",
            "description": "Uses small draft model for candidate token validation.",
            "status": "verified",
            "metric": 0.92,
        }
    ]

    res_json = await tool.execute(
        action="distill_knowledge",
        goal="Inference Acceleration",
        findings=findings,
    )
    res = json.loads(res_json)

    assert res["status"] == "success"
    assert res["distilled_knowledge_items"] == 1
