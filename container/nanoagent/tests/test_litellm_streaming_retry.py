"""Streaming retry policy: retry up to the first token, never after it.

A provider that dies during the handshake (DeepSeek's "Service is too busy" 503s,
or a connection reset) has emitted nothing to the caller, so another attempt is
free. Once a token has been forwarded the stream is committed and a retry would
replay visible output, so the error has to surface instead.

Before this policy existed the streaming path had no retry at all, and a single
transient provider blip killed a whole scheduled agent cycle.

litellm/json_repair are stubbed the same way conftest.py stubs nanoagent.agent —
these are pure control-flow assertions and shouldn't need the container image.
"""

import asyncio
import sys
import types

import pytest

# ── Stub the heavy provider deps before importing the module under test ──────
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

# ``nanoagent/providers/__init__.py`` eagerly re-exports every provider, dragging in
# loguru/telegram/slack. Same trick conftest.py uses for ``nanoagent.agent``: register a
# stand-in package with the same __path__ so the leaf module resolves on its own.
if "nanoagent.providers" not in sys.modules:
    import pathlib

    import nanoagent

    _providers = types.ModuleType("nanoagent.providers")
    _providers.__path__ = [str(pathlib.Path(nanoagent.__file__).parent / "providers")]
    sys.modules["nanoagent.providers"] = _providers

import nanoagent.providers.litellm_provider as lp  # noqa: E402

# ── Minimal stand-ins for the streaming chunk shape ──────────────────────────

class _Delta:
    def __init__(self, content=None):
        self.content = content


class _Choice:
    def __init__(self, content=None, finish_reason=None):
        self.delta = _Delta(content)
        self.finish_reason = finish_reason


class _Chunk:
    def __init__(self, content=None, finish_reason=None):
        self.choices = [_Choice(content, finish_reason)]


class _ProviderError(Exception):
    """Mimics a litellm exception: the status lives on the exception object."""

    def __init__(self, status_code=None, message="boom"):
        super().__init__(message)
        self.status_code = status_code


def _provider():
    """Build the provider without __init__ — these paths touch no instance state."""
    return lp.LiteLLMProvider.__new__(lp.LiteLLMProvider)


@pytest.fixture(autouse=True)
def _no_backoff_sleep(monkeypatch):
    """Keep the exponential backoff from making the suite take minutes."""
    async def _instant(_seconds):
        return None

    monkeypatch.setattr(lp.asyncio, "sleep", _instant)


def _run(coro):
    return asyncio.run(coro)


def test_retries_when_provider_dies_before_first_token(monkeypatch):
    """The Aug-4 failure mode: 503 during handshake, nothing emitted yet."""
    attempts = []

    async def fake_acompletion(**kwargs):
        attempts.append(1)
        if len(attempts) < 3:
            raise _ProviderError(503, "Service is too busy")

        async def stream():
            yield _Chunk("hello ")
            yield _Chunk("world", finish_reason="stop")

        return stream()

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)

    tokens = []

    async def on_token(t):
        tokens.append(t)

    result = _run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert len(attempts) == 3, "should have retried twice before succeeding"
    assert result.content == "hello world"
    assert result.finish_reason == "stop"
    assert tokens == ["hello ", "world"], "caller sees each token exactly once"


def test_does_not_retry_once_a_token_was_emitted(monkeypatch):
    """A true mid-stream break must not replay the tokens already delivered."""
    attempts = []

    async def fake_acompletion(**kwargs):
        attempts.append(1)

        async def stream():
            yield _Chunk("partial answer")
            raise _ProviderError(None, "Connection reset by peer")

        return stream()

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)

    tokens = []

    async def on_token(t):
        tokens.append(t)

    result = _run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert len(attempts) == 1, "committed stream must not be retried"
    assert tokens == ["partial answer"], "no duplicated output"
    assert result.finish_reason == "error"
    assert "Connection reset" in (result.content or "")


def test_does_not_retry_fatal_status(monkeypatch):
    """400/401/403/404 are the caller's fault — retrying only burns budget."""
    attempts = []

    async def fake_acompletion(**kwargs):
        attempts.append(1)
        raise _ProviderError(400, "Invalid model name")

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)

    async def on_token(_t):
        raise AssertionError("no tokens should be emitted")

    # Raises rather than returning an error response: nothing reached the caller, so
    # the exception is what lets FallbackProvider fail over to another model. Swallowing
    # it into an LLMResponse is why the fallback chain was built but never engaged.
    with pytest.raises(_ProviderError) as excinfo:
        _run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert len(attempts) == 1, "a 400 is the caller's fault; retrying only burns budget"
    assert "Invalid model name" in str(excinfo.value)


def test_gives_up_after_max_attempts(monkeypatch):
    """A provider that is down for good still returns an error, not a hang.

    This used to assert all eight attempts were spent. They never could be: eight rungs
    sleep 1+2+4+8+16+32+60 = 123 s and FallbackProvider bounds each provider at 120 s, so
    the run died as a timeout with the last rungs unreached. A 503 is now given a fixed
    sleeping budget and then handed to the next provider, which is the point of having
    one — waiting out the full ladder on a provider that is down is strictly worse than
    asking a provider that is up.
    """
    attempts = []

    async def fake_acompletion(**kwargs):
        attempts.append(1)
        raise _ProviderError(503, "Service is too busy")

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)

    async def on_token(_t):
        raise AssertionError("no tokens should be emitted")

    with pytest.raises(_ProviderError):
        _run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert 1 < len(attempts) <= lp._MAX_ATTEMPTS, "503 is retryable, up to the cap"


# ── reasoning_content consistency (2026-08-22 Crawler incident) ───────────
#
# DeepSeek's hybrid-reasoning models reject the whole request if any assistant
# message follows one that carried reasoning_content but itself omits the key.
# Session.get_history() backfills this for the window it loads from disk, but a
# daemon continuing a live turn, a fallback-chain hop through a non-thinking
# model, or _sanitize_tool_pairs's own repairs can each reopen the gap
# afterwards — so _sanitize_messages (the single funnel every outgoing request
# passes through) re-normalizes it right before the wire, regardless of how the
# messages list was assembled upstream.

def test_backfills_reasoning_content_after_it_first_appears():
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "reasoning_content": "thinking...", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_call_id": "1", "name": "x", "content": "result"},
        # This turn lost its reasoning_content upstream (fallback-chain hop, daemon
        # eviction, etc.) — must be backfilled with "" or DeepSeek rejects the request.
        {"role": "assistant", "content": "done"},
    ]

    sanitized = lp.LiteLLMProvider._sanitize_messages(messages)

    assert sanitized[1]["reasoning_content"] == "thinking..."
    assert sanitized[3]["reasoning_content"] == ""


def test_does_not_add_reasoning_content_when_never_present():
    """Non-thinking-mode conversations (or non-DeepSeek providers) must not gain
    a reasoning_content key they never had — only backfill once the pattern starts."""
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
        {"role": "user", "content": "again"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
    ]

    sanitized = lp.LiteLLMProvider._sanitize_messages(messages)

    assert all("reasoning_content" not in m for m in sanitized)


def test_preserves_real_reasoning_content_throughout():
    """A well-formed thinking-mode history (every assistant turn already carries
    the field) must pass through unchanged, not just get backfilled with empties."""
    messages = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "", "reasoning_content": "step 1", "tool_calls": [{"id": "1"}]},
        {"role": "tool", "tool_call_id": "1", "name": "x", "content": "result"},
        {"role": "assistant", "content": "done", "reasoning_content": "step 2"},
    ]

    sanitized = lp.LiteLLMProvider._sanitize_messages(messages)

    assert sanitized[1]["reasoning_content"] == "step 1"
    assert sanitized[3]["reasoning_content"] == "step 2"
