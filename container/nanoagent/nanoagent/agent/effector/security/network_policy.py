"""Zero-Trust L7 Network Policy & SSRF Protection for Effector.

Enforces task-scoped domain allowlists and blocks all SSRF, loopback, private RFC 1918,
and cloud instance metadata endpoints (169.254.169.254).
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse
from typing import Iterable

from loguru import logger

_CLOUD_METADATA_IPS = {"169.254.169.254", "fd00:ec2::254"}
_BLOCKED_SCHEMES = {"file:", "gopher:", "ftp:", "dict:", "ldap:", "tftp:"}

# Common CDNs and auth providers that legitimate web apps depend on
_DEFAULT_GLOBAL_ALLOWLIST = {
    "fonts.googleapis.com",
    "fonts.gstatic.com",
    "cdnjs.cloudflare.com",
    "cdn.jsdelivr.net",
    "unpkg.com",
}


def is_private_or_metadata_host(host: str) -> bool:
    """True if host is localhost, private subnet, link-local, or cloud metadata."""
    raw = host.strip().lower()
    if raw.startswith("[") and "]:" in raw:
        clean_host = raw.split("]:")[0].strip("[")
    elif raw.startswith("[") and raw.endswith("]"):
        clean_host = raw.strip("[]")
    elif raw.count(":") == 1:
        clean_host = raw.split(":")[0]
    else:
        clean_host = raw

    if clean_host in ("localhost", "127.0.0.1", "::1"):
        return True

    if clean_host in _CLOUD_METADATA_IPS:
        return True

    try:
        ip = ipaddress.ip_address(clean_host)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
        )
    except ValueError:
        # Host is a domain name, not a raw IP
        pass

    # Check for metadata domain patterns
    if re.search(r"metadata\.google\.internal|169\.254\.169\.254", clean_host):
        return True

    return False


class L7NetworkPolicy:
    """Enforces fine-grained L7 egress policies per Effector session."""

    def __init__(
        self,
        primary_domain: str | None = None,
        extra_allowed_domains: Iterable[str] | None = None,
        enforce_allowlist: bool = True,
        block_ssrf: bool = True,
    ):
        self.primary_domain = primary_domain.lower() if primary_domain else None
        self.enforce_allowlist = enforce_allowlist
        self.block_ssrf = block_ssrf
        self.allowed_domains = set(_DEFAULT_GLOBAL_ALLOWLIST)

        if self.primary_domain:
            self.allowed_domains.add(self.primary_domain)
            # Add apex domain if subdomain was passed (e.g. www.linkedin.com -> linkedin.com)
            parts = self.primary_domain.split(".")
            if len(parts) >= 2:
                apex = ".".join(parts[-2:])
                self.allowed_domains.add(apex)

        if extra_allowed_domains:
            for d in extra_allowed_domains:
                self.allowed_domains.add(d.lower())

    def add_allowed_domain(self, domain: str) -> None:
        self.allowed_domains.add(domain.lower())

    def evaluate_url(self, url: str) -> tuple[bool, str]:
        """Evaluates URL against policy. Returns (is_allowed, reason)."""
        if not url:
            return False, "Empty URL"

        parsed = urlparse(url)
        scheme = (parsed.scheme or "").lower() + ":"

        if scheme in _BLOCKED_SCHEMES:
            return False, f"Blocked dangerous scheme: {scheme}"

        if scheme not in ("http:", "https:", "ws:", "wss:", "data:", "blob:"):
            return False, f"Unsupported scheme: {scheme}"

        if scheme in ("data:", "blob:"):
            # Data and blob URLs are local memory buffers
            return True, "Local pseudo-scheme"

        host = parsed.hostname or ""
        if not host:
            return False, "Missing hostname"

        # Check SSRF / Link-Local / Cloud Metadata
        if self.block_ssrf and is_private_or_metadata_host(host):
            logger.warning(f"network_policy: BLOCKED SSRF / Private IP attempt to '{url}'")
            return False, f"Blocked private/metadata endpoint: {host}"

        # If allowlist enforcement is active and a primary domain is configured
        if self.enforce_allowlist and self.primary_domain:
            host_lower = host.lower()
            matched = any(
                host_lower == allowed or host_lower.endswith(f".{allowed}")
                for allowed in self.allowed_domains
            )
            if not matched:
                logger.debug(f"network_policy: URL '{host_lower}' not in task allowlist {self.allowed_domains}")
                return False, f"Egress domain '{host_lower}' not permitted by task allowlist"

        return True, "Allowed"
