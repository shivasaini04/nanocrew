"""The agent's own model gets a second try before the fallbacks.

2026-09-30: one GLM 5.3 timeout sent a Benchmark cycle straight into a fallback chain whose
every entry was dead (DeepSeek 402, Gemini 402, Kimi 404, Groq 404). The model the agent was
configured with — and which worked — was never asked twice.
"""

import asyncio

import pytest

from nanoagent.providers.base import LLMResponse
from nanoagent.providers.fallback_provider import FallbackProvider, _forget_condemned


def _exc(name):
    return type(name, (Exception,), {})(f"{name} from provider")


class _Seq:
    """Answers with each outcome in turn; the last one repeats."""
    api_key = "k"
    api_base = None

    def __init__(self, *outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def chat(self, **kw):
        out = self.outcomes[min(self.calls, len(self.outcomes) - 1)]
        self.calls += 1
        if isinstance(out, Exception):
            raise out
        return LLMResponse(content=out)


def _run(chain):
    _forget_condemned()
    return asyncio.run(FallbackProvider([(p, f"m{i}") for i, p in enumerate(chain)]).chat(messages=[]))


def test_a_timeout_on_the_agents_model_is_retried_on_that_model():
    primary, dead = _Seq(_exc("Timeout"), "from the agent's own model"), _Seq(_exc("NotFoundError"))
    assert _run([primary, dead]).content == "from the agent's own model"
    assert primary.calls == 2
    assert dead.calls == 0


def test_a_rate_limit_on_the_agents_model_is_retried_too():
    primary, other = _Seq(_exc("RateLimitError"), "ok"), _Seq("fallback")
    assert _run([primary, other]).content == "ok"
    assert other.calls == 0


def test_only_once_then_the_chain_moves_on():
    primary, other = _Seq(_exc("Timeout")), _Seq("fallback")
    assert _run([primary, other]).content == "fallback"
    assert primary.calls == 2


def test_fallbacks_are_not_retried():
    primary, second, third = _Seq(_exc("Timeout")), _Seq(_exc("Timeout"), "late"), _Seq("third")
    assert _run([primary, second, third]).content == "third"
    assert second.calls == 1


def test_a_bad_request_is_not_retried():
    primary, other = _Seq(_exc("BadRequestError"), "never"), _Seq("fallback")
    with pytest.raises(Exception, match="BadRequestError"):
        _run([primary, other])
    assert primary.calls == 1


@pytest.mark.parametrize("dead", ["NotFoundError", "AuthenticationError", "PermissionDeniedError"])
def test_a_provider_that_refuses_is_not_retried(dead):
    """An unfunded account or a retired model answers the same way a second later."""
    primary, other = _Seq(_exc(dead), "never"), _Seq("fallback")
    assert _run([primary, other]).content == "fallback"
    assert primary.calls == 1


def test_a_402_is_not_retried():
    class Refuses(Exception):
        status_code = 402
    primary, other = _Seq(Refuses("Insufficient Balance"), "never"), _Seq("fallback")
    assert _run([primary, other]).content == "fallback"
    assert primary.calls == 1
