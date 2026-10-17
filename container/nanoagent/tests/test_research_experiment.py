"""Unit tests for Empirical Experiment Runner & Karpathy Loop State."""

import os
import sys
from pathlib import Path
import pytest

from nanoagent.agent.research.base import ResearchConfig
from nanoagent.agent.research.evaluator import ResultEvaluator
from nanoagent.agent.research.program import ProgramState, append_to_results_tsv
from nanoagent.agent.research.runner import ExperimentResult, ExperimentRunner


@pytest.mark.asyncio
async def test_experiment_runner_executes_and_extracts_metrics(tmp_path: Path):
    script_path = tmp_path / "bench.py"
    script_path.write_text("print('BENCHMARK_ACCURACY: 0.945')\nprint('ALL DONE')\n", encoding="utf-8")

    config = ResearchConfig(
        goal="Maximize accuracy on CIFAR-10",
        workspace_path=str(tmp_path),
        target_file="bench.py",
        run_command=f"{sys.executable} bench.py",
        metric_key="BENCHMARK_ACCURACY",
        metric_direction="maximize",
        time_budget_per_run_sec=10,
    )

    runner = ExperimentRunner(config)
    result = await runner.run_experiment()

    assert result.success is True
    assert result.exit_code == 0
    assert "BENCHMARK_ACCURACY" in result.metrics
    assert result.metrics["BENCHMARK_ACCURACY"] == 0.945


@pytest.mark.asyncio
async def test_experiment_runner_handles_failure(tmp_path: Path):
    script_path = tmp_path / "broken.py"
    script_path.write_text("raise RuntimeError('OOM error')\n", encoding="utf-8")

    config = ResearchConfig(
        goal="Run model",
        workspace_path=str(tmp_path),
        target_file="broken.py",
        run_command=f"{sys.executable} broken.py",
        metric_key="loss",
        time_budget_per_run_sec=10,
    )

    runner = ExperimentRunner(config)
    result = await runner.run_experiment()

    assert result.success is False
    assert result.exit_code != 0
    assert "RuntimeError: OOM error" in result.stderr_tail


def test_program_state_save_and_load(tmp_path: Path):
    prog_file = str(tmp_path / "program.md")
    state = ProgramState(
        goal="Optimize Attention Kernel",
        hypothesis="Tiling across SRAM reduces global memory traffic.",
        constraints="Max 64KB SRAM per block",
        insights=["Triton block size 128 yields best throughput"],
        next_steps=["Benchmark on sequence lengths 2k to 16k"],
    )
    state.save(prog_file)

    loaded = ProgramState.load(prog_file)
    assert loaded.goal == "Optimize Attention Kernel"
    assert loaded.hypothesis == "Tiling across SRAM reduces global memory traffic."
    assert "Triton block size 128" in loaded.insights[0]


def test_append_to_results_tsv(tmp_path: Path):
    tsv_file = str(tmp_path / "results.tsv")
    append_to_results_tsv(tsv_file, iteration=1, metric=0.88, status="keep", description="Initial baseline")
    append_to_results_tsv(tsv_file, iteration=2, metric=0.93, status="keep", description="Added flash attention")

    with open(tsv_file, "r", encoding="utf-8") as f:
        lines = f.readlines()

    assert len(lines) == 3  # Header + 2 rows
    assert "Initial baseline" in lines[1]
    assert "Added flash attention" in lines[2]
