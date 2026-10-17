"""OpenRouter provider routing: cheapest upstream first, with a tool-calling guard.

An `openrouter/...` model is a route, not a host — OpenRouter picks which upstream
actually serves it. Left alone it balances price against uptime, so a pricier host
serves requests while a cheaper one is up. We send an explicit provider block so the
ordering is ours: cheapest first, falling to the next cheapest on failure.

`require_parameters` is asserted here for the same reason it exists: cycles send a
`tools` array, and the cheapest hosts are the likeliest to drop it, which turns tool
calls into narrated text and kills the turn (2026-08-17, Finder). Dropping that key to
save a fraction of a cent would re-open that failure, so the test pins it.

litellm/json_repair are stubbed exactly as test_litellm_streaming_retry.py does.
"""

import asyncio
import sys
import types

import pytest

if "litellm" not in sys.modules:
    _litellm = types.ModuleType("litellm")
    _litellm.suppress_debug_info = False
    _litellm.drop_params = False
    _litellm.api_base = None
    _litellm.acompletion = None
    sys.modules["litellm"] = _litellm

if "json_repair" not in sys.modules:
    _json_repair = types.ModuleType("json_repair")
    _json_repair.loads = lambda s: {}
    sys.modules["json_repair"] = _json_repair

if "nanoagent.providers" not in sys.modules:
    import pathlib

    import nanoagent

    _providers = types.ModuleType("nanoagent.providers")
    _providers.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "providers")]
    sys.modules["nanoagent.providers"] = _providers

import nanoagent.providers.litellm_provider as lp  # noqa: E402


class _Msg:
    content = "ok"
    tool_calls = None
    reasoning_content = None


class _Choice:
    def __init__(self):
        self.message = _Msg()
        self.finish_reason = "stop"


class _Resp:
    def __init__(self):
        self.choices = [_Choice()]
        self.usage = None


def _capture(monkeypatch):
    """Run chat() against a stubbed acompletion and return the kwargs it was sent."""
    seen = {}

    async def _fake(**kwargs):
        seen.update(kwargs)
        return _Resp()

    monkeypatch.setattr(lp, "acompletion", _fake)
    return seen


def _run(model, monkeypatch, api_key="sk-or-v1-test"):
    seen = _capture(monkeypatch)
    provider = lp.LiteLLMProvider(api_key=api_key)
    asyncio.run(provider.chat(messages=[{"role": "user", "content": "hi"}], model=model))
    return seen


def test_openrouter_model_routes_cheapest_first(monkeypatch):
    monkeypatch.delenv("OPENROUTER_PROVIDER_SORT", raising=False)
    seen = _run("openrouter/inclusionai/ling-3.0-flash", monkeypatch)

    routing = seen.get("extra_body", {}).get("provider")
    assert routing is not None, "no provider block sent — OpenRouter would pick the host itself"
    assert routing["sort"] == "price"
    # Without fallbacks, the cheapest host being down is a failed cycle rather
    # than a slightly pricier one.
    assert routing["allow_fallbacks"] is True
    # See module docstring: this is the tool-calling guard, not decoration.
    assert routing["require_parameters"] is True


def test_non_openrouter_model_is_untouched(monkeypatch):
    """DeepSeek direct is a host, not a route — a provider block would be meaningless
    at best and rejected at worst."""
    seen = _run("deepseek/deepseek-v4-flash", monkeypatch, api_key="sk-deepseek-test")
    assert "provider" not in (seen.get("extra_body") or {})


def test_sort_is_overridable_and_disablable(monkeypatch):
    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "throughput")
    seen = _run("openrouter/tencent/hy3", monkeypatch)
    assert seen["extra_body"]["provider"]["sort"] == "throughput"

    monkeypatch.setenv("OPENROUTER_PROVIDER_SORT", "off")
    seen = _run("openrouter/tencent/hy3", monkeypatch)
    assert "provider" not in (seen.get("extra_body") or {})


def test_routing_coexists_with_deepseek_thinking_toggle(monkeypatch):
    """Routing merges into extra_body rather than clobbering what is already there.

    This used to assert that the DeepSeek thinking toggle ALSO applies to OpenRouter-hosted
    DeepSeek. Since the reasoning cap was added, that combination is exactly what OpenRouter
    refuses (400, both reasoning controls) — see
    test_openrouter_deepseek_never_sends_two_reasoning_controls. The cap now plays that
    part: it is written first, and routing must sit beside it."""
    monkeypatch.setenv("DEEPSEEK_DISABLE_THINKING", "1")
    monkeypatch.delenv("OPENROUTER_PROVIDER_SORT", raising=False)
    seen = _run("openrouter/deepseek/deepseek-v4-flash-0731", monkeypatch)

    extra = seen["extra_body"]
    assert "chat_template_kwargs" not in extra
    assert extra["provider"]["sort"] == "price"


# ── Billed-cost reporting ────────────────────────────────────────────────────
# Routing by price means an openrouter/ model no longer has one rate: the upstream
# that wins the sort sets it. A static per-model price therefore drifts from the real
# invoice, so we ask OpenRouter what it billed and carry that number out.

class _Usage:
    """litellm's usage object: OpenAI fields as attributes, extras in model_extra."""

    def __init__(self, prompt=100, completion=50, **extra):
        self.prompt_tokens = prompt
        self.completion_tokens = completion
        self.total_tokens = prompt + completion
        self.model_extra = extra


def test_openrouter_request_asks_for_billed_cost(monkeypatch):
    monkeypatch.delenv("OPENROUTER_PROVIDER_SORT", raising=False)
    seen = _run("openrouter/tencent/hy3", monkeypatch)
    assert seen["extra_body"]["usage"] == {"include": True}, \
        "without usage.include OpenRouter reports no cost and we are back to guessing"


def test_billed_cost_is_extracted_with_the_tokens_it_covers():
    fields = lp._reported_cost_fields(_Usage(cost=0.00042), 100, 50)
    assert fields["reported_cost_usd"] == pytest.approx(0.00042)
    # The token counts are what let the JS side price a provider-switching turn.
    assert fields["reported_cost_prompt_tokens"] == 100
    assert fields["reported_cost_completion_tokens"] == 50


def test_cost_falls_back_to_upstream_inference_cost():
    fields = lp._reported_cost_fields(
        _Usage(cost_details={"upstream_inference_cost": 0.0009}), 10, 5)
    assert fields["reported_cost_usd"] == pytest.approx(0.0009)


@pytest.mark.parametrize("extra", [
    {},                      # provider reported nothing
    {"cost": 0},             # zero is not a real invoice
    {"cost": None},
    {"cost": True},          # bool is an int in Python; must not become $1.00
])
def test_absent_or_bogus_cost_leaves_table_pricing_alone(extra):
    """Returning {} is what makes this safe to ship: every non-OpenRouter provider
    keeps the exact pricing behaviour it had before."""
    assert lp._reported_cost_fields(_Usage(**extra), 10, 5) == {}


def test_cost_is_read_from_a_plain_dict_too():
    """Depending on litellm version the extras arrive as a dict, not an object."""
    fields = lp._reported_cost_fields({"cost": 0.002}, 7, 3)
    assert fields["reported_cost_usd"] == pytest.approx(0.002)


def test_billed_cost_reaches_llmresponse_usage(monkeypatch):
    """End-to-end through chat(): extraction is wired into the usage dict the loop
    aggregates, not just available as a helper."""
    class _R:
        def __init__(self):
            self.choices = [_Choice()]
            self.usage = _Usage(prompt=200, completion=80, cost=0.0011)

    async def _fake(**kwargs):
        return _R()

    monkeypatch.setattr(lp, "acompletion", _fake)
    provider = lp.LiteLLMProvider(api_key="sk-or-v1-test")
    resp = asyncio.run(provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        model="openrouter/inclusionai/ling-3.0-flash",
    ))
    assert resp.usage["reported_cost_usd"] == pytest.approx(0.0011)
    assert resp.usage["reported_cost_prompt_tokens"] == 200
    assert resp.usage["reported_cost_completion_tokens"] == 80



def test_openrouter_deepseek_never_sends_two_reasoning_controls(monkeypatch):
    """2026-09-30: with DEEPSEEK_DISABLE_THINKING on, an openrouter/deepseek model was sent
    reasoning_effort AND reasoning.max_tokens, and OpenRouter refused every call with 400."""
    monkeypatch.setenv("DEEPSEEK_DISABLE_THINKING", "1")
    seen = _run("openrouter/deepseek/deepseek-v4-flash-0731", monkeypatch, api_key="3f9a1c" + "0" * 58)
    body = seen.get("extra_body") or {}
    assert "reasoning_effort" not in body
    assert "thinking" not in body
    reasoning = body.get("reasoning") or {}
    assert not ("effort" in reasoning and "max_tokens" in reasoning)


def test_deepseek_direct_still_turns_thinking_off(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_DISABLE_THINKING", "1")
    seen = _run("deepseek/deepseek-v4-flash", monkeypatch, api_key="sk-deepseek-test")
    body = seen.get("extra_body") or {}
    assert body.get("thinking") == {"type": "disabled"}
    assert body.get("reasoning_effort") == "none"
