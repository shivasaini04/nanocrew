"""Stage 57, the container half: what a worker may use, how it reports, how a boss delegates.

The orchestrator half (limits, verifiers, the engine) is tested in src/swarm/*.test.ts.
"""
from __future__ import annotations

import json

from nanoagent.agent import worker_policy
from nanoagent.agent.tools import delegate as d
from nanoagent.agent.tools.base import Tool
from nanoagent.agent.tools.registry import ToolRegistry
from nanoagent.agent.tools.report_result import ReportResultTool


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


SCHEMA = {
    "type": "object",
    "properties": {"company": {"type": "string"}, "employees": {"type": "integer"}},
    "required": ["company", "employees"],
}


# ── the allowlist ─────────────────────────────────────────────────────────────

def test_a_worker_keeps_only_its_allowlist_and_report_result(tmp_path):
    reg = _registry("web_search", "web_fetch", "smtp_send", "self_manage", "delegate", "generate_tool")
    dropped = worker_policy.apply_worker_policy(
        reg, {"allowedTools": ["web_search", "web_fetch", "report_result"], "reportSchema": SCHEMA},
        tmp_path / "result.json",
    )
    assert set(reg.tool_names) == {"web_search", "web_fetch", "report_result"}
    assert set(dropped) == {"smtp_send", "self_manage", "delegate", "generate_tool"}


def test_a_removed_tool_cannot_be_lent_back(tmp_path):
    reg = _registry("web_search", "smtp_send")
    worker_policy.apply_worker_policy(reg, {"allowedTools": ["web_search"], "reportSchema": None}, tmp_path / "r.json")
    assert reg.restore("smtp_send") is False
    assert reg.get("smtp_send") is None


def test_every_allowed_tool_is_advertised_under_deferral(tmp_path):
    """A worker has no tool_search, so a deferred tool would be a tool it cannot find."""
    reg = _registry("web_search", "verify_email", "tool_search")
    reg.enable_deferral({"web_search", "tool_search"})
    worker_policy.apply_worker_policy(
        reg, {"allowedTools": ["web_search", "verify_email", "report_result"], "reportSchema": None}, tmp_path / "r.json",
    )
    advertised = {t["function"]["name"] for t in reg.get_definitions()}
    assert advertised == {"web_search", "verify_email", "report_result"}


def test_allowed_tools_alone_restricts_nothing(tmp_path):
    """Only a stage 57 worker (reportSchema present) is restricted. An ordinary cycle, or a
    stale orchestrator still sending the pre-2026-09-14 allowlist, keeps every tool."""
    reg = _registry("web_search", "smtp_send", "emit_artifact")
    assert worker_policy.apply_worker_policy(reg, {"allowedTools": ["web_search"]}, tmp_path / "r.json") == []
    assert set(reg.tool_names) == {"web_search", "smtp_send", "emit_artifact"}
    assert not worker_policy.is_worker({"allowedTools": ["web_search"]})


# ── report_result ─────────────────────────────────────────────────────────────

async def test_report_result_writes_the_contract(tmp_path):
    out = tmp_path / "result.json"
    tool = ReportResultTool(out, SCHEMA)
    msg = await tool.execute(result={"company": "Acme", "employees": 40}, summary="Found it on their site.",
                             evidence=["https://acme.example/about"], confidence=0.8)
    assert "stop" in msg.lower()
    assert json.loads(out.read_text()) == {
        "result": {"company": "Acme", "employees": 40}, "summary": "Found it on their site.",
        "evidence": ["https://acme.example/about"], "confidence": 0.8,
    }


def test_the_result_parameter_is_the_task_schema(tmp_path):
    params = ReportResultTool(tmp_path / "r.json", SCHEMA).parameters
    assert params["properties"]["result"]["properties"] == SCHEMA["properties"]
    assert params["properties"]["result"]["required"] == ["company", "employees"]
    assert params["required"] == ["result", "summary"]


def test_a_mismatch_is_caught_on_the_workers_own_turn(tmp_path):
    tool = ReportResultTool(tmp_path / "r.json", SCHEMA)
    errors = tool.validate_params({"result": {"company": "Acme"}, "summary": "s"})
    assert any("employees" in e for e in errors)


def test_an_object_sent_as_a_json_string_is_decoded(tmp_path):
    tool = ReportResultTool(tmp_path / "r.json", SCHEMA)
    params = {"result": '{"company": "Acme", "employees": 40}', "summary": "s"}
    assert tool.validate_params(params) == []
    assert params["result"] == {"company": "Acme", "employees": 40}


def test_without_a_schema_any_result_is_accepted(tmp_path):
    tool = ReportResultTool(tmp_path / "r.json", None)
    assert "type" not in tool.parameters["properties"]["result"]
    assert tool.validate_params({"result": "plain text answer", "summary": "s"}) == []
    assert tool.validate_params({"result": [1, 2], "summary": "s"}) == []


# ── delegate / run_status / steer_run ─────────────────────────────────────────

class _Server:
    """Stands in for the orchestrator: records calls, answers from a script."""

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []

    async def __call__(self, method, path, body=None, params=None, timeout=20):
        self.calls.append({"method": method, "path": path, "body": body, "params": params, "timeout": timeout})
        return self.answers.pop(0)


def _view(finished: bool):
    return 200, {
        "run": {"id": "run-1", "status": "done" if finished else "running", "spent_usd": 0.01, "budget_usd": 0.5,
                "finished_at": "2026-09-29T10:00:00Z" if finished else None},
        "digest": "## Accepted\n<worker_result>Acme: 40</worker_result>",
        "counts": {"accepted": 3},
    }


TASKS = [{"objective": "Find Acme's headcount", "output_schema": SCHEMA}]


async def test_delegate_starts_a_background_run_and_returns_the_digest(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-1", "budget_usd": 0.5}, "notes": []}), _view(True)])
    monkeypatch.setattr(d, "_call", server)
    out = await d.DelegateTool().execute(goal="Headcounts", tasks=TASKS)
    assert server.calls[0]["method"] == "POST"
    assert server.calls[0]["body"] == {"goal": "Headcounts", "tasks": TASKS, "background": True}
    assert server.calls[1]["params"] == {"wait_s": 120}
    assert server.calls[1]["timeout"] > 120
    assert "<worker_result>Acme: 40</worker_result>" in out
    assert "Still running" not in out


async def test_delegate_says_so_when_the_run_outlasts_the_wait(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-1", "budget_usd": 0.5}}), _view(False)])
    monkeypatch.setattr(d, "_call", server)
    out = await d.DelegateTool().execute(goal="g", tasks=TASKS, wait_seconds=999)
    assert server.calls[1]["params"] == {"wait_s": 240}
    assert "Still running" in out and "woken" in out
    # Hand the chat back; do not hold it by polling (a boss did, for 7.6 minutes).
    assert "End your turn now" in out
    assert "run_status(" not in out


async def test_delegate_with_no_wait_returns_at_once(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-1", "budget_usd": 0.5}})])
    monkeypatch.setattr(d, "_call", server)
    out = await d.DelegateTool().execute(goal="g", tasks=TASKS, wait_seconds=0)
    assert len(server.calls) == 1
    assert "run-1" in out and "woken" in out


async def test_a_run_over_a_dollar_waits_for_the_owner_and_the_chat_is_not_held(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-9", "status": "awaiting_approval", "budget_usd": 3.0}})])
    monkeypatch.setattr(d, "_call", server)
    out = await d.DelegateTool().execute(goal="Big sweep", tasks=TASKS, budget_usd=3.0)
    assert len(server.calls) == 1                     # no wait on a run that has not started
    assert "NOT started" in out and "approve" in out and "$3.00" in out


async def test_a_refused_run_lists_every_problem(monkeypatch):
    server = _Server([(422, {"error": "The run was not started.",
                             "problems": ["task 0: inputs.companies has 8 items", "budget_usd 5 is over $1"]})])
    monkeypatch.setattr(d, "_call", server)
    out = await d.DelegateTool().execute(goal="g", tasks=TASKS)
    assert "8 items" in out and "over $1" in out
    assert len(server.calls) == 1


async def test_delegate_task_translates_the_skill_argument_names(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-1"}}), _view(True)])
    monkeypatch.setattr(d, "_call", server)
    await d.DelegateTaskTool().execute(goal="Build the parser", context="Use pdfjs", toolsets=["terminal", "file", "web"])
    task = server.calls[0]["body"]["tasks"][0]
    assert task["objective"] == "Build the parser"
    assert task["inputs"] == {"context": "Use pdfjs"}
    assert task["tools"] == "compute"
    assert task["extra_tools"] == ["web_search", "web_fetch", "web_map"]


async def test_delegate_task_many_form(monkeypatch):
    server = _Server([(201, {"run": {"id": "run-1"}}), _view(True)])
    monkeypatch.setattr(d, "_call", server)
    await d.DelegateTaskTool().execute(goal="Compare", tasks=[{"goal": "a", "toolsets": ["web"]}, {"goal": "b"}])
    body = server.calls[0]["body"]
    assert body["goal"] == "Compare"
    assert [t["objective"] for t in body["tasks"]] == ["a", "b"]
    assert all(t["tools"] == "research" for t in body["tasks"])


async def test_run_status_waits_only_when_asked(monkeypatch):
    server = _Server([_view(False)])
    monkeypatch.setattr(d, "_call", server)
    out = await d.RunStatusTool().execute(run_id="run-1")
    assert server.calls[0]["params"] is None
    assert "Still running" in out


async def test_steer_run_sends_one_action(monkeypatch):
    server = _Server([(200, {"cancelled": True})])
    monkeypatch.setattr(d, "_call", server)
    await d.SteerRunTool().execute(run_id="run-1", action="cancel_task", task_index=2)
    assert server.calls[0]["path"] == "/run-1/steer"
    assert server.calls[0]["body"] == {"cancel_task": 2}


async def test_without_a_cycle_token_nothing_is_called(monkeypatch):
    """A worker has no token: the tool says so rather than calling the server."""
    monkeypatch.setenv("AGENT_ID", "a1")
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    status, data = await d._call("POST", "", body={})
    assert status == 0 and "token" in data["error"].lower()


def test_delegate_takes_race_and_timeout_where_a_model_puts_them():
    """Live 2026-09-29 (docs 20): race and timeout_minutes beside goal, verifier as one object.
    Both were refused, the model retried without them, and a race of 3 became one worker."""
    params = {
        "goal": "g", "race": 3, "timeout_minutes": "30", "budget_usd": 1,
        "tasks": [{"objective": "build it", "tools": "compute",
                   "verifier": {"kind": "command", "run": "python t.py", "files": {"t.py": "assert True"}}}],
    }
    errors = d.DelegateTool().validate_params(params)
    assert errors == []
    t = params["tasks"][0]
    assert t["race"] == 3 and str(t["timeout_minutes"]) == "30"
    assert isinstance(t["verifier"], list) and t["verifier"][0]["kind"] == "command"
    assert "race" not in params and "timeout_minutes" not in params


def test_a_task_that_sets_its_own_race_keeps_it():
    params = {"goal": "g", "race": 3, "tasks": [{"objective": "a", "race": 2}, {"objective": "b"}]}
    assert d.DelegateTool().validate_params(params) == []
    assert [t.get("race") for t in params["tasks"]] == [2, 3]


def test_a_worker_that_stops_before_reporting_is_asked_to_report(tmp_path):
    check = worker_policy.report_stop_check(tmp_path / "result.json")
    assert "report_result" in check()
    (tmp_path / "result.json").write_text("{}")
    assert check() is None
