"""Unit tests for Report Drafting, Exporting & KI Distillation."""

import json
from pathlib import Path
import pytest

from nanoagent.agent.research.distillation import KIDistiller
from nanoagent.agent.research.report.exporter import ExportPipeline
from nanoagent.agent.research.report.types import DraftSection, PaperDraft


def test_export_pipeline_markdown_and_latex(tmp_path: Path):
    exporter = ExportPipeline()
    draft = PaperDraft(
        title="Sparse Attention Mechanisms for Long Contexts",
        abstract="We present an empirical study of sparse KV caching in transformer models.",
        sections=[
            DraftSection(heading="Introduction", content="Transformers require O(N^2) memory...", word_count=4),
            DraftSection(heading="Methodology", content="We benchmarked dynamic sparse masks...", word_count=5),
        ],
        version="v1.0",
    )

    out_dir = str(tmp_path / "deliverables")
    md_file = exporter.export_markdown(draft, out_dir)
    tex_file = exporter.export_latex(draft, out_dir)

    assert Path(md_file).exists()
    assert Path(tex_file).exists()

    md_content = Path(md_file).read_text(encoding="utf-8")
    assert "# Sparse Attention Mechanisms for Long Contexts" in md_content
    assert "## Methodology" in md_content

    tex_content = Path(tex_file).read_text(encoding="utf-8")
    assert r"\title{Sparse Attention Mechanisms for Long Contexts}" in tex_content
    assert r"\section{Introduction}" in tex_content


def test_ki_distiller_generates_knowledge_items(tmp_path: Path):
    kb_path = str(tmp_path / "knowledge")
    distiller = KIDistiller(kb_path)

    findings = [
        {
            "thesis": "FlashAttention-2 provides 2x speedup on Ampere GPUs.",
            "description": "Reduced non-matmul FLOPs and parallelized across sequence dimension.",
            "status": "verified",
            "metric": 0.94,
            "iteration": 3,
            "reasoning": "Empirically verified across 10 benchmark seeds.",
        },
        {
            "thesis": "Unverified draft hypothesis",
            "status": "draft",
            "metric": 0.2,
        },
    ]

    count = distiller.distill_session("FlashAttention Kernel Tuning", findings, [])
    assert count == 1

    # Check generated files
    research_dir = tmp_path / "knowledge" / "research" / "flashattention_kernel_tuning" / "findings"
    assert research_dir.exists()

    finding_folders = list(research_dir.iterdir())
    assert len(finding_folders) == 1

    meta_file = finding_folders[0] / "metadata.json"
    assert meta_file.exists()
    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert "FlashAttention-2" in meta["title"]
    assert meta["category"] == "scientific_discovery"
    assert meta["confidence"] == 0.95

    art_file = finding_folders[0] / "artifacts" / "finding.md"
    assert art_file.exists()
    art_content = art_file.read_text(encoding="utf-8")
    assert "Empirical Evidence" in art_content
