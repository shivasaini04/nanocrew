"""NanoAgent parity harness — deterministic turn-loop testing without real API calls.

Ported from claw-code-main/rust/crates/mock-anthropic-service/ and compat-harness/.

Usage:
    # Run all 10 baseline scenarios in CI
    pytest tests/test_parity.py -v

    # Record a new scenario (requires ANTHROPIC_API_KEY)
    python -m nanoagent.harness.recorder record my_scenario --prompt "Say hello"
"""
