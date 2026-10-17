"""source_fetch — the capability every tool, generated or built-in, fetches through.

These tests are written against the failures that motivated the module, so each one names
the hole it is holding shut rather than just exercising an API.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nanoagent.agent import source_fetch as sf  # noqa: E402


class FakeResponse:
    def __init__(self, status_code: int, text: str = "body"):
        self.status_code = status_code
        self.text = text


class FakeClient:
    """Records what it was constructed with, so a test can assert on proxy routing."""

    def __init__(self, proxy_url, responses, log):
        self.proxy_url = proxy_url
        self._responses = responses
        self._log = log

    async def get(self, url, headers=None, timeout=None):
        self._log.append({"url": url, "proxy": self.proxy_url})
        if not self._responses:
            return FakeResponse(200)
        nxt = self._responses.pop(0)
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    async def aclose(self):
        return None


@pytest.fixture()
def env(monkeypatch, tmp_path):
    """Isolated state + a fake network. Returns the request log."""
    monkeypatch.setattr(sf, "_STATE_PATH", tmp_path / "source_state.json")
    monkeypatch.setattr(sf, "_PROFILE_OVERRIDE_PATH", tmp_path / "source_profiles.json")
    monkeypatch.setenv("CYCLE_ID", "cycle-1")
    # Credentials present, so proxy routing is a real decision rather than "no proxy configured".
    monkeypatch.setenv("PROXY_HOST", "gw.example.com")
    monkeypatch.setenv("PROXY_PORT", "823")
    monkeypatch.setenv("PROXY_USER", "u")
    monkeypatch.setenv("PROXY_PASS", "p")

    log: list[dict] = []
    responses: list = []

    def factory(proxy_url):
        return FakeClient(proxy_url, responses, log)

    monkeypatch.setattr(sf, "_make_client", factory)
    monkeypatch.setattr(sf, "_PROXIED_429_BACKOFF_S", 0.0)
    # Pacing is real behaviour but not what these tests are measuring; keep them fast.
    monkeypatch.setattr(sf, "_PROFILES", dict(sf._PROFILES))
    for dom in list(sf._PROFILES):
        p = sf._PROFILES[dom]
        sf._PROFILES[dom] = sf.SourceProfile(
            domain=p.domain, crawl_delay_s=0.0, jitter_s=0.0,
            per_cycle_budget=p.per_cycle_budget, stop_statuses=p.stop_statuses, notes=p.notes,
        )
    return {"log": log, "responses": responses}


# ── The capability: proxy follows the destination, not the caller's name ─────


def test_linkedin_is_proxied_no_matter_who_calls_it(env, monkeypatch):
    """The hole this closes: `get_proxy_url_for("yc_jobs")` bound the residential pool to a
    hardcoded tool name, so anything the agent generated reached linkedin.com from the
    datacenter IP — and got silence, not an error."""
    monkeypatch.delenv("PROXY_FOR_HTTP_TOOLS", raising=False)

    res = asyncio.run(sf.fetch("https://www.linkedin.com/jobs-guest/jobs/api/search?x=1"))

    assert res.ok
    assert res.proxied is True, "linkedin.com must route through the residential pool"
    assert env["log"][0]["proxy"] is not None
    assert "gw.example.com" in env["log"][0]["proxy"]


def test_a_generated_tools_arbitrary_name_changes_nothing(env, monkeypatch):
    """There is no tool name in the call at all — that is the point. A tool called
    `my_new_linkedin_scraper_v3` gets exactly what the built-in gets."""
    monkeypatch.setenv("PROXY_FOR_HTTP_TOOLS", "")  # allowlist empty: would have blocked before

    res = asyncio.run(sf.fetch("https://nz.linkedin.com/jobs/view/123"))

    assert res.proxied is True
    assert res.source == "linkedin.com", "subdomains key to the registrable domain"


def test_yc_is_not_proxied_because_it_does_not_need_to_be(env):
    """The other direction of the same bug: the name allowlist made yc_jobs send every
    ycombinator.com request through paid residential bandwidth it never needed."""
    res = asyncio.run(sf.fetch("https://www.ycombinator.com/jobs/role/operations"))

    assert res.ok
    assert res.proxied is False
    assert env["log"][0]["proxy"] is None


# ── Source protection is inherited, not reimplemented ────────────────────────


def test_a_stop_status_latches_and_is_never_retried(env):
    """`HTTP 429 — the one failure that must never be retried into. Losing this endpoint
    costs the source.` A generated tool cannot know that; the capability enforces it.
    Through the proxy the latch waits for 429s on three fresh exits in a row."""
    env["responses"].extend([FakeResponse(429)] * 3 + [FakeResponse(200)])

    first = asyncio.run(sf.fetch("https://www.linkedin.com/a"))
    assert first.ok is False
    assert first.status == 429
    assert first.exhausted is True
    assert first.attempts == 3

    second = asyncio.run(sf.fetch("https://www.linkedin.com/b"))
    assert second.ok is False
    assert second.exhausted is True
    assert len(env["log"]) == 3, "the call after the latch must not touch the network at all"
    assert sf.is_rate_limited("linkedin.com") is True


def test_one_proxied_429_is_retried_on_a_fresh_exit(env):
    """Crawler a live cycle (2026-09-11): one 429 on the 6th LinkedIn request latched
    the source for the whole cycle — 11 of 12 queries never ran — and six probes through
    the same pool a minute later were all 200. A rotating pool's 429 is one exit's
    reputation. Each attempt builds a new client, so the retry leaves on a new exit."""
    env["responses"].extend([FakeResponse(429), FakeResponse(200, "ok")])

    res = asyncio.run(sf.fetch("https://www.linkedin.com/jobs-guest/x"))

    assert res.ok is True and res.text == "ok"
    assert res.attempts == 2
    assert sf.is_rate_limited("linkedin.com") is False
    assert len(env["log"]) == 2 and all(r["proxy"] for r in env["log"])
    assert sf.budget_remaining("linkedin.com") == sf.profile_for("linkedin.com").per_cycle_budget - 2, (
        "a retry is a real request and must be charged to the source's budget"
    )


def test_a_429_without_the_proxy_still_latches_on_the_first(env):
    """From the datacenter IP there is no fresh exit to move to — retrying there is exactly
    the hammering the latch exists to prevent."""
    env["responses"].extend([FakeResponse(429), FakeResponse(200)])

    res = asyncio.run(sf.fetch("https://www.ycombinator.com/jobs"))

    assert res.exhausted is True and res.attempts == 1
    assert len(env["log"]) == 1
    assert sf.is_rate_limited("ycombinator.com") is True


def test_proxied_429s_across_a_cycle_still_end_the_source(env, monkeypatch):
    """Each call recovering on its retry must not add up to an unlimited number of 429s —
    past the cycle cap the next 429 latches, however the individual calls went."""
    monkeypatch.setattr(sf, "_PROXIED_429_CYCLE_CAP", 2)
    env["responses"].extend([FakeResponse(429), FakeResponse(200), FakeResponse(429), FakeResponse(200)])

    first = asyncio.run(sf.fetch("https://www.linkedin.com/a"))
    second = asyncio.run(sf.fetch("https://www.linkedin.com/b"))

    assert first.ok is True
    assert second.exhausted is True and second.attempts == 1
    assert sf.is_rate_limited("linkedin.com") is True


def test_a_new_cycle_forgets_the_proxied_429_count(env, monkeypatch):
    monkeypatch.setattr(sf, "_PROXIED_429_CYCLE_CAP", 2)
    env["responses"].extend([FakeResponse(429), FakeResponse(200)])
    asyncio.run(sf.fetch("https://www.linkedin.com/a"))

    monkeypatch.setenv("CYCLE_ID", "cycle-2")
    env["responses"].extend([FakeResponse(429), FakeResponse(200)])
    res = asyncio.run(sf.fetch("https://www.linkedin.com/b"))

    assert res.ok is True, "last cycle's 429 must not count toward this cycle's cap"


def test_budget_is_shared_across_callers_of_the_same_domain(env, monkeypatch):
    """Two different tools sweeping linkedin.com share one budget, because the budget
    belongs to the source, not to whoever is calling."""
    sf._PROFILES["linkedin.com"] = sf.SourceProfile(
        domain="linkedin.com", crawl_delay_s=0.0, per_cycle_budget=2,
    )

    assert asyncio.run(sf.fetch("https://www.linkedin.com/1")).ok
    assert asyncio.run(sf.fetch("https://www.linkedin.com/2")).ok
    third = asyncio.run(sf.fetch("https://www.linkedin.com/3"))

    assert third.ok is False
    assert third.exhausted is True
    assert "budget spent" in (third.error or "")
    assert len(env["log"]) == 2


def test_an_unknown_domain_still_gets_limits(env):
    """A generated tool pointed at a source nobody characterised must not get 'no limits'."""
    prof = sf.profile_for("https://some-new-board.example/search")

    assert prof.crawl_delay_s > 0
    assert prof.per_cycle_budget > 0
    assert 429 in prof.stop_statuses


# ── State survives what killed the last sweep ────────────────────────────────


def test_accounting_is_flushed_before_the_request_not_after(env, tmp_path):
    """a live cycle: linkedin_jobs only saved state on sweep completion, so a mid-sweep
    SIGKILL erased the run's request count entirely and the retry started clean."""
    asyncio.run(sf.fetch("https://www.linkedin.com/1"))

    on_disk = json.loads((tmp_path / "source_state.json").read_text())
    assert on_disk["linkedin.com"]["requests"] == 1, (
        "the count must be durable the instant the request is issued"
    )


def test_state_follows_the_domain_across_a_tool_rename(env, tmp_path):
    """Regenerating a tool under a new name must not hand it a fresh budget."""
    env["responses"].extend([FakeResponse(429)] * 3)  # proxied: latches on the third
    asyncio.run(sf.fetch("https://www.linkedin.com/a"))

    # Simulate a completely different tool, same process lifetime, same cycle.
    assert sf.is_rate_limited("https://uk.linkedin.com/jobs/view/9") is True


def test_a_new_cycle_clears_the_stop_flag_but_keeps_history(env):
    """Rate limits are per cycle; the canary's baseline is not."""
    env["responses"].extend([FakeResponse(429)] * 3)  # proxied: latches on the third
    asyncio.run(sf.fetch("https://www.linkedin.com/a"))
    sf.record_yield("linkedin.com", 40)
    assert sf.is_rate_limited("linkedin.com") is True

    import os

    os.environ["CYCLE_ID"] = "cycle-2"
    assert sf.is_rate_limited("linkedin.com") is False
    state = sf._load_state()
    assert state["linkedin.com"]["history"] == [40], "history must outlive the cycle"


# ── The canary: a broken parser and a quiet day look identical ───────────────


def test_canary_fires_when_yield_collapses_against_its_own_history(env):
    for n in (120, 95, 140, 110):
        assert sf.record_yield("linkedin.com", n) is None

    warning = sf.record_yield("linkedin.com", 0)

    assert warning is not None
    assert "CANARY" in warning
    assert "linkedin.com" in warning


def test_canary_does_not_cry_wolf_before_it_knows_what_normal_is(env):
    """A first-ever zero is not evidence of anything."""
    assert sf.record_yield("brand-new.example", 0) is None
    assert sf.record_yield("brand-new.example", 0) is None


def test_canary_stays_quiet_for_a_source_that_normally_yields_nothing(env):
    for _ in range(5):
        sf.record_yield("quiet.example", 0)

    assert sf.record_yield("quiet.example", 0) is None, (
        "median 0 means zero IS normal here — firing would train the agent to ignore it"
    )


# ── The canary that does not need the caller's cooperation ───────────────────


def test_silent_source_is_caught_even_when_nobody_calls_record_yield(env):
    """record_yield is cooperative, and the tool most likely to have a broken parser is
    exactly the one that forgets to call it. Successful fetches with nothing reported are
    the signature, so silence itself has to be observable."""
    for i in range(sf._SILENT_FETCH_LIMIT):
        assert asyncio.run(sf.fetch(f"https://www.linkedin.com/{i}")).ok

    warnings = sf.check_silent_sources()

    assert len(warnings) == 1
    assert "linkedin.com" in warnings[0]
    assert "not one reported item" in warnings[0]


def test_reporting_a_yield_clears_the_silence_counter(env):
    for i in range(sf._SILENT_FETCH_LIMIT):
        asyncio.run(sf.fetch(f"https://www.linkedin.com/{i}"))
    sf.record_yield("linkedin.com", 24)

    assert sf.check_silent_sources() == []


def test_a_few_fetches_with_no_yield_do_not_trip_it(env):
    """A single probing request must not cry wolf."""
    for i in range(3):
        asyncio.run(sf.fetch(f"https://www.linkedin.com/{i}"))

    assert sf.check_silent_sources() == []


# ── reddit is the one source where a 429 is not terminal ─────────────────────


def test_reddit_429_does_not_latch_the_source(env):
    """reddit_search retries through 429s on purpose — roughly half of anonymous RSS
    requests from a datacenter IP are throttled, and latching would turn a recoverable
    throttle into a dead source for the rest of the cycle."""
    assert 429 not in sf.profile_for("https://old.reddit.com/r/x").stop_statuses

    env["responses"].extend([FakeResponse(429), FakeResponse(200, "ok")])

    first = asyncio.run(sf.fetch("https://old.reddit.com/a"))
    assert first.ok is False
    assert first.exhausted is False, "a reddit 429 must stay retryable"
    assert sf.is_rate_limited("reddit.com") is False

    second = asyncio.run(sf.fetch("https://old.reddit.com/a"))
    assert second.ok is True, "the retry must reach the network"


def test_reddit_403_still_stops(env):
    env["responses"].append(FakeResponse(403))

    res = asyncio.run(sf.fetch("https://old.reddit.com/a"))

    assert res.exhausted is True
    assert sf.is_rate_limited("reddit.com") is True


def test_linkedin_429_still_latches(env):
    """The contrast that makes the reddit exception safe: it is per profile, not global."""
    env["responses"].extend([FakeResponse(429)] * 3)

    res = asyncio.run(sf.fetch("https://www.linkedin.com/a"))

    assert res.exhausted is True


# ── The built-ins' (text, error) contract ────────────────────────────────────


def test_fetch_text_returns_the_shape_the_built_ins_expect(env):
    text, err = asyncio.run(sf.fetch_text("https://www.ycombinator.com/x", user_agent="UA"))

    assert err is None
    assert text == "body"


def test_fetch_text_keeps_429_in_the_error_string(env):
    """linkedin_jobs and yc_jobs stop their sweep with `if "429" in err`. Rewording this
    would silently turn a hard stop into a continue that keeps hammering."""
    env["responses"].extend([FakeResponse(429)] * 3)

    _, err = asyncio.run(sf.fetch_text("https://www.linkedin.com/a"))

    assert err is not None and "429" in err


def test_fetch_text_mirrors_the_counter_the_tools_still_read(env):
    """The tools' own budget checks read state['cycle_requests']; migrating must not
    silently freeze that at zero."""
    state: dict = {}
    asyncio.run(sf.fetch_text("https://www.ycombinator.com/1", state=state))
    asyncio.run(sf.fetch_text("https://www.ycombinator.com/2", state=state))

    assert state["cycle_requests"] == 2
    assert state["last_request_ts"] > 0


def test_fetch_text_charges_the_tool_for_every_retry(env):
    """A proxied 429 retried once is two requests; the tool's own budget check has to
    see two, or its sweep would overrun the budget it thinks it is keeping."""
    state: dict = {}
    env["responses"].extend([FakeResponse(429), FakeResponse(200)])

    text, err = asyncio.run(sf.fetch_text("https://www.linkedin.com/x", state=state))

    assert err is None and text == "body"
    assert state["cycle_requests"] == 2


def test_a_refused_call_does_not_charge_the_tools_counter(env):
    """A call the latch refused never touched the network, so counting it would spend the
    same budget twice."""
    env["responses"].extend([FakeResponse(429)] * 3)  # three real requests, then the latch
    state: dict = {}

    asyncio.run(sf.fetch_text("https://www.linkedin.com/a", state=state))
    charged_after_real_requests = state["cycle_requests"]
    asyncio.run(sf.fetch_text("https://www.linkedin.com/b", state=state))

    assert charged_after_real_requests == 3
    assert state["cycle_requests"] == 3, "the refused call must not be charged"


# ── Operator/agent override without an image rebuild ─────────────────────────


def test_profiles_can_be_retuned_from_disk(env, tmp_path):
    """The 12h-cooldown lesson: a number nobody can change without a rebuild gets stale."""
    (tmp_path / "source_profiles.json").write_text(
        json.dumps({"linkedin.com": {"crawl_delay_s": 9.5, "per_cycle_budget": 42}})
    )

    prof = sf.profile_for("https://www.linkedin.com/x")

    assert prof.crawl_delay_s == 9.5
    assert prof.per_cycle_budget == 42
