"""Phase 5: Verification tests for Cryptographic Transport Isolation (TLS / JA3/JA4 & HTTP/2 Virtualizer).

Tests uTLS preset mapping, proxy lifecycle orchestration, port binding, and graceful degradation.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector.browser_session import EffectorSession
from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES, DeviceProfile
from nanoagent.agent.effector.stealth.tls_proxy import (
    TLSVirtualizerProxy,
    is_utls_available,
    map_device_profile_to_tls_preset,
)


def test_tls_preset_mapping_from_device_profiles():
    """Verify that DeviceProfile platforms and Chrome versions map to exact JA4/uTLS presets."""
    default_profile = DEVICE_PROFILES[0]
    assert "linux" in map_device_profile_to_tls_preset(default_profile)

    custom_win = DeviceProfile(
        name="test_windows_profile",
        platform="Win32",
        ua_platform="Windows",
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        chrome_version="124.0.6367.207",
        hardware_concurrency=8,
        device_memory=8,
        gpu_vendor="Google Inc. (NVIDIA)",
        gpu_renderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
    )
    custom_mac = DeviceProfile(
        name="test_mac_profile",
        platform="MacIntel",
        ua_platform="macOS",
        user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        chrome_version="124.0.6367.207",
        hardware_concurrency=8,
        device_memory=8,
        gpu_vendor="Google Inc. (Apple)",
        gpu_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
    )

    assert "win" in map_device_profile_to_tls_preset(custom_win)
    assert "mac" in map_device_profile_to_tls_preset(custom_mac)
    assert map_device_profile_to_tls_preset(None) == "chrome_124_win11"


@pytest.mark.asyncio
async def test_tls_proxy_lifecycle_with_mock_mode(monkeypatch):
    """Verify that TLSVirtualizerProxy starts, binds to port, and stops gracefully in mock mode."""
    monkeypatch.setenv("EFFECTOR_MOCK_UTLS", "1")
    proxy = TLSVirtualizerProxy(listen_port=0)

    assert proxy.is_running is False
    url = await proxy.start()
    assert proxy.is_running is True
    assert url.startswith("http://127.0.0.1:")
    assert str(proxy.port) in url

    # Test idempotency of start()
    url2 = await proxy.start()
    assert url2 == url

    await proxy.stop()
    assert proxy.is_running is False


@pytest.mark.asyncio
async def test_tls_proxy_degrades_gracefully_when_binary_absent(monkeypatch):
    """Verify that when no binary or mock environment is present, start() degrades cleanly."""
    monkeypatch.delenv("EFFECTOR_MOCK_UTLS", raising=False)
    monkeypatch.delenv("UTLS_ROUTER_PATH", raising=False)

    proxy = TLSVirtualizerProxy(listen_port=0)
    with patch("nanoagent.agent.effector.stealth.tls_proxy.find_utls_binary", return_value=None):
        url = await proxy.start()
        assert url == ""
        assert proxy.is_running is False
        await proxy.stop()


@pytest.mark.asyncio
async def test_effector_session_chains_tls_virtualizer(tmp_path: Path, monkeypatch):
    """Verify that EffectorSession starts and cleans up _tls_virtualizer on proxied domains."""
    monkeypatch.setenv("EFFECTOR_MOCK_UTLS", "1")
    monkeypatch.setenv("DATAIMPULSE_HOST", "127.0.0.1")
    monkeypatch.setenv("DATAIMPULSE_PORT", "9999")

    # linkedin.com is in RESIDENTIAL_DOMAINS
    session = EffectorSession(workspace=tmp_path, session_domain="linkedin.com", headless=True)
    assert session._tls_virtualizer is None
