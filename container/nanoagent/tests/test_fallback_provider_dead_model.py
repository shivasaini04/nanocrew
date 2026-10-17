"""A dead fallback model must not end the chain.

Crawler a live cycle (2026-09-11): the primary and DeepSeek failed transiently, the
chain reached gemini/gemini-2.0-flash — retired by Google, 404 NotFoundError — and raised,
with groq unused behind it. The cycle then re-ran from scratch and timed out.
"""

import asyncio

import pytest

from nanoagent.providers.base import LLMResponse
from nanoagent.providers.fallback_provider import FallbackProvider


def _exc(name):
    return type(name, (Exception,), {})(f"{name} from provider")


class _P:
    api_key = "k"
    api_base = None

    def __init__(self, outcome):
        self.outcome = outcome
        self.calls = 0

    async def chat(self, **kw):
        self.calls += 1
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return LLMResponse(content=self.outcome)


def _run(chain):
    return asyncio.run(FallbackProvider([(p, f"m{i}") for i, p in enumerate(chain)]).chat(messages=[]))


@pytest.mark.parametrize("dead", ["NotFoundError", "AuthenticationError", "PermissionDeniedError"])
def test_a_dead_or_unauthorised_provider_is_skipped(dead):
    primary, gemini, groq = _P(_exc("Timeout")), _P(_exc(dead)), _P("ok")
    assert _run([primary, gemini, groq]).content == "ok"
    assert groq.calls == 1


def test_a_bad_request_still_stops_the_chain():
    """It would fail the same way on every provider — trying them all only burns time."""
    first, second = _P(_exc("BadRequestError")), _P("ok")
    with pytest.raises(Exception, match="BadRequestError"):
        _run([first, second])
    assert second.calls == 0
