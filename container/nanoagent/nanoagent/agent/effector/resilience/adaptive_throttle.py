"""Ported from computer-use/adaptive-throttle.ts. Per-domain token-bucket rate
limiting (avoids tripping a site's own bot-defense rate limits) plus an organic
reading-dwell simulator with realistic micro-scrolls."""

from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field

from loguru import logger


@dataclass
class DomainQuota:
    capacity: int
    refill_interval_ms: int


DEFAULT_DOMAIN_QUOTAS: dict[str, DomainQuota] = {
    "linkedin.com": DomainQuota(capacity=4, refill_interval_ms=15000),
    "apollo.io": DomainQuota(capacity=8, refill_interval_ms=7500),
    "google.com": DomainQuota(capacity=12, refill_interval_ms=5000),
    "glassdoor.com": DomainQuota(capacity=6, refill_interval_ms=10000),
    "default": DomainQuota(capacity=25, refill_interval_ms=2400),
}


@dataclass
class _TokenBucketState:
    tokens: int
    last_refill_ms: float


class DomainRateLimiter:
    def __init__(self, custom_quotas: dict[str, DomainQuota] | None = None):
        self._buckets: dict[str, _TokenBucketState] = {}
        self._quotas = {**DEFAULT_DOMAIN_QUOTAS, **(custom_quotas or {})}

    def _get_quota(self, domain: str) -> DomainQuota:
        domain_lower = domain.lower()
        for key, quota in self._quotas.items():
            if key != "default" and key in domain_lower:
                return quota
        return self._quotas["default"]

    async def acquire(self, domain: str) -> int:
        """Acquire a token for `domain`; blocks (async sleep) if the bucket is
        empty. Returns the number of milliseconds waited (0 if none)."""
        quota = self._get_quota(domain)
        now = time.monotonic() * 1000
        state = self._buckets.get(domain)

        if state is None:
            self._buckets[domain] = _TokenBucketState(tokens=quota.capacity - 1, last_refill_ms=now)
            return 0

        elapsed = now - state.last_refill_ms
        tokens_to_add = int(elapsed // quota.refill_interval_ms)
        if tokens_to_add > 0:
            state.tokens = min(quota.capacity, state.tokens + tokens_to_add)
            state.last_refill_ms = now - (elapsed % quota.refill_interval_ms)

        if state.tokens > 0:
            state.tokens -= 1
            return 0

        wait_ms = quota.refill_interval_ms - (now - state.last_refill_ms) + random.randint(0, 500)
        wait_ms = max(0, int(wait_ms))
        logger.info(f"adaptive-throttle: rate-limit active for {domain}, pacing {wait_ms}ms")

        await asyncio.sleep(wait_ms / 1000)
        state.tokens = 0
        state.last_refill_ms = time.monotonic() * 1000
        return wait_ms


global_domain_rate_limiter = DomainRateLimiter()


async def execute_human_reading_dwell(page, content_sample: str = "") -> None:
    """Pause on the page with realistic micro-scrolls, roughly simulating human
    reading time for `content_sample` (~200-250 wpm, scaled for a UI pause)."""
    word_count = len([w for w in content_sample.split() if w])
    base_dwell = min(2500, max(500, word_count * 25))
    jitter = int((random.random() - 0.5) * 400)
    total_dwell = base_dwell + jitter

    try:
        scroll_amount = 80 + random.randint(0, 139)
        await page.mouse.wheel(0, scroll_amount)
        await page.wait_for_timeout(total_dwell / 2)
        if random.random() > 0.6:
            await page.mouse.wheel(0, -int(scroll_amount * 0.3))
        await page.wait_for_timeout(total_dwell / 2)
    except Exception:
        await page.wait_for_timeout(total_dwell)
