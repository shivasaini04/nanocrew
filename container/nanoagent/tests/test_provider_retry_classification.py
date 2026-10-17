"""A provider must not spend two minutes waiting for an answer it already has.

Measured on prod 2026-09-21. DeepSeek replies to an unfunded key with 402 "Insufficient
Balance" in 0.6 s. The streaming retry loop — the one every real cycle uses — treated any
status outside {400,401,403,404} as transient and slept 1+2+4+8+16+32+60 = 123 s. That is
past FallbackProvider's 120 s bound, so the call surfaced as `TimeoutError ()`: an empty
message, no status, no sign that the real answer had arrived in under a second. Three
model calls in one verify run cost 120 s each, and the cycle looked slow rather than
misconfigured.

The non-streaming path got this right and the streaming path did not, while a comment
above both claimed they agreed. These tests are mostly about that: the two paths must
reach the same verdict, and the verdict must be an allowlist.
"""

from __future__ import annotations

import asyncio

import pytest

from nanoagent.providers import litellm_provider as lp
from nanoagent.providers.litellm_provider import LiteLLMProvider


class Boom(Exception):
    def __init__(self, status):
        super().__init__(f"status {status}")
        self.status_code = status


# ───────────────────────────────────────────────────── what counts as transient

@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
def test_a_transient_status_is_worth_another_attempt(status):
    assert lp._should_retry(status) is True


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 405, 409, 413, 422, 451])
def test_a_definite_rejection_is_never_retried(status):
    """402 is the one that cost two minutes a call. The others are here because the old
    denylist would have retried every one of them too — it named four statuses and
    treated the whole rest of the HTTP space as worth waiting on."""
    assert lp._should_retry(status) is False


def test_no_status_at_all_still_retries():
    """A connection reset or TransferEncodingError during the handshake never gets an
    HTTP reply. That is the case this loop was written for and must keep working."""
    assert lp._should_retry(None) is True


# ────────────────────────────────────────── the two paths must agree, for real

@pytest.mark.parametrize("status", [None, 402, 429, 400, 503, 404])
def test_both_paths_reach_the_same_verdict(status, monkeypatch):
    """The regression was not a wrong rule, it was two rules. One allowlist, one
    denylist, and a comment asserting they were the same."""
    seen: dict[str, int] = {"stream": 0, "plain": 0}

    async def fail_stream(kwargs, on_token, progress):
        seen["stream"] += 1
        raise Boom(status)

    async def fail_plain(**kwargs):
        seen["plain"] += 1
        raise Boom(status)

    monkeypatch.setattr(lp, "acompletion", fail_plain)

    # `lp.asyncio` IS the asyncio module, so a replacement that calls asyncio.sleep
    # calls itself. Hold the real one first.
    real_sleep = asyncio.sleep

    async def instant(_seconds):
        await real_sleep(0)

    monkeypatch.setattr(lp.asyncio, "sleep", instant)
    provider = LiteLLMProvider(api_key="k", default_model="m")
    monkeypatch.setattr(provider, "_stream_once", fail_stream)

    async def token(_t):  # pragma: no cover - never reached
        return None

    for path, kw in (("stream", {"on_token": token}), ("plain", {})):
        with pytest.raises(Boom):
            asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}],
                                      model="m", **kw))

    assert seen["stream"] == seen["plain"], (
        f"status {status}: streaming tried {seen['stream']}x, non-streaming "
        f"{seen['plain']}x — the paths disagree again"
    )


def test_a_402_costs_one_attempt_not_eight(monkeypatch):
    attempts = {"n": 0}

    async def fail(kwargs, on_token, progress):
        attempts["n"] += 1
        raise Boom(402)

    slept: list[float] = []

    async def record(seconds):
        slept.append(seconds)

    monkeypatch.setattr(lp.asyncio, "sleep", record)
    provider = LiteLLMProvider(api_key="k", default_model="m")
    monkeypatch.setattr(provider, "_stream_once", fail)

    async def token(_t):  # pragma: no cover
        return None

    with pytest.raises(Boom):
        asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}],
                                  model="m", on_token=token))

    assert attempts["n"] == 1
    assert slept == [], f"slept {sum(slept):.0f}s waiting on a settled answer"


# ──────────────────────────────────────────── the budget must fit in the bound

def test_the_retry_ladder_fits_inside_the_timeout_that_bounds_it():
    """FallbackProvider gives each provider 120 s. A ladder that needs more than that
    can never finish: its last rungs are unreachable, and a genuine 503 burns the whole
    allowance sleeping instead of failing over to a provider that is up."""
    from nanoagent.providers.fallback_provider import FallbackProvider
    import inspect

    bound = inspect.signature(FallbackProvider.__init__).parameters["per_provider_timeout"].default
    assert lp._RETRY_BUDGET_SECONDS < bound, (
        f"retry budget {lp._RETRY_BUDGET_SECONDS}s does not fit in the {bound}s bound"
    )


def test_a_transient_status_stops_once_the_budget_is_spent(monkeypatch):
    """Retrying is allowed to give up. Before this, 503 slept 123 s and then reported a
    timeout — strictly worse than raising at 45 s and letting the next provider answer."""
    slept: list[float] = []

    async def record(seconds):
        slept.append(seconds)

    async def fail(kwargs, on_token, progress):
        raise Boom(503)

    monkeypatch.setattr(lp.asyncio, "sleep", record)
    provider = LiteLLMProvider(api_key="k", default_model="m")
    monkeypatch.setattr(provider, "_stream_once", fail)

    async def token(_t):  # pragma: no cover
        return None

    with pytest.raises(Boom):
        asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}],
                                  model="m", on_token=token))

    assert sum(slept) <= lp._RETRY_BUDGET_SECONDS
    assert slept, "a 503 should still be retried at least once"


# ──────────────────────────────── the interaction that nearly broke the deploy

def test_an_unfunded_provider_fails_over_instead_of_killing_the_cycle():
    """402 must reach the NEXT provider, not end the turn.

    litellm raises DeepSeek's 402 as BadRequestError, and FallbackProvider treats that
    class as permanent — correctly, for a malformed request. Before the retry fix, the
    402 spent 123 s in the retry ladder and arrived here as a TimeoutError instead, which
    IS transient, so the chain failed over by accident. Making the loop raise in 0.7 s
    removes that accident: without this, every cycle on an unfunded key would have gone
    from slow-but-working to immediately dead, on a deploy that looked unrelated.
    """
    from nanoagent.providers.fallback_provider import FallbackProvider

    class BadRequestError(Exception):
        def __init__(self, status, msg):
            super().__init__(msg)
            self.status_code = status

    class Dead:
        api_key, api_base = "k", None

        async def chat(self, **_kw):
            raise BadRequestError(402, "Insufficient Balance")

    class Alive:
        api_key, api_base = "k2", None

        async def chat(self, **_kw):
            return "answered"

    chain = [(Dead(), "deepseek/deepseek-v4-flash"), (Alive(), "gemini/gemini-3.5-flash")]
    out = asyncio.run(FallbackProvider(chain).chat(messages=[{"role": "user", "content": "x"}]))
    assert out == "answered"


def test_a_genuine_400_still_ends_the_turn():
    """A malformed request really does fail the same way everywhere; trying three more
    providers just spends three times the money to learn it."""
    from nanoagent.providers.fallback_provider import FallbackProvider

    class BadRequestError(Exception):
        def __init__(self):
            super().__init__("Invalid model name")
            self.status_code = 400

    class Dead:
        api_key, api_base = "k", None
        calls = 0

        async def chat(self, **_kw):
            type(self).calls += 1
            raise BadRequestError()

    chain = [(Dead(), "a"), (Dead(), "b")]
    with pytest.raises(BadRequestError):
        asyncio.run(FallbackProvider(chain).chat(messages=[{"role": "user", "content": "x"}]))
    assert Dead.calls == 1, "a 400 must not be re-sent to every provider in the chain"


# ───────────────────────────── not asking a provider that just refused to pay

def _chain_parts():
    from nanoagent.providers import fallback_provider as fp

    class Refuses(Exception):
        def __init__(self):
            super().__init__("Insufficient Balance")
            self.status_code = 402

    class Dead:
        api_key, api_base = "k", None

        def __init__(self):
            self.calls = 0

        async def chat(self, **_kw):
            self.calls += 1
            raise Refuses()

    class Alive:
        api_key, api_base = "k2", None

        def __init__(self):
            self.calls = 0

        async def chat(self, **_kw):
            self.calls += 1
            return "answered"

    fp._forget_condemned()
    return fp, Dead(), Alive()


def test_a_provider_that_refused_is_not_asked_again():
    """Measured 2026-09-21: the doomed hop costs 0.87 s even with a 40K-token prompt,
    against ~3.3 s for the call that answers — a fifth of every model call, paid forever,
    because selection picks the first available KEY and never a healthy one."""
    fp, dead, alive = _chain_parts()
    provider = fp.FallbackProvider([(dead, "deepseek/x"), (alive, "gemini/y")])

    for _ in range(5):
        assert asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}])) == "answered"

    assert dead.calls == 1, f"asked the refusing provider {dead.calls}x; once is the point"
    assert alive.calls == 5


def test_the_skip_expires_so_a_topped_up_account_recovers_itself():
    """Being wrong here has to be temporary. Fund the account and it comes back inside
    the window, with nothing restarted and no state outliving the process."""
    fp, dead, alive = _chain_parts()
    provider = fp.FallbackProvider([(dead, "deepseek/x"), (alive, "gemini/y")])
    asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}]))
    assert fp._is_condemned("deepseek/x")

    fp._condemned["deepseek/x"] = fp.time.monotonic() - 1
    assert fp._is_condemned("deepseek/x") is False, "the skip must expire on its own"


def test_skipping_can_never_leave_the_chain_with_nobody_to_ask():
    """The last provider is always tried, even condemned. A mistake in this cache is then
    only ever a slow call, never an impossible one."""
    fp, dead, _alive = _chain_parts()
    fp._condemn("only/one")
    provider = fp.FallbackProvider([(dead, "only/one")])
    with pytest.raises(Exception):
        asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}]))
    assert dead.calls == 1, "the sole provider must still be asked"


def test_a_transient_failure_does_not_condemn_anything():
    """A 503 is the provider having a bad minute. Remembering it for 15 minutes would
    route around a healthy provider long after it recovered."""
    fp, _dead, alive = _chain_parts()

    class Busy(Exception):
        def __init__(self):
            super().__init__("Service is too busy")
            self.status_code = 503

    class Flaky:
        api_key, api_base = "k", None
        calls = 0

        async def chat(self, **_kw):
            type(self).calls += 1
            raise Busy()

    provider = fp.FallbackProvider([(Flaky(), "deepseek/x"), (alive, "gemini/y")])
    asyncio.run(provider.chat(messages=[{"role": "user", "content": "x"}]))
    assert fp._is_condemned("deepseek/x") is False


def test_a_rate_limit_is_transient_but_never_condemning():
    """429 clears in seconds. Sidelining a provider for fifteen minutes over one would
    route around a healthy provider for the rest of the cycle."""
    from nanoagent.providers import fallback_provider as fp

    fp._forget_condemned()
    assert 429 in fp._TRANSIENT_STATUSES
    assert 429 not in fp._PROVIDER_CONDEMNING_STATUSES


def test_a_5xx_fails_over_even_from_an_unrecognised_exception_class():
    """_is_transient matched the exception CLASS NAME alone, so a 503 arriving as a class
    it did not know was read as permanent and ended the turn with no failover. Names are
    what a library happens to call something this version; the status is what the server
    said."""
    from nanoagent.providers import fallback_provider as fp

    fp._forget_condemned()

    class SomethingNobodyListed(Exception):
        def __init__(self):
            super().__init__("upstream is down")
            self.status_code = 503

    assert fp._is_transient(SomethingNobodyListed()) is True
