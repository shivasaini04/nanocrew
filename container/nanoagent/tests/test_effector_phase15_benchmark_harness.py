"""Phase 15: Verification tests for Live Adversarial Hardening & Verification Benchmark Harness.

Tests adversarial scoring metrics, multi-category evaluation (Prototypes, Peripherals,
Canvas/Audio noise, Kinetics, Security), and Markdown audit report generation.
"""

from __future__ import annotations

from dataclasses import replace
import pytest

from nanoagent.agent.effector.benchmarks.benchmark_harness import (
    AdversarialBenchmarkHarness,
    BenchmarkCategoryResult,
    BenchmarkReport,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES


def test_benchmark_harness_evaluates_device_profile_at_full_score():
    """Verify default device profiles attain full 10.0/10.0 score across all adversarial suites."""
    profile = DEVICE_PROFILES[0]
    report = AdversarialBenchmarkHarness.evaluate_profile_heuristics(profile)

    assert report.overall_score == 10.0
    assert report.max_overall_score == 10.0
    assert report.passed is True
    assert len(report.categories) == 5
    for cat in report.categories:
        assert cat.passed is True
        assert cat.score == cat.max_score


def test_benchmark_harness_markdown_formatting():
    """Verify Markdown report generation contains table headers and badges."""
    profile = DEVICE_PROFILES[0]
    report = AdversarialBenchmarkHarness.evaluate_profile_heuristics(profile)
    md = report.to_markdown()

    assert "# Effector Ultimaa Adversarial Benchmark Report" in md
    assert "Overall Score:" in md
    assert "10.00 / 10.00" in md
    assert "| Evaluation Category | Score | Status | Findings / Telemetry |" in md
    assert "PASS" in md


def test_benchmark_harness_fails_on_corrupt_profile():
    """Verify harness catches invalid profiles with missing peripherals or corrupt UA."""
    profile = replace(DEVICE_PROFILES[0], user_agent="GenericBot/1.0", media_devices=())
    report = AdversarialBenchmarkHarness.evaluate_profile_heuristics(profile)

    assert report.overall_score < 10.0
    assert report.passed is False
    assert any(not cat.passed for cat in report.categories)
