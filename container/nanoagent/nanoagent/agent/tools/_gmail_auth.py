"""Shared Gmail OAuth helper used by gmail_send and gmail_replies."""

import httpx

from nanoagent.agent.tools.credentials import require_credential


async def get_access_token() -> str:
    """
    Exchange the stored Gmail refresh token for a short-lived access token.

    Reads GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN from
    the environment via the credentials helper.

    Returns:
        A valid access token string.

    Raises:
        CredentialMissingError: If any required credential is not set.
        RuntimeError: If the token exchange request fails.
    """
    refresh_token = require_credential("gmail", "refresh_token")
    client_id     = require_credential("gmail", "client_id")
    client_secret = require_credential("gmail", "client_secret")

    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "refresh_token": refresh_token,
                "client_id":     client_id,
                "client_secret": client_secret,
                "grant_type":    "refresh_token",
            },
            timeout=15.0,
        )

    data = res.json()
    access_token = data.get("access_token")
    if not access_token:
        raise RuntimeError(
            f"Gmail token refresh failed: {data.get('error', 'unknown error')} — "
            f"{data.get('error_description', '')}"
        )
    return access_token
