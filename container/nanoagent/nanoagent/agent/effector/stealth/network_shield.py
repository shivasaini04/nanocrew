"""Ported from computer-use/network-shield.ts. Blocks analytics/tracking beacons and
heavy media to speed up page loads and cut proxy bandwidth, plus a structured
API-response interceptor for sites that expose their data as JSON over the wire
(LinkedIn Voyager, Salesforce REST, Workday GraphQL, etc.)."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from loguru import logger

TRACKING_DOMAINS = [
    "google-analytics.com", "googletagmanager.com", "doubleclick.net",
    "facebook.net", "facebook.com/tr", "bat.bing.com", "segment.io",
    "segment.com", "hotjar.com", "clarity.ms", "optimizely.com",
    "fullstory.com", "mixpanel.com", "datadoghq-browser-agent.com",
]

BLOCKED_MEDIA_EXTENSIONS = [
    re.compile(r"\.(mp4|webm|avi|mov|flv|m4v)(\?.*)?$", re.IGNORECASE),
    re.compile(r"\.(mp3|wav|ogg|aac)(\?.*)?$", re.IGNORECASE),
]


async def apply_network_shield(
    page,
    block_trackers: bool = True,
    block_heavy_media: bool = True,
    policy: Any | None = None,
    scan_dlp: bool = True,
    canary: Any | None = None,
) -> None:
    """Blocks tracking beacons, heavy media, SSRF/link-local metadata leaks, and
    scans outbound payloads for PII/credential exfiltration.

    `canary` (R5) is the run's CanaryGuard. The loop already checks every step before
    it executes; this is the second checkpoint, for a leak that never passes through a
    Step at all — page JS reading our instruction text and POSTing it via fetch/XHR."""
    from nanoagent.agent.effector.security.dlp_scanner import DlpScanner
    from nanoagent.agent.effector.security.network_policy import L7NetworkPolicy

    net_policy = policy if isinstance(policy, L7NetworkPolicy) else None

    async def handler(route):
        request = route.request
        url = request.url
        url_lower = url.lower()
        resource_type = request.resource_type

        # L7 Policy & SSRF Evaluation
        if net_policy is not None:
            allowed, reason = net_policy.evaluate_url(url)
            if not allowed:
                logger.debug(f"network-shield: blocked by policy ({reason}) — {url}")
                try:
                    await route.abort()
                except Exception:
                    pass
                return

        # Tracker Blocker
        if block_trackers and any(d in url_lower for d in TRACKING_DOMAINS):
            try:
                await route.abort()
            except Exception:
                pass
            return

        # Heavy Media Blocker
        if block_heavy_media and (resource_type == "media" or any(p.search(url_lower) for p in BLOCKED_MEDIA_EXTENSIONS)):
            try:
                await route.abort()
            except Exception:
                pass
            return

        # DLP Exfiltration Scanner on Outbound POST/PUT data
        req_method = getattr(request, "method", "GET")
        if scan_dlp and req_method in ("POST", "PUT", "PATCH"):
            post_data = getattr(request, "post_data", None)
            if post_data and not DlpScanner.is_clean(post_data):
                logger.warning(f"network-shield: BLOCKED outbound request to {url} due to DLP exfiltration trigger")
                try:
                    await route.abort()
                except Exception:
                    pass
                return

            # R5: the run's own integrity token must never leave the browser.
            if canary is not None and post_data and canary.is_leaked(post_data):
                logger.critical(
                    f"network-shield: BLOCKED outbound request to {url} carrying the "
                    f"run's internal integrity token — control-plane text is being exfiltrated"
                )
                try:
                    await route.abort()
                except Exception:
                    pass
                return

        try:
            await route.continue_()
        except Exception:
            pass

    await page.route("**/*", handler)


@dataclass
class InterceptedApiResponse:
    url: str
    method: str
    status: int
    data: Any
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class ApiResponseInterceptor:
    """Captures structured JSON payloads directly from the browser's network stream —
    for sites where the data the task needs already arrives as a fetch/XHR response,
    cheaper and more reliable than scraping the rendered DOM for it."""

    def __init__(self, page, url_patterns: list[re.Pattern]):
        self._page = page
        self._patterns = url_patterns
        self._intercepted: list[InterceptedApiResponse] = []
        self._pending: asyncio.Future | None = None
        page.on("response", self._handle_response)

    async def _handle_response(self, response) -> None:
        url = response.url
        if not any(p.search(url) for p in self._patterns):
            return
        if not response.ok:
            return
        try:
            content_type = (await response.header_value("content-type")) or ""
            if "application/json" not in content_type and "application/graphql" not in content_type:
                return
            data = await response.json()
        except Exception:
            return  # streaming or non-JSON payload — ignore

        item = InterceptedApiResponse(
            url=url, method=response.request.method, status=response.status, data=data,
        )
        self._intercepted.append(item)
        logger.debug(f"network-shield: intercepted API response {url} status={response.status}")

        if self._pending is not None and not self._pending.done():
            self._pending.set_result(item)

    def get_responses(self) -> list[InterceptedApiResponse]:
        return list(self._intercepted)

    async def wait_for_response(self, timeout_ms: int = 5000) -> InterceptedApiResponse | None:
        if self._intercepted:
            return self._intercepted[-1]

        self._pending = asyncio.get_event_loop().create_future()
        try:
            return await asyncio.wait_for(self._pending, timeout=timeout_ms / 1000)
        except asyncio.TimeoutError:
            return None
        finally:
            self._pending = None

    def clear(self) -> None:
        self._intercepted.clear()


def create_api_response_interceptor(page, url_patterns: list[re.Pattern]) -> ApiResponseInterceptor:
    return ApiResponseInterceptor(page, url_patterns)
