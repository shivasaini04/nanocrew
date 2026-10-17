"""Phase 12: Verification tests for Peripheral & Hardware API Parity (MediaDevices, Battery, NetworkInfo).

Tests MediaDevices table injection, BatteryManager promise virtualization,
and NetworkInformation bandwidth/RTT parameter consistency.
"""

from __future__ import annotations

import json
import pytest

from nanoagent.agent.effector.stealth.fingerprint_pool import (
    DEVICE_PROFILES,
    MediaDeviceSpec,
)
from nanoagent.agent.effector.stealth.stealth import (
    build_stealth_init_script,
)


def test_device_profile_includes_peripheral_metadata():
    """Verify that all default device profiles include realistic peripheral descriptors."""
    for profile in DEVICE_PROFILES:
        assert len(profile.media_devices) >= 3
        kinds = {d.kind for d in profile.media_devices}
        assert "audioinput" in kinds
        assert "audiooutput" in kinds
        assert "videoinput" in kinds

        assert isinstance(profile.battery_charging, bool)
        assert 0.0 <= profile.battery_level <= 1.0
        assert profile.network_downlink > 0
        assert profile.network_rtt > 0
        assert profile.network_effective_type in ("4g", "3g", "5g")


def test_stealth_init_script_substitutes_peripheral_parameters():
    """Verify that build_stealth_init_script templates all peripheral placeholders."""
    profile = DEVICE_PROFILES[0]
    script = build_stealth_init_script(profile)

    # Ensure no unresolved placeholders remain
    assert "__MEDIA_DEVICES__" not in script
    assert "__BATTERY_CHARGING__" not in script
    assert "__BATTERY_LEVEL__" not in script
    assert "__NET_DOWNLINK__" not in script
    assert "__NET_RTT__" not in script
    assert "__NET_EFFECTIVE_TYPE__" not in script


def test_stealth_init_script_contains_battery_and_network_blocks():
    """Verify that the generated script defines getBattery, enumerateDevices, and connection hooks."""
    profile = DEVICE_PROFILES[0]
    script = build_stealth_init_script(profile)

    assert "enumerateDevices" in script
    assert "getBattery" in script
    assert "navigator.connection" in script
    assert "effectiveType" in script


def test_media_device_spec_data_integrity():
    """Verify MediaDeviceSpec field structure."""
    spec = MediaDeviceSpec(
        device_id="mic_1",
        kind="audioinput",
        label="Internal Mic (HD Audio)",
        group_id="audio_grp_1",
    )
    assert spec.device_id == "mic_1"
    assert spec.kind == "audioinput"
    assert spec.label == "Internal Mic (HD Audio)"
    assert spec.group_id == "audio_grp_1"
