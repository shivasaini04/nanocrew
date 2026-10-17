"""An explicit "openrouter/" model runs on OpenRouter, whatever key the container holds.

2026-09-30, the first live cycle behind the key relay: the container held a cycle token
instead of an "sk-or-" key, gateway detection by key prefix found nothing, and
find_by_model() matched "openrouter/deepseek/deepseek-v4-flash-0731" to DeepSeek by keyword —
the call went to DeepSeek's API and came back 402 Insufficient Balance.
"""

import pytest

from nanoagent.providers.litellm_provider import LiteLLMProvider
from nanoagent.providers.registry import find_gateway_by_prefix

TOKEN = "3f9a1c" + "0" * 58  # what a relay-era container holds in place of the key


@pytest.mark.parametrize("model", [
    "openrouter/deepseek/deepseek-v4-flash-0731",
    "openrouter/google/gemini-3.5-flash-lite",
    "openrouter/moonshotai/kimi-k2.5",
    "openrouter/z-ai/glm-5.3-flash",
])
def test_openrouter_models_stay_on_openrouter_with_a_token(model):
    p = LiteLLMProvider(api_key=TOKEN, default_model=model)
    assert p._resolve_model(model) == model


def test_same_answer_as_with_a_real_key():
    model = "openrouter/deepseek/deepseek-v4-flash-0731"
    with_key = LiteLLMProvider(api_key="sk-or-v1-abc", default_model=model)._resolve_model(model)
    with_token = LiteLLMProvider(api_key=TOKEN, default_model=model)._resolve_model(model)
    assert with_token == with_key == model


@pytest.mark.parametrize("model", ["deepseek/deepseek-v4-flash", "gemini/gemini-3.5-flash", "groq/openai/gpt-oss-120b"])
def test_direct_providers_are_untouched(model):
    assert find_gateway_by_prefix(model) is None
    assert LiteLLMProvider(api_key=TOKEN, default_model=model)._resolve_model(model).split("/")[0] == model.split("/")[0]
