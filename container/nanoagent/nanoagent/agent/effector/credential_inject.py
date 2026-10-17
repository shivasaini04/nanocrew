"""Credential resolution and TOTP auto-generation for Effector.

Steps can carry `credential_ref="service:field"` to pull a stored credential at execution time
rather than the model ever seeing (or the action log ever recording) the plaintext.

Supports:
1. Standard fields (username, password, api_key)
2. Dynamic TOTP generation (`service:totp` or `service:otp` calculating 6-digit RFC 6238 tokens)
"""

from __future__ import annotations

import os

from nanoagent.agent.effector.credentials.totp_engine import generate_totp_code


def has_credential_ref(ref: str | None) -> bool:
    """True if a step references a credential that should be injected."""
    return isinstance(ref, str) and ":" in ref


async def resolve_credential_ref(ref: str) -> str | None:
    """Resolve a `credential_ref` string ("service:field") to its plaintext value.
    If field is 'totp' or 'otp', dynamically computes the current 6-digit TOTP code.
    Returns None if not found or if credentials aren't reachable."""
    colon_idx = ref.find(":")
    if colon_idx == -1:
        return None

    service = ref[:colon_idx].strip()
    field = ref[colon_idx + 1:].strip()
    if not service or not field:
        return None

    # Check local environment fallback for standalone/local runs
    env_key = f"{service.upper()}_{field.upper()}"
    if env_key in os.environ:
        val = os.environ[env_key]
        if field.lower() in ("totp", "otp"):
            return generate_totp_code(val)
        return val

    # Check if a TOTP secret is in env when requesting totp/otp
    if field.lower() in ("totp", "otp"):
        totp_secret_key = f"{service.upper()}_TOTP_SECRET"
        if totp_secret_key in os.environ:
            return generate_totp_code(os.environ[totp_secret_key])

    try:
        import httpx
    except ImportError:
        return None

    agent_id = os.environ.get("AGENT_ID", "")
    cycle_id = os.environ.get("CYCLE_ID", "")
    host = os.environ.get("NanoCrew_HOST", "http://host.docker.internal:3002")
    token = os.environ.get("NANOCREW_CYCLE_TOKEN", "")

    if not agent_id or not token:
        return None

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{host}/api/agents/{agent_id}/credentials/browser:{service}",
                headers={"Authorization": f"Bearer {token}", "X-Cycle-Id": cycle_id},
                timeout=10,
            )
        if resp.status_code >= 400:
            return None
        data = resp.json()

        if field.lower() in ("totp", "otp"):
            secret = data.get("totp_secret") or data.get("secret") or data.get("totp")
            if secret:
                return generate_totp_code(secret)

        return data.get(field)
    except Exception:
        return None
