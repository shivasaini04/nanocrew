"""Phase 3: Verification tests for Binary Signature Scrambling & Automation Token Eradication.

Tests byte-level invariance, multi-variant signature sweeping ($cdc_ and cdc_),
binary verification predicates, and idempotent in-place patching.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from nanoagent.agent.effector.stealth.driver_scrambler import (
    _CDC_PATTERN,
    _CHROMEDRIVER_VAR_PATTERNS,
    obfuscate_driver_signatures,
    scan_and_obfuscate_binaries,
    verify_binary_cleanliness,
)


def test_binary_patching_maintains_exact_byte_size(tmp_path: Path):
    """Ensure in-place byte replacement maintains strict byte-length parity."""
    test_bin = tmp_path / "mock_chromedriver.exe"
    original_content = b"ELF_HEADER_DATA_cdc_adoQpoasnfa76pfcZLmcfl_MIDDLE_SECTION_cdc_1234567890123456789012_FOOTER"
    test_bin.write_bytes(original_content)
    orig_size = len(original_content)

    assert verify_binary_cleanliness(test_bin) is False

    patched_count = scan_and_obfuscate_binaries([test_bin])
    assert patched_count == 2
    assert test_bin.stat().st_size == orig_size

    patched_data = test_bin.read_bytes()
    assert b"cdc_" not in patched_data
    assert b"nav_" in patched_data
    assert verify_binary_cleanliness(test_bin) is True


def test_chromedriver_dollar_prefix_signature_scrambled(tmp_path: Path):
    """Ensure $cdc_ variable signatures are scrambled with $nav prefix."""
    test_bin = tmp_path / "mock_driver.so"
    content = b"DATA_$cdc_as98df7asdf876asdf1234_MORE_DATA"
    test_bin.write_bytes(content)
    orig_size = len(content)

    assert verify_binary_cleanliness(test_bin) is False
    patched_count = scan_and_obfuscate_binaries([test_bin])
    assert patched_count >= 1
    assert test_bin.stat().st_size == orig_size

    patched_data = test_bin.read_bytes()
    assert b"$cdc_" not in patched_data
    assert b"$nav" in patched_data
    assert verify_binary_cleanliness(test_bin) is True


def test_scan_and_obfuscate_binaries_idempotency(tmp_path: Path):
    """Ensure scanning an already-clean binary makes no modifications and returns 0."""
    test_bin = tmp_path / "clean_binary.bin"
    test_bin.write_bytes(b"STANDARD_NON_AUTOMATION_BINARY_CONTENT_WITHOUT_CDC_HOOKS")

    assert verify_binary_cleanliness(test_bin) is True
    first_pass = scan_and_obfuscate_binaries([test_bin])
    assert first_pass == 0
    assert verify_binary_cleanliness(test_bin) is True


def test_driver_scrambler_handles_missing_and_empty_paths(tmp_path: Path):
    """Ensure non-existent, directory, or empty paths fail gracefully with 0 count."""
    missing_path = tmp_path / "non_existent.bin"
    dir_path = tmp_path / "a_directory"
    dir_path.mkdir()

    res = scan_and_obfuscate_binaries([missing_path, dir_path, ""])
    assert res == 0

    assert verify_binary_cleanliness(missing_path) is True
    assert verify_binary_cleanliness(dir_path) is True


def test_obfuscate_driver_signatures_convenience_function(tmp_path: Path):
    """Ensure obfuscate_driver_signatures wraps single binary correctly."""
    test_bin = tmp_path / "test_wrapper.bin"
    test_bin.write_bytes(b"HEADER_cdc_k1j2h3k1j2h3k1j2h3k1j2_TAIL")

    patched = obfuscate_driver_signatures(test_bin)
    assert patched == 1
    assert verify_binary_cleanliness(test_bin) is True
