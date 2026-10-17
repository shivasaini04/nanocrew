"""
Credential access helper for nanoagent agent tools.

Tools running inside agent containers access external service credentials via
environment variables injected by the NanoCrew orchestrator (NanobotCycleRunner).

The CREDENTIAL_ENV_MAP below is the single source of truth for which env var
name carries each credential field. It must stay in sync with the TypeScript
counterpart in:
    nanocrew-main/src/agents/nanoagent-cycle-runner.ts → CREDENTIAL_ENV_MAP

Usage
-----
    from nanoagent.agent.tools.credentials import get_credential, require_credential

    # Returns None if not configured — use for optional credentials
    api_key = get_credential('apollo', 'api_key')

    # Raises CredentialMissingError with a clear message — use for mandatory ones
    refresh_token = require_credential('gmail', 'refresh_token')

    # Check before starting work that requires multiple fields
    if not is_connected('gmail'):
        return "Gmail is not connected. Add credentials in the NanoCrew dashboard."

    # Get all available fields for a service at once
    creds = get_all_credentials('gmail')  # {'client_id': '...', 'refresh_token': '...', ...}
"""

import os
from typing import Optional


# ── Credential map ────────────────────────────────────────────────────────────
# service → field → env var name
# Must stay in sync with CREDENTIAL_ENV_MAP in nanoagent-cycle-runner.ts

CREDENTIAL_ENV_MAP: dict[str, dict[str, str]] = {
    "apollo": {
        "api_key": "APOLLO_API_KEY",
    },
    "gmail": {
        "client_id":     "GMAIL_CLIENT_ID",
        "client_secret": "GMAIL_CLIENT_SECRET",
        "refresh_token": "GMAIL_REFRESH_TOKEN",
        "email":         "GMAIL_EMAIL",
    },
    "twitter": {
        "bearer_token": "TWITTER_BEARER_TOKEN",
        "api_key":      "TWITTER_API_KEY",
        "api_secret":   "TWITTER_API_SECRET",
    },
    "linkedin": {
        "session_cookie": "LINKEDIN_SESSION_COOKIE",
    },
    # X/Twitter via an authenticated browser session, not the official API — the API's
    # search tier is priced far above what lead research justifies. auth_token and ct0
    # are the two session cookies X sets on login; ct0 doubles as the CSRF token its own
    # frontend sends. The Browserbase pair is optional: without it the tool falls back to
    # the container's local Chromium, which works but exposes the server's datacenter IP.
    "x": {
        "auth_token":            "X_AUTH_TOKEN",
        "ct0":                   "X_CT0",
        "browserbase_api_key":   "BROWSERBASE_API_KEY",
        "browserbase_project_id": "BROWSERBASE_PROJECT_ID",
    },
    "hunter": {
        "api_key": "HUNTER_API_KEY",
    },
}


# ── Error type ─────────────────────────────────────────────────────────────────

class CredentialMissingError(Exception):
    """Raised when a required credential is not available in the environment."""

    def __init__(self, service: str, field: str, env_var: str):
        self.service = service
        self.field = field
        self.env_var = env_var
        super().__init__(
            f"Credential '{service}.{field}' is not configured. "
            f"Connect the '{service}' service in the NanoCrew dashboard "
            f"(sets the {env_var} environment variable)."
        )


# ── Public API ─────────────────────────────────────────────────────────────────

def get_credential(service: str, field: str) -> Optional[str]:
    """
    Get a credential value from the environment.

    Returns None if the service/field mapping is unknown or the env var is not set.
    Use this for optional credentials.

    Args:
        service: Service name, e.g. 'apollo', 'gmail', 'twitter'.
        field:   Credential field, e.g. 'api_key', 'refresh_token'.

    Returns:
        The credential value string, or None.
    """
    env_var = CREDENTIAL_ENV_MAP.get(service, {}).get(field)
    if not env_var:
        return None
    return os.environ.get(env_var) or None


def require_credential(service: str, field: str) -> str:
    """
    Get a credential value, raising CredentialMissingError if not available.

    Use this for credentials that are mandatory — the tool cannot function
    without them. The error message tells the user exactly what to configure.

    Args:
        service: Service name, e.g. 'apollo', 'gmail'.
        field:   Credential field, e.g. 'api_key', 'refresh_token'.

    Returns:
        The credential value (guaranteed non-empty string).

    Raises:
        CredentialMissingError: If the env var is not set or empty.
    """
    env_var = CREDENTIAL_ENV_MAP.get(service, {}).get(field)
    if not env_var:
        # Unknown service/field — fall back to a conventional name
        env_var = f"{service.upper()}_{field.upper()}"
    value = os.environ.get(env_var)
    if not value:
        raise CredentialMissingError(service, field, env_var)
    return value


def get_all_credentials(service: str) -> dict[str, str]:
    """
    Get all available credential fields for a service.

    Returns only fields whose env vars are actually set. Missing fields
    are silently omitted. Check the result length or call is_connected()
    first if you need to verify the service is configured.

    Args:
        service: Service name, e.g. 'gmail'.

    Returns:
        Dict mapping field name → value for all configured fields.
    """
    result: dict[str, str] = {}
    for field, env_var in CREDENTIAL_ENV_MAP.get(service, {}).items():
        value = os.environ.get(env_var)
        if value:
            result[field] = value
    return result


def is_connected(service: str) -> bool:
    """
    Check if at least one credential field is configured for a service.

    Useful for an early-exit check before starting work that requires
    external authentication.

    Args:
        service: Service name, e.g. 'apollo'.

    Returns:
        True if any credential field for this service is set.
    """
    return bool(get_all_credentials(service))
