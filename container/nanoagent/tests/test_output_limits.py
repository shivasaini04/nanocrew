"""Output ceilings per model, not per chain.

GLM 5.3 Flash was held to 8,192 output tokens — litellm had no entry for it, and a fallback
chain took the minimum across all its models — while OpenRouter publishes 943,717. A
reasoning model spent it all thinking and an agent could not write a 300-line file.
"""
import asyncio

import pytest

from nanoagent.providers import output_limits
from nanoagent.providers.base import LLMProvider, LLMResponse
from nanoagent.providers.fallback_provider import FallbackProvider


@pytest.fixture(autouse=True)
def openrouter_caps(monkeypatch):
    monkeypatch.setattr(output_limits, "_openrouter_caps", {"z-ai/glm-5.3-flash": 943717, "tiny/model": 4000})


def test_openrouter_models_get_openrouters_own_figure():
    assert output_limits.model_output_cap("openrouter/z-ai/glm-5.3-flash") == 943717


def test_one_step_is_bounded_by_the_practical_ceiling():
    assert output_limits.step_ceiling("openrouter/z-ai/glm-5.3-flash") == output_limits.PRACTICAL_MAX_TOKENS
    assert output_limits.step_ceiling("openrouter/tiny/model") == 4000


def test_a_model_nobody_knows_keeps_the_floor():
    assert output_limits.model_output_cap("openrouter/nobody/knows") == output_limits.UNKNOWN_MODEL_MAX_TOKENS
    assert output_limits.model_output_cap("madeup-provider/madeup-model") == output_limits.UNKNOWN_MODEL_MAX_TOKENS


def test_an_unreachable_openrouter_falls_back_to_litellm_then_the_floor(monkeypatch):
    monkeypatch.setattr(output_limits, "_openrouter_caps", None)
    monkeypatch.setattr(output_limits, "_OPENROUTER_MODELS_URL", "http://127.0.0.1:9/nothing")
    assert output_limits.model_output_cap("openrouter/nobody/knows") == output_limits.UNKNOWN_MODEL_MAX_TOKENS


def test_one_unknown_fallback_no_longer_caps_the_primary(monkeypatch):
    """What actually held every agent to 8,192 on prod: the default chain ends in
    groq/llama-3.3-70b-versatile, which prod's litellm has no entry for, and the ceiling was
    the chain's minimum. Now the primary keeps its own and the unknown one only its own.
    (litellm's table differs by version, so "unknown" is made so here, as it is on prod.)"""
    import litellm

    def unknown(model):
        raise Exception(f"{model} not mapped")

    monkeypatch.setattr(litellm, "get_max_tokens", unknown)
    assert output_limits.model_output_cap("groq/llama-3.3-70b-versatile") == output_limits.UNKNOWN_MODEL_MAX_TOKENS
    assert output_limits.step_ceiling("openrouter/z-ai/glm-5.3-flash") == output_limits.PRACTICAL_MAX_TOKENS


def test_a_longer_reply_gets_a_longer_call_timeout():
    assert output_limits.call_timeout_s(8192) >= 120
    assert output_limits.call_timeout_s(32768) > 500
    assert output_limits.call_timeout_s(10**7) == 540


class Recording(LLMProvider):
    def __init__(self, fail: bool):
        super().__init__(api_key="k")
        self.fail = fail
        self.max_tokens_seen = None

    def get_default_model(self) -> str:
        return "x"

    async def chat(self, messages, tools=None, model=None, temperature=0.1, max_tokens=4096, on_token=None, **kw):
        self.max_tokens_seen = max_tokens
        if self.fail:
            raise TimeoutError("provider down")
        return LLMResponse(content="ok", finish_reason="stop")


def test_each_fallback_call_is_clamped_to_its_own_model():
    primary, fallback = Recording(fail=True), Recording(fail=False)
    fp = FallbackProvider([(primary, "big"), (fallback, "small")], output_caps={"big": 32768, "small": 8192})
    asyncio.run(fp.chat([{"role": "user", "content": "hi"}], max_tokens=32768))
    assert primary.max_tokens_seen == 32768, "the primary is no longer held to the chain's smallest"
    assert fallback.max_tokens_seen == 8192, "the fallback is not asked for more than it allows"
