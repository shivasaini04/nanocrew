"""Quickly verify whether a URL is actually reachable + returns content.

Purpose: stop LLMs from citing hallucinated URLs in agent-produced artifacts.
This is THE answer to the May 2026 incident where Researcher v2 invented
``https://netbird.io/blog/ai-at-netbird`` (404), Lead Finder propagated it,
and Sales drafted a cold-outreach opener that quoted a post that didn't
exist — the kind of fabrication that would have killed AxonCrew's first
real cold-email batch on contact.

The tool returns enough signal for the LLM to make the right call:
- ``status`` — HTTP status code (0 = no response)
- ``reachable`` — true iff 200–299
- ``redirected`` — true if final URL differs from input (common: post slug
  doesn't exist, server redirects to blog index, which IS 200 — but the
  specific path the LLM wanted to cite is fake)
- ``final_url`` — where we landed after redirects
- ``warning`` — short human-readable hint for the common bad-case patterns

When ``redirected=true``, the LLM should NOT treat the cited URL as
verifying any specific-page claim — the post may not exist; only the
redirect destination does. Verify content with web_fetch in that case.
"""

import json
import os
from typing import Any

import httpx

from nanoagent.agent.tools.base import Tool


_USER_AGENT = (
    "Mozilla/5.0 (compatible; AxonCrew-LinkChecker/1.0; +https://example.com)"
)
_TIMEOUT_SECONDS = float(os.environ.get("URL_CHECK_TIMEOUT", "10"))


class UrlCheckTool(Tool):
    """Verify a URL is reachable and returns 200 before citing it in an artifact."""

    name = "url_check"
    description = (
        "Verify a URL is reachable BEFORE citing it as a source in any artifact "
        "(dossier, qualified-leads file, draft, etc). Returns status code, whether "
        "it returned 2xx, whether it was redirected (the cited path may not exist), "
        "and the final URL after redirects. MANDATORY for any URL you produce — LLMs "
        "(including you) often hallucinate URLs that look plausible but 404. If "
        "status != 200 or redirected=true, DO NOT cite the URL as evidence of the "
        "specific claim — find another source, or drop the claim. "
        "Latency: ~0.5–10 seconds per check."
    )
    parameters = {
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "Full URL to verify, including scheme (e.g. 'https://example.com/blog/post-title').",
            },
        },
        "required": ["url"],
    }

    async def execute(self, url: str, **kwargs: Any) -> str:
        target = (url or "").strip()
        if not target or not target.lower().startswith(("http://", "https://")):
            return json.dumps({
                "status": 0,
                "reachable": False,
                "url": target,
                "warning": "Input is not a valid http(s) URL — provide the full URL including scheme.",
            })

        async with httpx.AsyncClient(
            timeout=httpx.Timeout(_TIMEOUT_SECONDS, connect=5.0),
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            # Prefer HEAD (no body — cheap). Some servers/CDNs reject HEAD with
            # 405 or 5xx; fall back to GET in that case (still no body parsing).
            try:
                resp = await client.head(target)
                if resp.status_code in (403, 405) or resp.status_code >= 500:
                    resp = await client.get(target)
            except httpx.TimeoutException:
                return json.dumps({
                    "status": 0,
                    "reachable": False,
                    "url": target,
                    "warning": f"Timeout after {_TIMEOUT_SECONDS}s — server slow or blocking. Do not cite without an alternative confirmation.",
                })
            except httpx.RequestError as exc:
                return json.dumps({
                    "status": 0,
                    "reachable": False,
                    "url": target,
                    "warning": f"Connection error ({exc.__class__.__name__}): {str(exc)[:200]}. URL is not reachable from this network — do not cite.",
                })

        final_url = str(resp.url)
        # Treat trailing-slash differences as not-redirected (common server normalization).
        redirected = final_url.rstrip("/") != target.rstrip("/")
        content_type = (resp.headers.get("content-type", "") or "").split(";")[0].strip()

        result: dict[str, Any] = {
            "status": resp.status_code,
            "reachable": 200 <= resp.status_code < 300,
            "url": target,
            "final_url": final_url if redirected else target,
            "redirected": redirected,
            "content_type": content_type,
        }

        if resp.status_code == 404:
            result["warning"] = (
                "URL returned 404 — the page DOES NOT EXIST. Do not cite this URL as evidence of any claim. "
                "If you generated this URL from a pattern, the page is hallucinated; find the real source."
            )
        elif resp.status_code in (401, 403):
            result["warning"] = (
                f"URL returned {resp.status_code} — page requires auth or is forbidden. "
                "Do not cite as a public source."
            )
        elif resp.status_code >= 400:
            result["warning"] = (
                f"URL returned {resp.status_code} — page is not accessible. Do not cite."
            )
        elif redirected:
            result["warning"] = (
                f"URL redirected from {target} to {final_url}. The original path likely does not exist as a standalone page — "
                "the cited URL only proves the redirect destination, not the specific claim attached to the original path. "
                "If your claim was about a specific post/page, verify with web_fetch that the destination actually contains it."
            )

        return json.dumps(result, ensure_ascii=False)
