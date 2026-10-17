"""A pipeline the model writes once should cost one turn, not one turn per step.

Stage 42 item #11. ``python_repl`` was a stateful REPL that could not reach the
agent's tools, so a ten-step pipeline cost ten inference turns — and because every
iteration resends the whole history, those resends dominate the cost of a long cycle.

Hermes needs a Unix socket and a generated stub for this because their script runs
in another process. Ours runs on a thread of the same process as the registry, so
the call only crosses a thread boundary. These tests hold that boundary honest:
results come back, failures surface as failures, hangs time out, and the one tool
that would deadlock is refused by name.
"""
import asyncio

import pytest

from nanoagent.agent.tool_bridge import ToolBridge
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


class Echo(Tool):
    def __init__(self, name="echo"):
        self._name = name
        self.calls: list[dict] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "echoes"

    @property
    def parameters(self) -> dict:
        return {
            "type": "object",
            "properties": {"value": {"type": "string"}},
            "required": ["value"],
        }

    async def execute(self, value: str = "", **kwargs) -> str:
        self.calls.append({"value": value, **kwargs})
        return f"echo:{value}"


class Hangs(Echo):
    @property
    def parameters(self) -> dict:
        # No required args: otherwise validation rejects the call before the tool
        # ever runs, and the test proves nothing about hanging.
        return {"type": "object", "properties": {}, "required": []}

    async def execute(self, **kwargs) -> str:
        await asyncio.sleep(30)
        return "never"


async def bridge_for(*tools, timeout=120) -> ToolBridge:
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return ToolBridge(registry, asyncio.get_running_loop(), timeout=timeout)


async def in_worker(fn):
    """Run ``fn`` on a worker thread, as python_repl runs the model's code."""
    return await asyncio.get_running_loop().run_in_executor(None, fn)


# ─── calling tools from a worker thread ─────────────────────────────────────


async def test_a_tool_can_be_called_as_a_function():
    echo = Echo()
    tools = await bridge_for(echo)

    result = await in_worker(lambda: tools.echo(value="hi"))

    assert result == "echo:hi"
    assert echo.calls == [{"value": "hi"}]


async def test_a_loop_of_calls_costs_one_turn():
    """The point of the feature: many calls, one python_repl invocation."""
    echo = Echo()
    tools = await bridge_for(echo)

    def pipeline():
        return [tools.echo(value=str(i)) for i in range(10)]

    results = await in_worker(pipeline)

    assert results[-1] == "echo:9"
    assert len(echo.calls) == 10


async def test_call_by_name_works_too():
    tools = await bridge_for(Echo())

    assert await in_worker(lambda: tools.call("echo", value="x")) == "echo:x"


async def test_tool_errors_come_back_as_the_registry_reports_them():
    """The registry already turns exceptions into 'Error: ...' strings; don't
    reinvent that here."""
    tools = await bridge_for(Echo())

    result = await in_worker(lambda: tools.echo())  # missing required arg

    assert "Error" in result


# ─── the guardrails ─────────────────────────────────────────────────────────


async def test_python_repl_cannot_call_itself():
    """It holds a per-cycle lock, so re-entry would deadlock, not error."""
    tools = await bridge_for(Echo("python_repl"))

    with pytest.raises(AttributeError, match="deadlock"):
        tools.python_repl

    with pytest.raises(ValueError):
        tools.call("python_repl")


async def test_an_unknown_tool_says_what_is_available():
    tools = await bridge_for(Echo("verify_email"))

    with pytest.raises(AttributeError, match="verify_email"):
        tools.no_such_tool


async def test_a_hanging_tool_times_out_instead_of_pinning_the_repl():
    tools = await bridge_for(Hangs("slow"), timeout=1)

    with pytest.raises(TimeoutError, match="abandoned"):
        await in_worker(lambda: tools.slow())


async def test_listing_hides_what_cannot_be_called():
    tools = await bridge_for(Echo("a"), Echo("python_repl"), Echo("b"))

    assert tools.list() == ["a", "b"]


async def test_dunder_access_is_not_treated_as_a_tool():
    """Otherwise copy/pickle/inspect machinery would look like tool calls."""
    tools = await bridge_for(Echo())

    with pytest.raises(AttributeError):
        tools.__deepcopy__
