"""Unit and integration tests for Phase 21: Autonomous TOTP Engine & 2FA Auto-Resolution."""

import os
import pytest

from nanoagent.agent.effector.credentials.totp_engine import (
    detect_totp_input_field,
    generate_totp_code,
    is_totp_prompt,
)
from nanoagent.agent.effector.credential_inject import has_credential_ref, resolve_credential_ref
from nanoagent.agent.effector.types import Bounds, DOMElementNode, Point


# Standard RFC 6238 test secret "12345678901234567890" in Base32: GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
RFC_BASE32_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"


def test_rfc6238_standard_test_vectors():
    """Verify TOTP output against standard RFC 6238 time vectors."""
    # Counter 1 (T0 + 59s -> 1 time step): standard RFC 6238 vector for SHA1 at T=59s is "287082"
    code_59s = generate_totp_code(RFC_BASE32_SECRET, digits=6, time_step=30, for_time=59)
    assert code_59s == "287082"

    # At T=1111111109s (counter 37037036), standard RFC 6238 vector for SHA1 is "081804"
    code_epoch = generate_totp_code(RFC_BASE32_SECRET, digits=6, time_step=30, for_time=1111111109)
    assert code_epoch == "081804"
    assert len(code_epoch) == 6
    assert code_epoch.startswith("0")  # Checks zero-padding preservation


def test_totp_handles_spaces_and_lowercase():
    """Secrets often contain spaces or lowercase letters when copied from QR codes."""
    code1 = generate_totp_code("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", for_time=59)
    code2 = generate_totp_code(RFC_BASE32_SECRET, for_time=59)
    assert code1 == code2 == "287082"


def test_totp_invalid_secret_raises_value_error():
    with pytest.raises(ValueError, match="Invalid base32"):
        generate_totp_code("198273918237912837192837192837198237!@#$")


def test_totp_prompt_detection():
    assert is_totp_prompt("Two-Factor Authentication", "Please enter your 6-digit code") is True
    assert is_totp_prompt("Verify Your Identity", "Enter the code from your authenticator app") is True
    assert is_totp_prompt("Sign in", "Please check your device for a 2-step verification code") is True
    assert is_totp_prompt("Welcome Back", "Enter your username and password to log in") is False


def test_detect_totp_input_field():
    bounds = Bounds(x=0, y=0, width=100, height=30)
    unrelated = DOMElementNode(
        ref="@e1",
        tag="input",
        selector="#username",
        bounds=bounds,
        center=Point(x=10, y=10),
        is_visible=True,
        is_enabled=True,
        name="username",
        placeholder="Enter email",
        role="textbox",
    )
    totp_input = DOMElementNode(
        ref="@e2",
        tag="input",
        selector="#auth_code",
        bounds=bounds,
        center=Point(x=10, y=50),
        is_visible=True,
        is_enabled=True,
        name="auth_code",
        placeholder="6-digit code",
        role="textbox",
        type="tel",
    )

    detected = detect_totp_input_field([unrelated, totp_input])
    assert detected is not None
    assert detected.name == "auth_code"
    assert detected.ref == "@e2"


@pytest.mark.asyncio
async def test_credential_inject_resolves_totp_via_env():
    """Verify credential_inject resolves service:totp dynamically."""
    os.environ["GITHUB_TOTP_SECRET"] = RFC_BASE32_SECRET
    try:
        assert has_credential_ref("github:totp") is True
        code = await resolve_credential_ref("github:totp")
        assert code is not None
        assert len(code) == 6
        assert code.isdigit()
    finally:
        del os.environ["GITHUB_TOTP_SECRET"]
