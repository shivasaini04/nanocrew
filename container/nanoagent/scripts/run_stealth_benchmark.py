#!/usr/bin/env python
"""Run the adversarial benchmark and write a dated result file.

R5 §3.1. Every stealth number in the ultimaa roadmap was a self-assessment, because the
harness that would have measured anything was never run and had no entry point. This is
that entry point.

Per CLAUDE.md, a *measured finding with a date* is the one kind of claim these docs may
be trusted for — which is why the output is written to a dated, committed file rather
than printed and forgotten.

    python scripts/run_stealth_benchmark.py                  # all profiles, stdout
    python scripts/run_stealth_benchmark.py --write          # + dated result file
    python scripts/run_stealth_benchmark.py --profile 0

Scope, stated plainly: this harness is STATIC. It evaluates device profiles, kinetics
and crypto — it does not drive a browser. Live in-page detection (CreepJS, sannysoft,
worker parity) and JA3/JA4 are reported as NOT MEASURED, never as passes. Closing that
gap needs a real browser against a live surface and is deliberately not faked here.
"""

from __future__ import annotations

import argparse
import datetime
import sys
from pathlib import Path

# Run from the package root without an install.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanoagent.agent.effector.benchmarks.benchmark_harness import (  # noqa: E402
    AdversarialBenchmarkHarness,
)
from nanoagent.agent.effector.stealth.camoufox_driver import engine_status  # noqa: E402
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES  # noqa: E402

# scripts/ -> nanoagent/ -> container/ -> nanocrew-main/ -> repo root
RESULTS_DIR = (
    Path(__file__).resolve().parents[4] / "docs" / "research" / "ultimaa" / "benchmark-results"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=int, default=None,
                        help="index into DEVICE_PROFILES; default runs every profile")
    parser.add_argument("--write", action="store_true",
                        help="write a dated result file under docs/research/ultimaa/benchmark-results/")
    args = parser.parse_args()

    profiles = (
        [DEVICE_PROFILES[args.profile]] if args.profile is not None else list(DEVICE_PROFILES)
    )

    engine_ok, engine_reason = engine_status()
    header = [
        "# Effector stealth benchmark",
        "",
        f"**Run:** {datetime.datetime.now(datetime.timezone.utc).isoformat()}",
        f"**Engine:** {'camoufox-native' if engine_ok else 'chromium'} — {engine_reason}",
        f"**Profiles evaluated:** {len(profiles)}",
        "",
        "> Static harness: profiles, kinetics and crypto only. Live in-page detection",
        "> and transport fingerprinting are listed under *Not measured* — they are not",
        "> passes.",
        "",
        "---",
        "",
    ]

    sections: list[str] = []
    all_passed = True
    for i, profile in enumerate(profiles):
        report = AdversarialBenchmarkHarness.evaluate_profile_heuristics(profile)
        all_passed = all_passed and report.passed
        sections.append(f"## Profile {i}: {profile.platform} / Chrome {profile.chrome_version}\n")
        sections.append(report.to_markdown())
        sections.append("")

    document = "\n".join(header + sections)
    print(document)

    if args.write:
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        out = RESULTS_DIR / f"{datetime.date.today().isoformat()}.md"
        out.write_text(document, encoding="utf-8")
        print(f"\nwrote {out}", file=sys.stderr)

    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
