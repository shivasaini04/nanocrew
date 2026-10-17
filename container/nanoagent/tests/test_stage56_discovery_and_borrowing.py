"""Stage 56 phases 2-3 — the container half of discovery and borrowing.

Two properties are load-bearing here and neither is obvious from the route contract:

  1. **A withheld tool must survive enforcement.** Grant enforcement used to `unregister`
     a tool the agent was not granted, which deletes the object outright — and a deleted
     tool cannot be lent back, because there is nothing left in the container to restore.
     `withdraw` stashes it instead. From the model's side nothing changes: it is still
     absent from the schema and still unexecutable.

  2. **An authorised borrow must be OBSERVABLE on the same turn.** If the server says yes
     and the tool does not appear, the model concludes the borrow failed and tries
     something else — which is the retry storm this stage keeps designing against.
"""
from __future__ import annotations

import json
import os

import pytest

from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry
from nanoagent.agent.tools.borrow_tool import BorrowToolTool
from nanoagent.agent.tools.find_agent import FindAgentTool


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
    r = ToolRegistry()
    for n in names:
        r.register(_Fake(n))
    return r


# ── the registry half ────────────────────────────────────────────────────────

def test_withdraw_hides_the_tool_exactly_as_deletion_did():
    r = _registry("read_file", "verify_email")
    r.withdraw("verify_email")

    assert not r.has("verify_email")
    assert "verify_email" not in [d["function"]["name"] for d in r.get_definitions()]


def test_withdraw_keeps_it_lendable_where_unregister_did_not():
    r = _registry("read_file", "verify_email")
    r.withdraw("verify_email")
    assert r.withdrawn_names() == ["verify_email"]

    assert r.restore("verify_email") is True
    assert r.has("verify_email")


def test_a_restored_tool_is_advertised_immediately():
    """A borrowed tool the model cannot see is a borrow the model believes failed."""
    r = _registry("read_file", "verify_email")
    r.withdraw("verify_email")
    r.enable_deferral({"read_file"})

    r.restore("verify_email")
    assert "verify_email" in [d["function"]["name"] for d in r.get_definitions()]


def test_restore_refuses_a_tool_that_was_never_withdrawn():
    r = _registry("read_file")
    assert r.restore("verify_email") is False
    assert not r.has("verify_email")


def test_unregister_still_deletes_outright():
    """Deletion is still available; it is simply no longer what enforcement uses."""
    r = _registry("verify_email")
    r.unregister("verify_email")
    assert r.restore("verify_email") is False


# ── borrow_tool ──────────────────────────────────────────────────────────────

def _stub(monkeypatch, *, status=200, body=None, seen=None):
    class _Resp:
        status_code = status
        text = json.dumps(body or {})

        def json(self):
            return body or {}

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, headers=None, timeout=None):
            if seen is not None:
                seen["url"] = url
                seen["json"] = json
            return _Resp()

        async def get(self, url, headers=None, timeout=None):
            if seen is not None:
                seen["url"] = url
            return _Resp()

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **k: _Client())


@pytest.mark.asyncio
async def test_a_granted_borrow_puts_the_tool_back_and_sets_only_its_credentials(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.delenv("HUNTER_API_KEY", raising=False)

    reg = _registry("verify_email", "read_file")
    reg.withdraw("verify_email")

    _stub(monkeypatch, body={
        "ok": True, "tool": "verify_email",
        "holder": {"id": "agent-herald", "name": "Mailer"},
        "env": {"HUNTER_API_KEY": "herald-key"},
        "credentialNote": "Lending Mailer's hunter credentials for this cycle only.",
        "note": "call it now",
    })

    out = await BorrowToolTool(registry=reg).execute(tool="verify_email", reason="checking 3 leads")

    assert json.loads(out)["borrowed"] is True
    assert reg.has("verify_email")                      # callable on this turn
    assert os.environ["HUNTER_API_KEY"] == "herald-key"  # and it can authenticate


@pytest.mark.asyncio
async def test_says_so_when_the_tool_is_authorised_but_absent_from_this_build(monkeypatch):
    """Authorised and missing is a real state: the lender's tool may not exist here.

    Reporting success would have the model call a tool that does not exist and then
    conclude the whole capability is broken, rather than handing the work over.
    """
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")

    reg = _registry("read_file")  # verify_email is not in this build at all
    _stub(monkeypatch, body={
        "ok": True, "tool": "verify_email",
        "holder": {"id": "h", "name": "Mailer"}, "env": {}, "note": "",
    })

    body = json.loads(await BorrowToolTool(registry=reg).execute(tool="verify_email", reason="x"))
    assert body["borrowed"] is False
    assert "handoff_to" in body["error"]


@pytest.mark.asyncio
async def test_a_refusal_names_who_does_hold_it(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    _stub(monkeypatch, status=404, body={
        "error": "Recruiter is not granted `verify_email`.",
        "holders": ["Mailer", "Seeker"],
    })

    out = await BorrowToolTool(registry=_registry()).execute(
        tool="verify_email", from_agent="Recruiter", reason="x",
    )
    # The next move is in the refusal. "That failed" is what produces a retry storm.
    assert "Mailer" in out and "Seeker" in out


@pytest.mark.asyncio
async def test_borrowing_outside_a_cycle_refuses_rather_than_assuming(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)

    out = await BorrowToolTool(registry=_registry()).execute(tool="verify_email", reason="x")
    assert "assuming the tool is available" in out


# ── find_agent ───────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_find_agent_asks_the_crew_route_with_the_capability(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://orch:3002")
    seen: dict = {}
    _stub(monkeypatch, body={"query": "verify an email", "found": 1, "report": "Mailer — sends outreach"}, seen=seen)

    out = await FindAgentTool().execute(capability="verify an email")

    assert seen["url"].startswith("http://orch:3002/api/agents/agent-scout/self/find-agent?q=")
    # The rendered report is the product; raw match objects are deliberately not returned.
    assert out == "Mailer — sends outreach"


@pytest.mark.asyncio
async def test_find_agent_refuses_to_guess_who_exists_outside_a_cycle(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-scout")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)

    out = await FindAgentTool().execute(capability="verify an email")
    assert "rather than guessing who exists" in out


def test_both_are_advertised_not_deferred():
    """The trigger for find_agent is realising you cannot do something.

    A model that must first guess this tool exists will instead conclude the task is
    impossible, or invent a teammate — which is how the network stayed the three-node
    chain its three prompts described.
    """
    import inspect

    from nanoagent.agent import loop as loop_mod

    core = inspect.getsource(loop_mod).split("_CORE_TOOLS = {", 1)[1].split("}", 1)[0]
    assert '"find_agent"' in core
    assert '"borrow_tool"' in core
