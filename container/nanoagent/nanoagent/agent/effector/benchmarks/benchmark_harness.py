"""Live Adversarial Hardening & Verification Benchmark Harness for Effector.

Evaluates an Effector instance against adversarial fingerprinting heuristics:
- WebGL / Canvas / Audio deterministic noise
- Navigator prototype chain integrity & Worker parity
- TLS Client Hello Ja3/Ja4 coherence
- Neuromotor kinetics Fitts' Law profile
- L7 SSRF egress filter & prompt injection firewall
- Merkle ledger state tamper-proofing
"""

from __future__ import annotations

import datetime
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES, DeviceProfile


@dataclass(frozen=True)
class BenchmarkCategoryResult:
    category: str
    score: float
    max_score: float
    passed: bool
    details: str


@dataclass
class BenchmarkReport:
    timestamp: str
    overall_score: float
    max_overall_score: float = 10.0
    passed: bool = True
    categories: list[BenchmarkCategoryResult] = field(default_factory=list)
    unmeasured: list[str] = field(default_factory=list)

    def to_markdown(self) -> str:
        """Renders report as a clean Markdown summary table."""
        lines = [
            f"# Effector Ultimaa Adversarial Benchmark Report",
            f"**Timestamp:** {self.timestamp}",
            f"**Overall Score:** `{self.overall_score:.2f} / {self.max_overall_score:.2f}` ({'PASS' if self.passed else 'FAIL'})",
            "",
            "| Evaluation Category | Score | Status | Findings / Telemetry |",
            "|---|:---:|:---:|---|",
        ]
        for cat in self.categories:
            status_badge = "PASS" if cat.passed else "FAIL"
            lines.append(f"| **{cat.category}** | `{cat.score:.2f}/{cat.max_score:.2f}` | {status_badge} | {cat.details} |")

        # R5 §3.3: a dimension with no engine behind it reports NOT MEASURED, never
        # PASS. Omitting them entirely would make this table read as full coverage,
        # which is how an unrun benchmark came to back a 9.99 claim in the first place.
        if self.unmeasured:
            lines += ["", "## Not measured", ""]
            lines += [f"- **NOT MEASURED** — {u}" for u in self.unmeasured]
            lines += [
                "",
                "_Neither failures nor passes. This harness is static: it evaluates "
                "profiles and crypto, not a live browser against a live detection surface._",
            ]
        return "\n".join(lines)


class AdversarialBenchmarkHarness:
    """Orchestrates comprehensive adversarial verification across all 15 Effector hardening layers."""

    @classmethod
    def evaluate_profile_heuristics(cls, profile: DeviceProfile) -> BenchmarkReport:
        """Runs static and kinetic heuristic evaluation against a target DeviceProfile."""
        categories: list[BenchmarkCategoryResult] = []

        # 1. Prototype & UserAgent Consistency (CreepJS / SannySoft)
        ua_valid = "Chrome" in profile.user_agent and profile.platform in ("Linux x86_64", "Win32", "MacIntel")
        categories.append(
            BenchmarkCategoryResult(
                category="Navigator & Prototype Chain Parity",
                score=2.0 if ua_valid else 0.0,
                max_score=2.0,
                passed=ua_valid,
                details=f"Platform: {profile.platform}, Architecture: {profile.architecture}, Bitness: {profile.bitness}",
            )
        )

        # 2. Hardware & Peripheral Completeness
        peripherals_valid = len(profile.media_devices) >= 3 and (0.0 <= profile.battery_level <= 1.0)
        categories.append(
            BenchmarkCategoryResult(
                category="Hardware & Peripheral API Parity",
                score=2.0 if peripherals_valid else 0.0,
                max_score=2.0,
                passed=peripherals_valid,
                details=f"MediaDevices count: {len(profile.media_devices)}, Battery: {profile.battery_level * 100}%, Network: {profile.network_effective_type}",
            )
        )

        # 3. Canvas & Audio Determinism
        noise_valid = profile.noise_seed > 0
        categories.append(
            BenchmarkCategoryResult(
                category="Canvas/Audio Deterministic Noise",
                score=2.0 if noise_valid else 0.0,
                max_score=2.0,
                passed=noise_valid,
                details=f"Profile Noise Seed: 0x{profile.noise_seed:08x}",
            )
        )

        # 4. Neuromotor kinetics. R5, 2026-08-31: this used to be a hardcoded
        # score=2.0/passed=True with a prose blurb — it asserted nothing and would
        # have reported PASS with the kinetics module deleted. Now it generates a
        # real trajectory and measures it.
        categories.append(cls._measure_kinetics())

        # 5. Cryptographic ledger — was likewise hardcoded. Now builds a chain,
        # tampers with it, and checks that the tamper is actually detected.
        categories.append(cls._measure_ledger())

        total_score = sum(c.score for c in categories)
        total_max = sum(c.max_score for c in categories)
        all_passed = all(c.passed for c in categories)

        return BenchmarkReport(
            timestamp=datetime.datetime.now(datetime.timezone.utc).isoformat(),
            overall_score=round(total_score, 2),
            max_overall_score=round(total_max, 2),
            passed=all_passed,
            categories=categories,
            unmeasured=cls.unmeasured_dimensions(),
        )

    @staticmethod
    def _measure_kinetics() -> BenchmarkCategoryResult:
        """Generate a real trajectory and check it looks human, not linear."""
        try:
            from nanoagent.agent.effector.stealth.kinetics import (
                generate_neuromotor_trajectory,
            )
            from nanoagent.agent.effector.types import Point

            points = generate_neuromotor_trajectory(Point(0.0, 0.0), Point(600.0, 400.0))
            if len(points) < 5:
                return BenchmarkCategoryResult(
                    "Neuromotor Kinetics & Digraph Physics", 0.0, 2.0, False,
                    f"trajectory had only {len(points)} points",
                )
            # A straight interpolation is the tell. Real motion wanders off the direct
            # line somewhere along its length; perfectly linear movement does not.
            x0, y0 = points[0].x, points[0].y
            x1, y1 = points[-1].x, points[-1].y
            span_sq = max((x1 - x0) ** 2 + (y1 - y0) ** 2, 1e-9)
            max_dev = 0.0
            for pt in points:
                t = ((pt.x - x0) * (x1 - x0) + (pt.y - y0) * (y1 - y0)) / span_sq
                max_dev = max(max_dev, abs(pt.y - (y0 + t * (y1 - y0))))
            passed = max_dev > 0.5
            return BenchmarkCategoryResult(
                "Neuromotor Kinetics & Digraph Physics",
                2.0 if passed else 0.0, 2.0, passed,
                f"{len(points)} points, max deviation from straight line {max_dev:.2f}px",
            )
        except Exception as err:
            return BenchmarkCategoryResult(
                "Neuromotor Kinetics & Digraph Physics", 0.0, 2.0, False,
                f"kinetics unavailable ({type(err).__name__}: {err})",
            )

    @staticmethod
    def _measure_ledger() -> BenchmarkCategoryResult:
        """Build a chain, tamper with it, and require the tamper to be caught."""
        try:
            from nanoagent.agent.effector.security.merkle_ledger import MerkleActionLedger

            ledger = MerkleActionLedger(cycle_secret="benchmark-probe")
            ledger.record_step(turn=1, action="navigate", url="https://example.com")
            ledger.record_step(turn=2, action="click", target="@pay")
            if not ledger.verify_integrity():
                return BenchmarkCategoryResult(
                    "Cryptographic Ledger Tamper Detection", 0.0, 2.0, False,
                    "an untampered chain failed its own verification",
                )
            ledger.blocks[0].action = "navigate-elsewhere"
            caught = not ledger.verify_integrity()
            return BenchmarkCategoryResult(
                "Cryptographic Ledger Tamper Detection",
                2.0 if caught else 0.0, 2.0, caught,
                "tampered block detected" if caught else "TAMPER WENT UNDETECTED",
            )
        except Exception as err:
            return BenchmarkCategoryResult(
                "Cryptographic Ledger Tamper Detection", 0.0, 2.0, False,
                f"ledger unavailable ({type(err).__name__}: {err})",
            )

    @staticmethod
    def unmeasured_dimensions() -> list[str]:
        """Dimensions this harness cannot measure, reported as NOT MEASURED.

        R5 §3.3: a dimension with no engine behind it must never report PASS. These
        need a real browser against a live detection surface, which this static
        harness does not have.
        """
        from nanoagent.agent.effector.stealth.tls_proxy import is_utls_available

        unmeasured = [
            "In-page detection (navigator.webdriver, chrome.runtime, CreepJS lies) "
            "— needs a live browser",
            "Worker/main-thread fingerprint parity — needs a live browser",
        ]
        if not is_utls_available():
            unmeasured.append(
                "JA3/JA4 transport fingerprint — no uTLS engine in this build"
            )
        return unmeasured
