"""Phase 4: Verification tests for Web Worker, WebAssembly & Sub-Context Parity.

Tests that classic workers, ES module workers, SharedWorkers, and ServiceWorkers
inherit identical hardwareConcurrency, deviceMemory, platform, and language fingerprints.
"""

from __future__ import annotations

import json
import re

import pytest

from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
from nanoagent.agent.effector.stealth.stealth import (
    _build_worker_snippet,
    build_stealth_init_script,
)


def test_worker_snippet_fingerprint_parity():
    """Verify that the generated worker snippet contains matching hardware and platform values."""
    profile = DEVICE_PROFILES[0]
    langs = ("en-US", "en")
    snippet = _build_worker_snippet(profile, langs)

    assert f"def('hardwareConcurrency',{profile.hardware_concurrency})" in snippet
    assert f"def('deviceMemory',{profile.device_memory})" in snippet
    assert f"def('platform',\"{profile.platform}\")" in snippet
    assert "def('languages',Object.freeze(" in snippet
    assert "def('language',L[0])" in snippet


def test_stealth_init_script_contains_worker_and_sharedworker_hooks():
    """Verify that build_stealth_init_script hooks Worker, SharedWorker, and ServiceWorker."""
    profile = DEVICE_PROFILES[0]
    script = build_stealth_init_script(profile)

    # 1. Classic & Module Worker Support
    assert "const OrigWorker = self.Worker;" in script
    assert "opts && opts.type === 'module'" in script
    assert "import * as _mod from" in script
    assert "importScripts(" in script

    # 2. SharedWorker Support
    assert "const OrigSharedWorker = self.SharedWorker;" in script
    assert "self.SharedWorker = WrappedSharedWorker;" in script

    # 3. ServiceWorker Register Hook
    assert "navigator.serviceWorker.register" in script
    assert "nativeFnMap.add(wrappedRegister)" in script

    # 4. Invariant: zero unrendered template tags
    unrendered = re.findall(r"__[A-Z0-9_]+__", script)
    assert unrendered == [], f"Found unrendered template tags: {unrendered}"


def test_all_device_profiles_generate_valid_worker_snippets():
    """Verify that every profile in DEVICE_PROFILES generates valid worker snippet code."""
    for profile in DEVICE_PROFILES:
        script = build_stealth_init_script(profile)
        assert str(profile.hardware_concurrency) in script
        assert str(profile.device_memory) in script
        assert profile.platform in script
        assert "WrappedWorker" in script
        assert "WrappedSharedWorker" in script
