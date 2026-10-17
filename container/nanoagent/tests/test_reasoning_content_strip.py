"""reasoning_content is required by DeepSeek and rejected by Groq.

2026-09-30: a GLM 5.3 cycle timed out, the fallback chain reached
groq/llama-3.3-70b-versatile, and Groq answered 400 "property 'reasoning_content' is
unsupported" because the history carried GLM's reasoning. The key must survive for DeepSeek
(and everything else) and be dropped only for Groq.
"""
from nanoagent.providers.litellm_provider import LiteLLMProvider, _strip_reasoning_for

HISTORY = [
    {"role": "user", "content": "hi"},
    {"role": "assistant", "content": "hello", "reasoning_content": "thinking…"},
    {"role": "user", "content": "again"},
    {"role": "assistant", "content": "ok"},
]


def _sanitized():
    return LiteLLMProvider._sanitize_messages(HISTORY)


def test_groq_gets_no_reasoning_content():
    out = _strip_reasoning_for("groq/llama-3.3-70b-versatile", _sanitized())
    assert all("reasoning_content" not in m for m in out)
    assert [m["content"] for m in out] == ["hi", "hello", "again", "ok"]


def test_groq_behind_a_proxy_prefix_is_still_groq():
    out = _strip_reasoning_for("litellm_proxy/groq/llama-3.3-70b-versatile", _sanitized())
    assert all("reasoning_content" not in m for m in out)


def test_deepseek_keeps_it_including_the_backfilled_empty_one():
    out = _strip_reasoning_for("deepseek/deepseek-v4-flash", _sanitized())
    assert out[1]["reasoning_content"] == "thinking…"
    # _sanitize_messages backfills later assistant turns — DeepSeek rejects a gap.
    assert out[3]["reasoning_content"] == ""


def test_openrouter_keeps_it():
    out = _strip_reasoning_for("openrouter/z-ai/glm-5.3-flash", _sanitized())
    assert out[1]["reasoning_content"] == "thinking…"


def test_a_model_merely_named_groq_is_not_the_provider():
    # Only a provider segment counts, never the model name itself.
    out = _strip_reasoning_for("openrouter/someone/groq-style-model", _sanitized())
    assert out[1]["reasoning_content"] == "thinking…"
