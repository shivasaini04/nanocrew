"""Fixes from Mechanic's live LinkedIn run a live cycle, 2026-09-17)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from nanoagent.agent.effector.remote_page import RemotePage
from nanoagent.providers import litellm_provider as lp


def test_whole_page_text_is_the_top_frame_not_the_longest_iframe():
    page = RemotePage.__new__(RemotePage)

    async def probe(name, args=None):
        return [
            {"frameId": 0, "result": {"body": "Alex Doe\nAI Full Stack Engineer"}},
            {"frameId": 7, "result": {"body": "recaptcha.anchor.Main.init(" + "x" * 5000}},
        ]

    page.nc_probe = probe
    assert asyncio.run(page.nc_text()) == "Alex Doe\nAI Full Stack Engineer"


def test_an_empty_top_frame_falls_back_to_the_longest():
    page = RemotePage.__new__(RemotePage)

    async def probe(name, args=None):
        return [{"frameId": 0, "result": {"body": "  "}}, {"frameId": 2, "result": {"body": "inner app"}}]

    page.nc_probe = probe
    assert asyncio.run(page.nc_text()) == "inner app"


def _reasoning_models(monkeypatch, *ids):
    from nanoagent.providers import output_limits
    monkeypatch.setattr(output_limits, "_openrouter_caps", {})
    monkeypatch.setattr(output_limits, "_openrouter_reasoning", set(ids))


def test_low_effort_is_sent_to_openrouter_only_when_asked(monkeypatch):
    _reasoning_models(monkeypatch, "z-ai/glm-5.3-flash")
    sent: list = []

    async def fake_acompletion(**kwargs):
        sent.append(kwargs)
        raise RuntimeError("stop")

    async def no_wait(_delay):
        return None

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)
    monkeypatch.setattr(lp.asyncio, "sleep", no_wait)  # the provider's retry backoff
    prov = lp.LiteLLMProvider(api_key="k", default_model="openrouter/z-ai/glm-5.3-flash")

    async def call():
        try:
            await prov.chat(messages=[{"role": "user", "content": "hi"}], max_tokens=10)
        except Exception:
            pass

    asyncio.run(call())
    tok = lp.reasoning_effort_var.set("low")
    try:
        asyncio.run(call())
    finally:
        lp.reasoning_effort_var.reset(tok)

    assert "reasoning" not in (sent[0].get("extra_body") or {})
    assert sent[-1]["extra_body"]["reasoning"] == {"effort": "low"}


def test_the_decision_call_asks_for_low_effort_and_retries_a_cut_off():
    import nanoagent.agent.effector.react_loop as rl

    src = Path(rl.__file__).read_text(encoding="utf-8")
    assert 'reasoning_effort_var.set("low")' in src
    assert "max_tokens=_DECISION_MAX_TOKENS * 4" in src


def _sent(monkeypatch, model, max_tokens, effort=None):
    sent: list = []

    async def fake_acompletion(**kwargs):
        sent.append(kwargs)
        raise RuntimeError("stop")

    async def no_wait(_delay):
        return None

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)
    monkeypatch.setattr(lp.asyncio, "sleep", no_wait)  # the provider's retry backoff
    prov = lp.LiteLLMProvider(api_key="k", default_model=model)
    tok = lp.reasoning_effort_var.set(effort) if effort else None
    try:
        try:
            asyncio.run(prov.chat(messages=[{"role": "user", "content": "hi"}], max_tokens=max_tokens))
        except Exception:
            pass
    finally:
        if tok is not None:
            lp.reasoning_effort_var.reset(tok)
    return (sent[-1].get("extra_body") or {}).get("reasoning")


def test_a_full_step_caps_reasoning_at_a_quarter_of_the_reply(monkeypatch):
    """docs 21: uncapped, GLM 5.3 Flash reasoned to the 32,768 limit in 2 of 4 calls."""
    _reasoning_models(monkeypatch, "z-ai/glm-5.3-flash")
    assert _sent(monkeypatch, "openrouter/z-ai/glm-5.3-flash", 32768) == {"max_tokens": 8192}


def test_small_calls_are_not_capped(monkeypatch):
    _reasoning_models(monkeypatch, "z-ai/glm-5.3-flash")
    assert _sent(monkeypatch, "openrouter/z-ai/glm-5.3-flash", 4000) is None


def test_a_model_that_does_not_reason_never_gets_a_reasoning_block(monkeypatch):
    """require_parameters routing: a reasoning block would leave gpt-4o-mini no host."""
    _reasoning_models(monkeypatch, "z-ai/glm-5.3-flash")
    assert _sent(monkeypatch, "openrouter/openai/gpt-4o-mini", 32768) is None
    assert _sent(monkeypatch, "openrouter/openai/gpt-4o-mini", 32768, effort="low") is None


def test_effort_wins_over_the_cap(monkeypatch):
    _reasoning_models(monkeypatch, "z-ai/glm-5.3-flash")
    assert _sent(monkeypatch, "openrouter/z-ai/glm-5.3-flash", 32768, effort="low") == {"effort": "low"}
