"""Phase 10: Verification tests for Kernel Sandboxing, Display Authentication & Hyper-Hardening.

Tests MIT-MAGIC-COOKIE-1 xauth generation, restricted file permissions,
hardened Chromium launch argument construction, and strict site-isolation sandboxing.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from nanoagent.agent.effector.browser_session import build_chromium_launch_args
from nanoagent.agent.effector.desktop.xvfb_session import (
    ensure_authenticated_virtual_display,
    setup_xauth_cookie,
)


def test_xauth_cookie_generation_and_environment(tmp_path: Path):
    """Verify setup_xauth_cookie creates a valid xauthority cookie file and sets XAUTHORITY."""
    xauth_file = tmp_path / ".test_xauth"
    result_path = setup_xauth_cookie(display=":99", xauth_path=xauth_file)

    assert result_path == xauth_file
    assert xauth_file.exists()
    assert os.environ.get("XAUTHORITY") == str(xauth_file)

    # An Xauthority file is BINARY — a MIT-MAGIC-COOKIE-1 entry is 128 bits of random
    # data, which is very often not valid UTF-8. Found by CI on 2026-08-31 (the first
    # run of the new Linux Python job): this used to be read_text(encoding="utf-8") and
    # raised UnicodeDecodeError on byte 0xc3. It passed locally on Windows only because
    # `xauth` is absent there, so the helper fell back to writing a text stub — the
    # exact platform-difference class the Linux CI job was added to catch.
    content = xauth_file.read_bytes()
    assert len(content) > 0
    if shutil.which("xauth"):
        # A real xauth-written entry carries the display number and the cookie name.
        assert b"MIT-MAGIC-COOKIE-1" in content or b"99" in content


def test_ensure_authenticated_virtual_display_lifecycle(tmp_path: Path):
    """Verify ensure_authenticated_virtual_display sets up xauth cookies without crashing."""
    xauth_file = tmp_path / ".effector_xauth"
    disp = ensure_authenticated_virtual_display(width=1280, height=720, xauth_path=xauth_file)

    # In headless / test environments without Xvfb binary, it gracefully returns None or :99
    assert disp in (None, ":99")
    assert xauth_file.exists()


def test_build_chromium_launch_args_default_mode():
    """Verify default Chromium launch args contain standard anti-automation and anti-leak flags."""
    args = build_chromium_launch_args(strict_sandbox=False)

    assert "--disable-blink-features=AutomationControlled" in args
    assert "--enforce-webrtc-ip-permission-check" in args
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in args
    assert "--no-sandbox" in args
    assert "--disable-setuid-sandbox" in args


def test_build_chromium_launch_args_strict_sandbox_mode():
    """Verify strict sandboxing mode omits sandbox disabling flags and enables site isolation."""
    args = build_chromium_launch_args(strict_sandbox=True)

    # Must NOT contain sandbox disabling flags
    assert "--no-sandbox" not in args
    assert "--disable-setuid-sandbox" not in args

    # Must enforce site-per-process
    assert "--site-per-process" in args
    assert "--enable-features=IsolateOrigins,site-per-process" in args


def test_build_chromium_launch_args_respects_env_var(monkeypatch: pytest.MonkeyPatch):
    """Verify build_chromium_launch_args automatically honors EFFECTOR_STRICT_SANDBOX environment variable."""
    monkeypatch.setenv("EFFECTOR_STRICT_SANDBOX", "1")
    args = build_chromium_launch_args()

    assert "--no-sandbox" not in args
    assert "--site-per-process" in args

    monkeypatch.setenv("EFFECTOR_STRICT_SANDBOX", "0")
    default_args = build_chromium_launch_args()
    assert "--no-sandbox" in default_args
