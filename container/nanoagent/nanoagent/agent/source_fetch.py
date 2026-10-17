"""source_fetch — one HTTP capability for every rate-limited source, built-in or generated.

Why this exists
---------------
Before this, the protections that keep a scraped source alive lived *inside* each
bespoke tool, as module constants and hand-written comments:

  * ``linkedin_jobs._CRAWL_DELAY_S`` — "the main thing protecting it — do not lower it"
  * ``linkedin_jobs._fetch()``       — "HTTP 429 ... the one failure that must never be
    retried into. Losing this endpoint costs the source"
  * ``yc_jobs._ROLE_COOLDOWN_S``, ``_PER_CYCLE_REQUESTS``, and a per-tool pace file

That works exactly as long as the only code touching linkedin.com is the 800-line tool
that carries the knowledge. It stops working the moment an agent writes its own tool —
the new tool starts with none of it, and the first thing it can do is burn an endpoint
that no amount of regeneration will bring back.

So the knowledge moves here, keyed by **destination domain**, and any caller that fetches
through this module inherits it for free. Three properties follow, and each closes a
specific hole:

1. **Proxy routes on the domain, never on the tool's name.** ``proxy_config`` already
   routes effector this way via ``should_route_through_proxy``; only the HTTP tools used
   the name allowlist. A name allowlist both over-proxies (yc_jobs sent ycombinator.com
   through paid residential bandwidth, which never needed it) and under-proxies (anything
   the agent generates hits linkedin.com from the datacenter IP and gets silence, not an
   error). Domain routing fixes both directions and is strictly cheaper.

2. **State is keyed by domain, not by tool.** A regenerated tool with a new name inherits
   the same budget, the same pacing clock and the same rate-limit flag as the tool it
   replaced, instead of starting clean and re-hammering.

3. **State is flushed after every request, not at the end of a sweep.** Learned the hard
   way on Crawler a live cycle (2026-09-09): the daemon was killed mid-sweep, and
   because ``linkedin_jobs`` only called ``_save_state`` on completion, that run's request
   count and query cooldowns were never written. The retry started clean and re-ran all
   71 queries — LinkedIn saw both rounds and answered 429. Flush-per-request means a
   SIGKILL costs one request of accounting, not a whole sweep's worth.

Callers do not need ``os`` or ``socket``, which is what makes this reachable from an
agent-generated tool: the dynamic-tool security scanner (``agent/tools/dynamic/
security.py``) blocks those modules at the sandbox tier, so a generated tool cannot read
proxy credentials or open a socket itself. It can import this module and call ``fetch``.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from nanoagent.agent.proxy_config import get_proxy_url_for_url

# Where per-domain accounting lives. Sits next to the existing per-tool pace files rather
# than replacing them — this is additive, and a built-in keeps its own query cooldowns.
_STATE_PATH = Path("/workspace/group/.nanocrew/source_state.json")

# Operator/agent overrides, so a delay or budget can be retuned without an image rebuild.
# Shape: {"linkedin.com": {"crawl_delay_s": 4.0, "per_cycle_budget": 200}, ...}
_PROFILE_OVERRIDE_PATH = Path("/workspace/group/.nanocrew/source_profiles.json")

# How many past yields to keep per source for the zero-result canary.
_HISTORY_LEN = 12

# A 429 through the rotating residential pool is one exit IP's reputation, not the
# source's verdict: every fetch opens a new connection, and the gateway hands each new
# connection a new exit. Measured 2026-09-11 (Crawler a live cycle: linkedin.com
# answered 429 on the sweep's 6th request, the old latch ended LinkedIn for the whole cycle
# with 11 of 12 queries unrun, and six probes through the same pool a minute later were
# 6/6 200. So a proxied 429 is retried on a fresh exit, after a backoff, and the source is
# latched only when the 429s keep coming. From the datacenter IP there is no fresh exit to
# move to — a 429 there still latches on the first one.
_PROXIED_429_ATTEMPTS = 3       # consecutive 429s, each on a new exit, before latching
_PROXIED_429_CYCLE_CAP = 10     # proxied 429s in one cycle before latching regardless
_PROXIED_429_BACKOFF_S = 10.0   # times the attempt number, plus up to half that in jitter


def _env_int(name: str, default: int) -> int:
    """A budget read from the SAME env var the tool reads, with the same default.

    The first version of this file copied each tool's default budget by hand, and the copy
    was wrong the day it shipped: prod sets LI_PER_CYCLE_REQUESTS=600, the profile said
    300, and on 2026-09-10 a live cycle LinkedIn's sweep was refused at half its
    configured budget — listing spent all 300 and not one description was read, so none
    of 1,805 candidates could be judged. Reddit's copy was looser than the tool (90 vs 40)
    and OnlineJobs' tighter (90 vs 120). One number, one place.
    """
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    """Crawl delay from the tool's own env var — same reasoning as _env_int."""
    try:
        return float(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass
class SourceProfile:
    """What one domain costs to touch, and what must never be done to it.

    ``crawl_delay_s`` is a floor between requests to the same domain, shared across every
    caller in the process. ``jitter_s`` is added uniformly at random on top, so cadence is
    never machine-regular — x_search already did this, and it is the one thing that
    separates "slow" from "obviously a script".
    """

    domain: str
    crawl_delay_s: float = 3.0
    jitter_s: float = 0.0
    per_cycle_budget: int = 120
    # Statuses that mean "stop, and do not come back this cycle". Never retried by a caller;
    # the one internal retry is a 429 through the proxy, on a fresh exit (_PROXIED_429_*).
    stop_statuses: tuple[int, ...] = (429, 403)
    notes: str = ""


# Seeded from what the bespoke tools already measured. Every number here has a provenance
# comment in the tool it came from — this is a move, not a new guess.
_PROFILES: dict[str, SourceProfile] = {
    "linkedin.com": SourceProfile(
        domain="linkedin.com",
        crawl_delay_s=_env_float("LI_CRAWL_DELAY_S", 3.0),
        per_cycle_budget=_env_int("LI_PER_CYCLE_REQUESTS", 300),
        notes=(
            "Undocumented guest endpoint (/jobs-guest/jobs/api/seeMoreJobPostings/search); "
            "LinkedIn's terms prohibit scraping. Low-volume public-endpoint trade, not a "
            "foundation. Do not lower crawl_delay_s to go faster. A 429 was observed "
            "2026-09-09 a live cycle after a daemon eviction ran the same sweep twice — "
            "the endpoint is not as 429-free as linkedin_jobs.py's comment claims."
        ),
    ),
    "ycombinator.com": SourceProfile(
        domain="ycombinator.com",
        crawl_delay_s=_env_float("YC_CRAWL_DELAY_S", 2.0),
        per_cycle_budget=_env_int("YC_PER_CYCLE_REQUESTS", 1000),
        notes="Public job board. Does not need the residential pool — do not proxy it.",
    ),
    "reddit.com": SourceProfile(
        domain="reddit.com",
        crawl_delay_s=_env_float("REDDIT_MIN_GAP_S", 6.0),
        per_cycle_budget=_env_int("REDDIT_PER_CYCLE_REQUESTS", 40),
        # The one source where a 429 is NOT terminal, so it is deliberately absent here.
        # reddit_search's docstring records the measurement: roughly half of anonymous RSS
        # requests from a datacenter IP are refused, and its retry loop is "the load-bearing
        # part — without this a sweep reports 'no results' for queries that were simply
        # throttled". Latching on 429 here would convert a recoverable throttle into a dead
        # source for the rest of the cycle. A 403 is still a stop.
        stop_statuses=(403,),
        notes=(
            "old.reddit.com. Throttled, not banned, from the datacenter IP — a 429 is "
            "retryable here and reddit_search retries up to REDDIT_MAX_RETRIES. Routed "
            "through the residential pool, which is the real fix for the throttling."
        ),
    ),
    "onlinejobs.ph": SourceProfile(
        domain="onlinejobs.ph",
        crawl_delay_s=5.0,      # job_search._CRAWL_DELAY_S — the site publishes Crawl-delay: 5
        per_cycle_budget=_env_int("JOBS_PER_CYCLE_REQUESTS", 120),
        notes=(
            "robots.txt publishes Crawl-delay: 5 and this honours it — the one source here "
            "with a stated limit rather than an inferred one. The only rate limit in the "
            "log before 2026-09-09 came from this host (2026-08-07)."
        ),
    ),
    "x.com": SourceProfile(
        domain="x.com",
        crawl_delay_s=18.0,     # x_search._MIN_GAP_S
        jitter_s=14.0,          # x_search._JITTER_S
        per_cycle_budget=180,   # x_search._DAILY_CAP_MAX
        notes="Blocked from the Contabo egress IP. Cadence must not be machine-regular.",
    ),
}
_PROFILES["twitter.com"] = _PROFILES["x.com"]


@dataclass
class FetchResult:
    """Outcome of one fetch. ``ok`` is False for every non-200, including a stop status."""

    ok: bool
    status: int | None = None
    text: str = ""
    error: str | None = None
    proxied: bool = False
    source: str = ""
    # True when this source is finished for the cycle (budget spent or stop status seen).
    exhausted: bool = False
    # Requests that actually left the machine for this call — more than 1 when a proxied
    # 429 was retried on a fresh exit, 0 when the call was refused before the network.
    attempts: int = 0


def _norm_domain(url_or_domain: str) -> str:
    """Registrable-ish domain for keying. ``www.linkedin.com/jobs`` -> ``linkedin.com``."""
    raw = (url_or_domain or "").strip().lower()
    if not raw:
        return ""
    host = urlparse(raw).netloc if "//" in raw else raw.split("/")[0]
    host = (host or "").split("@")[-1].split(":")[0]
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 2:
        # Good enough for the sources in play; keeps `nz.linkedin.com` -> `linkedin.com`.
        return ".".join(parts[-2:])
    return host


def _load_profile_overrides() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(_PROFILE_OVERRIDE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def profile_for(url_or_domain: str) -> SourceProfile:
    """The profile for a URL's domain, with any on-disk override applied.

    An unknown domain gets the conservative default rather than "no limits" — a generated
    tool pointed at a source nobody has characterised should still be polite.
    """
    domain = _norm_domain(url_or_domain)
    base = _PROFILES.get(domain) or SourceProfile(domain=domain)
    override = _load_profile_overrides().get(domain)
    if not override:
        return base
    merged = asdict(base)
    for key in ("crawl_delay_s", "jitter_s", "per_cycle_budget", "notes"):
        if key in override:
            merged[key] = override[key]
    merged["stop_statuses"] = tuple(override.get("stop_statuses", base.stop_statuses))
    merged["domain"] = domain
    return SourceProfile(**merged)


# ── State: per domain, flushed per request ───────────────────────────────────


def _load_state() -> dict[str, Any]:
    try:
        data = json.loads(_STATE_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save_state(state: dict[str, Any]) -> None:
    """Write-then-rename, so a kill mid-write cannot leave a truncated file that would
    silently reset every budget to zero."""
    try:
        _STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = _STATE_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state), encoding="utf-8")
        tmp.replace(_STATE_PATH)
    except Exception:
        pass


def _cycle_id() -> str:
    return os.environ.get("CYCLE_ID", "") or "manual"


def _source_state(state: dict[str, Any], domain: str) -> dict[str, Any]:
    """This domain's slice, reset when the cycle changes.

    Note what is deliberately *not* reset: ``history``. The canary compares this cycle's
    yield against previous cycles, so it has to outlive them.
    """
    slot = state.setdefault(domain, {})
    cid = _cycle_id()
    if slot.get("cycle_id") != cid:
        slot["cycle_id"] = cid
        slot["requests"] = 0
        slot["rate_limited"] = False
        slot["stop_reason"] = None
        slot["proxied_429s"] = 0
    slot.setdefault("history", [])
    return slot


def is_rate_limited(url_or_domain: str) -> bool:
    """Whether this source has already said stop during the current cycle."""
    domain = _norm_domain(url_or_domain)
    return bool(_source_state(_load_state(), domain).get("rate_limited"))


def budget_remaining(url_or_domain: str) -> int:
    domain = _norm_domain(url_or_domain)
    prof = profile_for(domain)
    used = int(_source_state(_load_state(), domain).get("requests") or 0)
    return max(0, prof.per_cycle_budget - used)


def _make_client(proxy_url: str | None) -> Any:
    """The one place a client is constructed, so the proxy decision cannot be bypassed.

    Deliberately NOT a caller-supplied parameter. An earlier draft let callers pass their
    own ``httpx.AsyncClient``, which quietly defeats the whole point: a tool that builds
    its own client gets no proxy, reaches linkedin.com from the datacenter IP, and sees
    silence rather than an error. Tests monkeypatch this function instead.
    """
    import httpx

    return httpx.AsyncClient(follow_redirects=True, proxy=proxy_url)


async def fetch(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 45.0,
) -> FetchResult:
    """GET ``url`` with this source's pacing, proxy routing, budget and stop policy applied.

    Returns a FetchResult rather than raising, so a caller cannot accidentally retry into
    a stop status by wrapping the call in try/except. A stop status latches
    ``rate_limited`` for the rest of the cycle: every later call to the same domain
    returns immediately without touching the network. The one retry is internal and
    bounded: a 429 through the residential pool is retried on a fresh exit (see
    ``_PROXIED_429_ATTEMPTS``) before it is allowed to latch.
    """
    domain = _norm_domain(url)
    prof = profile_for(domain)
    state = _load_state()
    slot = _source_state(state, domain)

    if slot.get("rate_limited"):
        return FetchResult(
            ok=False,
            source=domain,
            exhausted=True,
            error=(
                f"{domain} returned {slot.get('stop_reason') or 'a stop status'} earlier this "
                f"cycle — not retried. This source is done until the next cycle."
            ),
        )

    proxy_url = get_proxy_url_for_url(url)
    attempts = 0

    while True:
        used = int(slot.get("requests") or 0)
        if used >= prof.per_cycle_budget:
            return FetchResult(
                ok=False,
                source=domain,
                exhausted=True,
                attempts=attempts,
                error=f"{domain} per-cycle budget spent ({used}/{prof.per_cycle_budget}).",
            )

        # Pace against the last request to THIS domain, whoever made it.
        gap = time.time() - float(slot.get("last_request_ts") or 0)
        delay = prof.crawl_delay_s + (random.uniform(0, prof.jitter_s) if prof.jitter_s else 0.0)
        if gap < delay:
            await asyncio.sleep(delay - gap)

        # Count and flush BEFORE the request, not after: a request that is issued and then
        # killed still cost the source, and the accounting has to survive the kill.
        slot["requests"] = used + 1
        slot["last_request_ts"] = time.time()
        _save_state(state)
        attempts += 1

        client = _make_client(proxy_url)
        try:
            resp = await client.get(url, headers=headers or {}, timeout=timeout)
        except Exception as exc:
            return FetchResult(
                ok=False, source=domain, proxied=bool(proxy_url), attempts=attempts,
                error=f"{type(exc).__name__}: {exc}",
            )
        finally:
            try:
                await client.aclose()
            except Exception:
                pass

        if resp.status_code == 429 and proxy_url and 429 in prof.stop_statuses:
            slot["proxied_429s"] = int(slot.get("proxied_429s") or 0) + 1
            _save_state(state)
            if attempts < _PROXIED_429_ATTEMPTS and slot["proxied_429s"] < _PROXIED_429_CYCLE_CAP:
                backoff = _PROXIED_429_BACKOFF_S * attempts
                await asyncio.sleep(backoff + random.uniform(0, backoff / 2))
                continue

        if resp.status_code in prof.stop_statuses:
            slot["rate_limited"] = True
            slot["stop_reason"] = f"HTTP {resp.status_code}"
            _save_state(state)
            retried = (
                f" (after {attempts} attempts, each on a fresh proxy exit)" if attempts > 1 else ""
            )
            return FetchResult(
                ok=False,
                status=resp.status_code,
                source=domain,
                proxied=bool(proxy_url),
                exhausted=True,
                attempts=attempts,
                error=(
                    f"HTTP {resp.status_code} from {domain}{retried} — stop, and do not retry. "
                    f"Losing this endpoint costs the source."
                ),
            )
        break

    if resp.status_code != 200:
        return FetchResult(
            ok=False, status=resp.status_code, source=domain,
            proxied=bool(proxy_url), attempts=attempts, error=f"HTTP {resp.status_code}",
        )

    # Count successful fetches so the canary can fire even when the caller never reports a
    # yield. record_yield() is cooperative, and a generated tool that simply forgets it gets
    # no canary at all — which is the failure this was built to catch. `ok_since_yield` makes
    # silence itself observable: many 200s and no reported items is the exact signature of a
    # parser that stopped matching.
    slot["ok_since_yield"] = int(slot.get("ok_since_yield") or 0) + 1
    _save_state(state)

    return FetchResult(
        ok=True, status=200, text=resp.text, source=domain, proxied=bool(proxy_url),
        attempts=attempts,
    )


async def fetch_text(
    url: str,
    *,
    user_agent: str | None = None,
    timeout: float = 45.0,
    state: dict[str, Any] | None = None,
) -> tuple[str | None, str | None]:
    """``(text, error)`` — the shape the built-in source tools' ``_get`` already returns.

    Exists so migrating a built-in is a six-line diff instead of a rewrite. ``state`` is the
    tool's own legacy pace dict: its ``cycle_requests`` and ``last_request_ts`` are mirrored
    here so the tool's existing budget checks and output fields keep working unchanged while
    the real accounting moves to the per-domain state.

    The error strings deliberately keep "429" in them — the sweep loops in linkedin_jobs and
    yc_jobs detect a rate limit with ``if "429" in err``, and quietly changing that wording
    would turn a hard stop into a `continue` that keeps hammering.
    """
    res = await fetch(url, headers={"User-Agent": user_agent} if user_agent else None, timeout=timeout)

    if state is not None:
        state["last_request_ts"] = time.time()
        # Only count what actually left the machine. A call refused by the 429 latch or by
        # the per-cycle budget never touched the network; charging the tool's counter for it
        # would spend a budget twice. A proxied 429 retried on a fresh exit is several
        # requests, and the tool's counter has to see all of them.
        if res.attempts:
            state["cycle_requests"] = int(state.get("cycle_requests") or 0) + res.attempts

    if res.ok:
        return res.text, None
    return None, res.error or f"HTTP {res.status}"


# ── Canary: a broken parser and a quiet day look identical ───────────────────


def record_yield(url_or_domain: str, count: int) -> str | None:
    """Record how many usable items a sweep of this source produced, and return a loud
    warning when that number just collapsed to zero against its own history.

    This is the guardrail that makes generated tools survivable. A scraper whose selectors
    broke returns ``[]`` and a 200; so does a genuinely empty day. Without a comparison to
    what this source normally yields, the two are indistinguishable, and the failure is
    found days later by noticing the tracker stopped growing.
    """
    domain = _norm_domain(url_or_domain)
    state = _load_state()
    slot = _source_state(state, domain)

    history = [int(h) for h in (slot.get("history") or []) if isinstance(h, (int, float))]
    warning: str | None = None

    # Need enough history to know what "normal" is, or a first-run zero would cry wolf.
    if count == 0 and len(history) >= 3:
        past = sorted(history)
        median = past[len(past) // 2]
        if median > 0:
            warning = (
                f"CANARY: {domain} returned 0 usable items, but its last {len(history)} runs "
                f"produced a median of {median}. Treat this as a broken fetch or parser, not "
                f"a quiet day, until proven otherwise — check the raw response before "
                f"recording 'no results'."
            )
            slot["canary_fired_at"] = time.time()

    history.append(int(count))
    slot["history"] = history[-_HISTORY_LEN:]
    slot["last_yield"] = int(count)
    slot["ok_since_yield"] = 0
    _save_state(state)
    return warning


# A sweep that fetched at least this many pages successfully and reported nothing is not a
# quiet day. Low enough to catch a broken parser early, high enough that a single probing
# request does not trip it.
_SILENT_FETCH_LIMIT = 15


def check_silent_sources() -> list[str]:
    """Sources that fetched successfully this cycle but never reported a yield.

    The other half of the canary, and the half that does not depend on the caller doing
    anything. `record_yield` is cooperative: a generated tool that forgets to call it is
    exactly the tool most likely to have a broken parser, and under a cooperative-only
    canary it would be the one tool that never trips it.

    Call this at the end of a cycle. An entry here means the network worked and nothing came
    out of it, which is the signature of selectors that stopped matching.
    """
    out: list[str] = []
    state = _load_state()
    for domain, slot in sorted(state.items()):
        pending = int(slot.get("ok_since_yield") or 0)
        if pending >= _SILENT_FETCH_LIMIT:
            out.append(
                f"CANARY: {domain} returned {pending} successful fetches this cycle and not "
                f"one reported item. Nothing called record_yield(), so either the parser is "
                f"matching nothing or the tool is not reporting. Check the raw response "
                f"before recording 'no results'."
            )
    return out


def known_sources_brief() -> str:
    """One line per characterised source, for the generate_tool prompt.

    This is the answer to the other half of "a generated tool starts with none of the
    knowledge": enforcement (the scanner) stops it from *bypassing* the rules, but the
    model still has to know that linkedin.com's endpoint is undocumented and that a 429
    there is terminal — otherwise it writes a retry loop and the scanner happily allows it,
    because the retry is in the caller, not the client.

    Built from _PROFILES rather than written out again, so it cannot drift from the numbers
    actually enforced.
    """
    lines = []
    for domain in sorted({p.domain for p in _PROFILES.values()}):
        prof = _PROFILES[domain]
        note = f" {prof.notes}" if prof.notes else ""
        lines.append(
            f"  {domain}: {prof.crawl_delay_s}s between requests, "
            f"{prof.per_cycle_budget}/cycle, stop on {list(prof.stop_statuses)}.{note}"
        )
    return "\n".join(lines)


def report_yield(url_or_domain: str, count: int) -> list[str]:
    """`record_yield` plus `check_silent_sources`, as one call a sweep can make at the end.

    Exists so wiring a tool up is a single line. A canary nobody calls is worth nothing —
    this codebase's recurring failure is a mechanism that exists, passes its tests, and is
    never reached from the running path.
    """
    warnings: list[str] = []
    first = record_yield(url_or_domain, count)
    if first:
        warnings.append(first)
    warnings.extend(check_silent_sources())
    return warnings


def source_report() -> str:
    """Human/agent-readable status of every source touched this cycle."""
    state = _load_state()
    if not state:
        return "No source activity recorded this cycle."
    lines = []
    for domain, slot in sorted(state.items()):
        prof = profile_for(domain)
        used = int(slot.get("requests") or 0)
        flag = ""
        if slot.get("rate_limited"):
            flag = f"  STOPPED ({slot.get('stop_reason')})"
        lines.append(
            f"{domain}: {used}/{prof.per_cycle_budget} requests, "
            f"last yield {slot.get('last_yield', '-')}{flag}"
        )
    return "\n".join(lines)
