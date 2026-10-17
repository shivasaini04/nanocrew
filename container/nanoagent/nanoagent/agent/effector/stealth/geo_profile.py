"""Timezone/locale resolution for a browser context — the layer the fingerprint
script cannot fix from inside the page.

Review finding, 2026-08-30: `browser_session.py` built every context with
viewport + user_agent + storage_state and nothing else, so `Intl.DateTimeFormat()
.resolvedOptions().timeZone` reported the container's own zone (UTC — the image
sets no TZ) while the request arrived from a DataImpulse residential exit that
geolocates to a US city. A UTC clock behind a US-East IP is one of the cheapest
and most universally-applied checks there is, and no amount of navigator patching
touches it.

So: when a session routes through the residential pool, ask the pool's own exit
node where it is, and hand Playwright a matching `timezone_id`/`locale`. Falls
back to a plausible US profile rather than UTC — a datacenter clock is a worse
answer than a slightly wrong city, since "UTC" is itself the tell.

The lookup is one cheap HTTP call, cached per proxy identity for the process, and
never fatal: a failed or slow probe degrades to the default, matching every other
"degrade, don't break the agent's real work" contract in this package.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from loguru import logger

# Deliberately not UTC. An unproxied session egresses from the host datacenter and
# there is no "correct" answer for it either — but a real consumer browser almost
# never reports UTC, so the default is a common US zone consistent with the
# `en-US` languages the fingerprint script already claims.
DEFAULT_TIMEZONE = "America/New_York"
DEFAULT_LOCALE = "en-US"

_LOOKUP_URL = "http://ip-api.com/json/?fields=status,timezone,countryCode"
_LOOKUP_TIMEOUT_S = 5.0
_CACHE_TTL_S = 1800.0

# Country -> (locale, Accept-Language). Only the countries a residential pool
# realistically exits from for this repo's target sites; anything else falls back
# to the default rather than inventing a locale we have no font/voice story for.
_COUNTRY_LOCALES: dict[str, tuple[str, str]] = {
    "US": ("en-US", "en-US,en;q=0.9"),
    "CA": ("en-CA", "en-CA,en;q=0.9"),
    "GB": ("en-GB", "en-GB,en;q=0.9"),
    "AU": ("en-AU", "en-AU,en;q=0.9"),
    "IE": ("en-IE", "en-IE,en;q=0.9"),
    "NZ": ("en-NZ", "en-NZ,en;q=0.9"),
    "IN": ("en-IN", "en-IN,en;q=0.9"),
    "DE": ("de-DE", "de-DE,de;q=0.9,en;q=0.8"),
    "FR": ("fr-FR", "fr-FR,fr;q=0.9,en;q=0.8"),
    "NL": ("nl-NL", "nl-NL,nl;q=0.9,en;q=0.8"),
    "ES": ("es-ES", "es-ES,es;q=0.9,en;q=0.8"),
    "BR": ("pt-BR", "pt-BR,pt;q=0.9,en;q=0.8"),
    "SG": ("en-SG", "en-SG,en;q=0.9"),
}


@dataclass(frozen=True)
class GeoProfile:
    """What the browser context should claim about where it is."""

    timezone_id: str
    locale: str
    accept_language: str
    source: str  # 'env' | 'proxy-lookup' | 'default' — logged, and asserted in tests

    @property
    def languages(self) -> tuple[str, ...]:
        """`navigator.languages`, derived from accept_language so the JS value and
        the HTTP header can't disagree — a mismatch between them is its own signal."""
        out: list[str] = []
        for part in self.accept_language.split(","):
            tag = part.split(";")[0].strip()
            if tag and tag not in out:
                out.append(tag)
        return tuple(out) or (self.locale,)


_DEFAULT_PROFILE = GeoProfile(
    timezone_id=DEFAULT_TIMEZONE,
    locale=DEFAULT_LOCALE,
    accept_language="en-US,en;q=0.9",
    source="default",
)

_cache: dict[str, tuple[float, GeoProfile]] = {}


def _from_env() -> GeoProfile | None:
    """`EFFECTOR_TIMEZONE`/`EFFECTOR_LOCALE` win over any probe — an operator who
    knows which region their pool exits from shouldn't pay for a lookup, and a
    pinned pool should not drift session to session."""
    tz = os.environ.get("EFFECTOR_TIMEZONE", "").strip()
    loc = os.environ.get("EFFECTOR_LOCALE", "").strip()
    if not tz and not loc:
        return None
    locale = loc or DEFAULT_LOCALE
    country = locale.split("-")[-1].upper()
    _, accept = _COUNTRY_LOCALES.get(country, (locale, f"{locale},{locale.split('-')[0]};q=0.9"))
    return GeoProfile(
        timezone_id=tz or DEFAULT_TIMEZONE,
        locale=locale,
        accept_language=accept,
        source="env",
    )


async def resolve_geo_profile(proxy_url: str | None) -> GeoProfile:
    """Where this session should claim to be.

    `proxy_url` is the httpx-shaped residential URL (`get_proxy_url()`), or None for
    a direct session. With a proxy, the probe runs THROUGH it — that's the whole
    point: we need the exit node's location, not the container's.
    """
    env_profile = _from_env()
    if env_profile is not None:
        return env_profile

    if not proxy_url:
        return _DEFAULT_PROFILE

    now = time.monotonic()
    cached = _cache.get(proxy_url)
    if cached is not None and (now - cached[0]) < _CACHE_TTL_S:
        return cached[1]

    profile = await _probe_exit_node(proxy_url)
    _cache[proxy_url] = (now, profile)
    return profile


async def _probe_exit_node(proxy_url: str) -> GeoProfile:
    try:
        import httpx

        async with httpx.AsyncClient(proxy=proxy_url, timeout=_LOOKUP_TIMEOUT_S) as client:
            response = await client.get(_LOOKUP_URL)
        data = response.json()
    except Exception as err:
        logger.debug(f"effector: proxy geo probe failed, using default timezone — {err}")
        return _DEFAULT_PROFILE

    if not isinstance(data, dict) or data.get("status") != "success":
        logger.debug("effector: proxy geo probe returned no location, using default timezone")
        return _DEFAULT_PROFILE

    timezone_id = str(data.get("timezone") or "").strip() or DEFAULT_TIMEZONE
    country = str(data.get("countryCode") or "").strip().upper()
    locale, accept = _COUNTRY_LOCALES.get(country, (DEFAULT_LOCALE, "en-US,en;q=0.9"))

    logger.debug(f"effector: proxy exit node is in {country or '??'} — claiming timezone {timezone_id}, locale {locale}")
    return GeoProfile(
        timezone_id=timezone_id,
        locale=locale,
        accept_language=accept,
        source="proxy-lookup",
    )


def reset_geo_cache() -> None:
    """Tests only — the module-level cache is keyed by proxy URL and would otherwise
    leak a probe result from one test into the next."""
    _cache.clear()
