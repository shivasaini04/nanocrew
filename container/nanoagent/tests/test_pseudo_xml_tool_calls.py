"""Pseudo-XML tool-call recovery.

2026-08-17: a DeepSeek response on Finder's lead_search cycle emitted a batch of
tool calls as literal text — `<DSMLtool_calls><DSMLinvoke name="read_file">
<DSMLparameter name="path" string="true">...</DSMLparameter></DSMLinvoke>...
</DSMLtool_calls>` — instead of the provider's structured tool_calls field.
Undetected, has_tool_calls was False, so the loop treated the raw markup as the
agent's final answer and ended the turn mid-task: 307 raw prospects sat read but
never judged, and no handoff to Mailer followed. The fix recovers real tool
calls from this text instead of losing the turn.
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


# The actual malformed content observed in production (cycle
# db084798-4af7-43fe-92d8-7a3f32b090de, seq 7).
_REAL_PAYLOAD = (
    '<DSMLtool_calls>\n'
    '<DSMLinvoke name="read_file">\n'
    '<DSMLparameter name="path" string="true">/workspace/group/workspace/LEAD_DEFINITION.md</DSMLparameter>\n'
    '</DSMLinvoke>\n'
    '<DSMLinvoke name="read_file">\n'
    '<DSMLparameter name="path" string="true">/workspace/group/workspace/memory/knowledge/SEED_CURRENT.md</DSMLparameter>\n'
    '</DSMLinvoke>\n'
    '</DSMLtool_calls>'
)


# ── the parser itself ─────────────────────────────────────────────────────────

def test_recovers_both_calls_from_the_real_observed_payload():
    calls = lp._parse_pseudo_xml_tool_calls(_REAL_PAYLOAD)
    assert [c.name for c in calls] == ["read_file", "read_file"]
    assert calls[0].arguments == {"path": "/workspace/group/workspace/LEAD_DEFINITION.md"}
    assert calls[1].arguments == {"path": "/workspace/group/workspace/memory/knowledge/SEED_CURRENT.md"}


def test_ordinary_prose_yields_nothing():
    calls = lp._parse_pseudo_xml_tool_calls("Here's a summary of what I found today.")
    assert calls == []


def test_multi_param_invoke_and_type_coercion():
    payload = (
        '<invoke name="write_tracked_item">'
        '<parameter name="stage">qualified</parameter>'
        '<parameter name="score">7</parameter>'
        '<parameter name="verified">true</parameter>'
        '</invoke>'
    )
    calls = lp._parse_pseudo_xml_tool_calls(payload)
    assert len(calls) == 1
    assert calls[0].name == "write_tracked_item"
    assert calls[0].arguments == {"stage": "qualified", "score": 7, "verified": True}


def test_invoke_with_no_parameters_is_dropped():
    """A bare <invoke> with nothing inside isn't a recoverable call — don't
    fabricate a tool call with empty arguments the tool would just reject."""
    calls = lp._parse_pseudo_xml_tool_calls('<DSMLinvoke name="todo_write"></DSMLinvoke>')
    assert calls == []


# ── wired into the streaming response path ───────────────────────────────────

class _Delta:
    def __init__(self, content=None):
        self.content = content
        self.tool_calls = None


class _Choice:
    def __init__(self, content=None, finish_reason=None):
        self.delta = _Delta(content)
        self.finish_reason = finish_reason


class _Chunk:
    def __init__(self, content=None, finish_reason=None):
        self.choices = [_Choice(content, finish_reason)]


def _provider():
    return lp.LiteLLMProvider.__new__(lp.LiteLLMProvider)


def test_streaming_response_recovers_tool_calls_and_drops_raw_markup(monkeypatch):
    async def fake_acompletion(**kwargs):
        async def stream():
            yield _Chunk(_REAL_PAYLOAD)
            yield _Chunk(None, finish_reason="stop")

        return stream()

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)

    async def on_token(_t):
        pass

    result = asyncio.run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert result.has_tool_calls, "the turn must not silently end on malformed markup"
    assert [c.name for c in result.tool_calls] == ["read_file", "read_file"]
    assert result.content is None, "the raw pseudo-XML must not leak into chat as the final answer"


def test_streaming_response_with_real_tool_calls_is_untouched(monkeypatch):
    """The recovery path must only engage when the provider gave nothing usable —
    real structured tool_calls must never be second-guessed by this fallback."""

    class _RealDelta:
        def __init__(self, content=None, tool_calls=None):
            self.content = content
            self.tool_calls = tool_calls

    class _TCFunc:
        def __init__(self, name, arguments):
            self.name = name
            self.arguments = arguments

    class _TCDelta:
        def __init__(self, index, id_, name, arguments):
            self.index = index
            self.id = id_
            self.function = _TCFunc(name, arguments)

    class _RealChoice:
        def __init__(self, delta, finish_reason=None):
            self.delta = delta
            self.finish_reason = finish_reason

    class _RealChunk:
        def __init__(self, delta, finish_reason=None):
            self.choices = [_RealChoice(delta, finish_reason)]

    async def fake_acompletion(**kwargs):
        async def stream():
            yield _RealChunk(_RealDelta(tool_calls=[_TCDelta(0, "call_1", "read_file", '{"path": "/a"}')]))
            yield _RealChunk(_RealDelta(), finish_reason="tool_calls")

        return stream()

    monkeypatch.setattr(lp, "acompletion", fake_acompletion)
    monkeypatch.setattr(lp, "json_repair", types.SimpleNamespace(loads=lambda s: {"path": "/a"}))

    async def on_token(_t):
        pass

    result = asyncio.run(_provider()._chat_streaming({"model": "x"}, on_token))

    assert [c.name for c in result.tool_calls] == ["read_file"]
    assert result.tool_calls[0].id == "call_1"


# ── wired into the non-streaming response path ────────────────────────────────

class _Message:
    def __init__(self, content=None, tool_calls=None, reasoning_content=None):
        self.content = content
        self.tool_calls = tool_calls
        self.reasoning_content = reasoning_content


class _NSChoice:
    def __init__(self, message, finish_reason=None):
        self.message = message
        self.finish_reason = finish_reason


class _NSResponse:
    def __init__(self, message, finish_reason=None, usage=None):
        self.choices = [_NSChoice(message, finish_reason)]
        self.usage = usage


def test_non_streaming_response_recovers_tool_calls():
    provider = _provider()
    response = _NSResponse(_Message(content=_REAL_PAYLOAD))

    result = provider._parse_response(response)

    assert result.has_tool_calls
    assert [c.name for c in result.tool_calls] == ["read_file", "read_file"]
    assert result.content is None


def test_non_streaming_response_with_real_tool_calls_is_untouched():
    provider = _provider()

    class _TCFunc:
        name = "read_file"
        arguments = '{"path": "/a"}'

    class _TC:
        id = "call_1"
        function = _TCFunc()

    response = _NSResponse(_Message(content=None, tool_calls=[_TC()]))

    result = provider._parse_response(response)

    assert [c.name for c in result.tool_calls] == ["read_file"]
    assert result.tool_calls[0].id == "call_1"


# ── GLM's native shape ───────────────────────────────────────────────────────
#
# 2026-09-10, Crawler a live cycle on openrouter/z-ai/glm-5.3-flash. The model called
# yc_jobs while it was still deferred (absent from the schema list), the provider could not
# convert the call, and this arrived as plain .content. The DeepSeek pattern needs
# `name="..."` attributes, so it saw nothing and the loop ended the cycle having run no tool.

_REAL_GLM_PAYLOAD = (
    '<tool_call>yc_jobs<arg_key>action</arg_key><arg_value>sweep</arg_value>'
    '<arg_key>pages</arg_key><arg_value>3</arg_value>'
    '<arg_key>roles</arg_key><arg_value>["operations", "support"]</arg_value></tool_call>'
)


def test_recovers_the_real_observed_glm_payload():
    calls = lp._parse_pseudo_xml_tool_calls(_REAL_GLM_PAYLOAD)

    assert [c.name for c in calls] == ["yc_jobs"]
    assert calls[0].arguments == {"action": "sweep", "pages": 3, "roles": ["operations", "support"]}


def test_glm_shape_with_the_template_newlines():
    """GLM's chat template puts each element on its own line."""
    payload = (
        "<tool_call>linkedin_jobs\n"
        "<arg_key>action</arg_key>\n<arg_value>sweep</arg_value>\n"
        "</tool_call>"
    )
    calls = lp._parse_pseudo_xml_tool_calls(payload)

    assert [c.name for c in calls] == ["linkedin_jobs"]
    assert calls[0].arguments == {"action": "sweep"}


def test_glm_zero_argument_call_is_kept():
    """Unlike an argument-less DeepSeek invoke, a bare GLM call is a real, complete call."""
    calls = lp._parse_pseudo_xml_tool_calls("<tool_call>self_report</tool_call>")

    assert [c.name for c in calls] == ["self_report"]
    assert calls[0].arguments == {}


def test_the_same_leaked_glm_call_quoted_twice_runs_once():
    """The leaked call was seen quoted twice in one message. Replaying both would run a
    15-minute sweep twice."""
    calls = lp._parse_pseudo_xml_tool_calls(
        _REAL_GLM_PAYLOAD + "  **Accomplished:** " + _REAL_GLM_PAYLOAD
    )

    assert len(calls) == 1


def test_two_different_glm_calls_both_survive():
    payload = (
        "<tool_call>tool_search<arg_key>query</arg_key><arg_value>select:yc_jobs</arg_value></tool_call>"
        "<tool_call>yc_jobs<arg_key>action</arg_key><arg_value>sweep</arg_value></tool_call>"
    )
    calls = lp._parse_pseudo_xml_tool_calls(payload)

    assert [c.name for c in calls] == ["tool_search", "yc_jobs"]


def test_a_glm_fragment_with_its_name_cut_off_is_not_guessed():
    """The second leak (83011180) arrived with `<tool_call>yc_jobs` already truncated.
    There is no name left in that text, and recovery that guessed one would run a tool
    nobody chose."""
    truncated = (
        '<arg_value>sweep</arg_value><arg_key>pages</arg_key><arg_value>3</arg_value>'
        '<arg_key>roles</arg_key><arg_value>["operations", "support"]</arg_value></tool_call>'
    )
    assert lp._parse_pseudo_xml_tool_calls(truncated) == []


def test_deepseek_shape_still_wins_when_present():
    """The GLM pass only runs when the DeepSeek pattern found nothing, so a payload the old
    parser already handled cannot change behaviour."""
    calls = lp._parse_pseudo_xml_tool_calls(_REAL_PAYLOAD)

    assert [c.name for c in calls] == ["read_file", "read_file"]
    assert all(c.id.startswith("pseudo_") and not c.id.startswith("pseudo_glm") for c in calls)
