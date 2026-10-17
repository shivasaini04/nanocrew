"""The container half of which tools an agent has.

There is no per-agent tool allowlist (removed 2026-09-14 at the owner's request): every
agent keeps the whole registry. The orchestrator sends `withheldTools` — only the outbound
tools (email, WhatsApp, voice, messaging) its owner has not granted — and the adapter
withdraws exactly those. These pin that nothing else is taken away.

The one exception is a stage 57 worker, which is cut to an allowlist — see
nanoagent/agent/worker_policy.py and test_stage57_workers.py.
"""
from __future__ import annotations

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry


class _Fake(Tool):
    def __init__(self, name: str) -> None:
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return "fake"

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs):
        return "ok"


def _registry(*names: str) -> ToolRegistry:
    reg = ToolRegistry()
    for n in names:
        reg.register(_Fake(n))
    return reg


def _apply(reg: ToolRegistry, payload: dict) -> list[str]:
    """The adapter's withholding block, verbatim in behaviour."""
    withheld_tools = payload.get("withheldTools")
    withdrawn: list[str] = []
    if isinstance(withheld_tools, list):
        withdrawn = [str(t) for t in withheld_tools if reg.has(str(t))]
        for name in withdrawn:
            reg.withdraw(name)
    return withdrawn


def test_only_the_named_tools_are_withheld():
    reg = _registry("web_search", "smtp_send", "emit_artifact", "read_file")
    assert _apply(reg, {"withheldTools": ["smtp_send"]}) == ["smtp_send"]
    assert set(reg.tool_names) == {"web_search", "emit_artifact", "read_file"}


def test_nothing_withheld_leaves_every_tool():
    reg = _registry("web_search", "smtp_send", "read_file")
    assert _apply(reg, {"withheldTools": []}) == []
    assert _apply(reg, {}) == []
    assert len(reg.tool_names) == 3


def test_the_old_allowlist_field_restricts_nothing():
    """A stale orchestrator still sending `allowedTools` must not bring the allowlist back."""
    reg = _registry("web_search", "smtp_send", "emit_artifact")
    assert _apply(reg, {"allowedTools": ["web_search"]}) == []
    assert len(reg.tool_names) == 3


def test_a_withheld_tool_the_agent_does_not_have_is_ignored():
    reg = _registry("web_search")
    assert _apply(reg, {"withheldTools": ["voice_call", "gmail_send"]}) == []
    assert reg.tool_names == ["web_search"]


def test_a_withheld_tool_can_still_be_restored():
    """withdraw(), not unregister(): the registry keeps it, as the borrow path expects."""
    reg = _registry("send_whatsapp")
    _apply(reg, {"withheldTools": ["send_whatsapp"]})
    assert reg.get("send_whatsapp") is None
    assert reg.restore("send_whatsapp") is True
    assert reg.get("send_whatsapp") is not None
