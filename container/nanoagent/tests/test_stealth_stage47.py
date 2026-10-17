"""Unit tests for Stage 47 Runtime Isolation & Stealth Layer.
"""

from __future__ import annotations

import re
from pathlib import Path

from nanoagent.agent.effector.stealth.driver_scrambler import obfuscate_driver_signatures
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
from nanoagent.agent.effector.stealth.stealth import build_stealth_init_script


def test_driver_signature_scrambler_in_place(tmp_path: Path):
    mock_driver = tmp_path / "mock_chromedriver.exe"
    original_signature = b"cdc_1234567890123456789012_"
    dummy_payload = b"\x7fELF" + (b"\x90" * 100) + original_signature + (b"\x90" * 100)
    mock_driver.write_bytes(dummy_payload)
    original_size = len(dummy_payload)

    # First sweep: should patch the signature
    patched_count = obfuscate_driver_signatures(mock_driver)
    assert patched_count == 1

    modified_bytes = mock_driver.read_bytes()
    assert len(modified_bytes) == original_size  # Size must remain strictly invariant
    assert original_signature not in modified_bytes
    assert b"nav_" in modified_bytes

    # Second sweep: should detect clean binary and return 0
    second_pass = obfuscate_driver_signatures(mock_driver)
    assert second_pass == 0


def test_stealth_init_script_virtualization_pipeline():
    profile = DEVICE_PROFILES[0]
    script = build_stealth_init_script(profile)

    # Verify virtualization pipeline presence
    assert "Function.prototype.toString" in script
    assert "nativeFnMap" in script or "virtualizedRegistry" in script

    # Verify no unrendered template tags remain
    unrendered = re.findall(r"__[A-Z0-9_]+__", script)
    assert unrendered == [], f"Found unrendered template tags: {unrendered}"
