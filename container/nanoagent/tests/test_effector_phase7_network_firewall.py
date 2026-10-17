"""Phase 7: Verification tests for L7 Task-Scoped Egress Firewall, SSRF Protection & DLP Scanner.

Tests cloud metadata blocking, RFC 1918 private network blocking, dangerous scheme blocking,
real-time DLP scanner rules (API keys, SSNs, credit cards), and route interceptor integration.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from nanoagent.agent.effector.security.dlp_scanner import DlpScanner
from nanoagent.agent.effector.security.network_policy import (
    L7NetworkPolicy,
    is_private_or_metadata_host,
)
from nanoagent.agent.effector.stealth.network_shield import apply_network_shield


def test_network_policy_blocks_cloud_metadata_and_private_ips():
    """Verify that cloud metadata and internal subnets are flagged as private/metadata hosts."""
    assert is_private_or_metadata_host("169.254.169.254") is True
    assert is_private_or_metadata_host("fd00:ec2::254") is True
    assert is_private_or_metadata_host("metadata.google.internal") is True
    assert is_private_or_metadata_host("127.0.0.1") is True
    assert is_private_or_metadata_host("10.1.2.3") is True
    assert is_private_or_metadata_host("172.20.0.5") is True
    assert is_private_or_metadata_host("192.168.1.100") is True
    assert is_private_or_metadata_host("localhost") is True

    # Public hosts must be allowed
    assert is_private_or_metadata_host("api.github.com") is False
    assert is_private_or_metadata_host("93.184.216.34") is False


def test_network_policy_evaluates_schemes_and_allowlist():
    """Verify that L7NetworkPolicy rejects dangerous schemes and enforces domain allowlists."""
    policy = L7NetworkPolicy(primary_domain="example.com", enforce_allowlist=True)

    # Dangerous schemes
    allowed, reason = policy.evaluate_url("file:///etc/passwd")
    assert allowed is False
    assert "Blocked dangerous scheme" in reason

    allowed, reason = policy.evaluate_url("gopher://internal.lan:70")
    assert allowed is False

    # SSRF IP URL
    allowed, reason = policy.evaluate_url("http://169.254.169.254/latest/meta-data")
    assert allowed is False
    assert "private/metadata" in reason

    # Allowed primary domain and CDNs
    allowed, _ = policy.evaluate_url("https://example.com/login")
    assert allowed is True
    allowed, _ = policy.evaluate_url("https://fonts.googleapis.com/css2")
    assert allowed is True

    # Unauthorized domain
    allowed, reason = policy.evaluate_url("https://malicious-exfiltration.attacker.com/sink")
    assert allowed is False
    assert "not permitted by task allowlist" in reason


def test_dlp_scanner_detects_credentials_and_pii():
    """Verify DlpScanner catches API keys, private keys, SSNs, and credit cards."""
    # API Keys
    assert "API_KEY_OR_PRIVATE_KEY_DETECTED" in DlpScanner.scan_text("export OPENAI_API_KEY=sk-proj123456789012345678901234567890")
    assert "API_KEY_OR_PRIVATE_KEY_DETECTED" in DlpScanner.scan_text("ghp_123456789012345678901234567890123456")

    # SSN
    assert "SSN_DETECTED" in DlpScanner.scan_text("Client SSN is 123-45-6789 in report")

    # Valid Luhn Credit Card
    assert "CREDIT_CARD_DETECTED" in DlpScanner.scan_text("Card: 4532 0151 1283 0366")

    # Benign text
    assert DlpScanner.scan_text("Hello world, this is a normal search query.") == []
    assert DlpScanner.is_clean({"query": "python tutorials", "page": 1}) is True


@pytest.mark.asyncio
async def test_network_shield_route_handler_aborts_dlp_and_ssrf():
    """Verify that apply_network_shield intercepts and aborts SSRF and DLP leaks."""
    mock_page = MagicMock()
    mock_page.route = AsyncMock()

    policy = L7NetworkPolicy(primary_domain="safe-domain.com")
    await apply_network_shield(mock_page, policy=policy, scan_dlp=True)

    mock_page.route.assert_called_once()
    route_pattern, route_handler = mock_page.route.call_args[0]
    assert route_pattern == "**/*"

    # Test 1: SSRF request is aborted
    route_ssrf = MagicMock()
    route_ssrf.request.url = "http://169.254.169.254/latest/meta-data"
    route_ssrf.request.resource_type = "xhr"
    route_ssrf.request.method = "GET"
    route_ssrf.abort = AsyncMock()
    route_ssrf.continue_ = AsyncMock()

    await route_handler(route_ssrf)
    route_ssrf.abort.assert_awaited_once()
    route_ssrf.continue_.assert_not_called()

    # Test 2: DLP exfiltration in POST payload is aborted
    route_dlp = MagicMock()
    route_dlp.request.url = "https://safe-domain.com/upload"
    route_dlp.request.resource_type = "xhr"
    route_dlp.request.method = "POST"
    route_dlp.request.post_data = '{"token": "ghp_123456789012345678901234567890123456"}'
    route_dlp.abort = AsyncMock()
    route_dlp.continue_ = AsyncMock()

    await route_handler(route_dlp)
    route_dlp.abort.assert_awaited_once()
    route_dlp.continue_.assert_not_called()
