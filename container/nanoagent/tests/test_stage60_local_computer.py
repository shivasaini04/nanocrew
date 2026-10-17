"""Stage 60 phases 4-5 — the container side of the user's computer: files, terminal, desktop.

The desktop app decides what is allowed; these tests pin that the container asks the
right way, reports refusals usefully, and never lets a file cross its own workspace
boundary on the way in or out.
"""

from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import pytest

from nanoagent.agent.tools import local_computer as lc


class _Res:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body)

    def json(self):
        return self._body


def _client(responses: list, seen: list):
    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None, **k):
            seen.append({"url": url, "headers": headers, "json": json})
            return responses.pop(0)

    return C


@pytest.fixture
def connected(monkeypatch):
    import nanoagent.agent.effector.remote_page as rp

    monkeypatch.delenv("NC_BROWSER_LANE", raising=False)
    monkeypatch.setenv("AGENT_NAME", "Finder")
    monkeypatch.setattr(
        rp.RemoteConfig, "from_env",
        classmethod(lambda cls: rp.RemoteConfig(host="http://orch", agent_id="a1", cycle_token="tok", controller_id="ctl")),
    )
    seen: list = []

    def respond(*responses):
        monkeypatch.setattr(lc.httpx, "AsyncClient", _client(list(responses), seen))

    return respond, seen


def run(coro):
    return json.loads(asyncio.run(coro))


def test_cloud_choice_refuses_without_calling_out(monkeypatch):
    monkeypatch.setenv("NC_BROWSER_LANE", "cloud")
    out = run(lc.LocalFilesTool(Path("/tmp")).execute("list", path="C:/Users/me"))
    assert out["ok"] is False and "Cloud" in out["error"] and "This computer" in out["error"]


def test_not_connected_says_how_to_connect(monkeypatch):
    import nanoagent.agent.effector.remote_page as rp

    monkeypatch.delenv("NC_BROWSER_LANE", raising=False)
    monkeypatch.setattr(rp.RemoteConfig, "from_env", classmethod(lambda cls: None))
    out = run(lc.LocalTerminalTool().execute("dir"))
    assert out["ok"] is False and "desktop app" in out["error"]


def test_dispatch_is_token_gated_and_names_the_agent(connected):
    respond, seen = connected
    respond(_Res(200, {"ok": True, "result": {"roots": []}}))
    run(lc.LocalFilesTool(Path("/tmp")).execute("roots"))
    call = seen[0]
    assert call["url"] == "http://orch/api/agents/a1/browser-control/dispatch"
    assert call["headers"] == {"X-Cycle-Token": "tok"}
    assert call["json"]["capability"] == "fs.roots"
    assert call["json"]["controllerId"] == "ctl"
    assert call["json"]["payload"]["agentName"] == "Finder"


def test_a_refusal_on_the_machine_comes_back_as_the_machines_words(connected):
    respond, _ = connected
    respond(_Res(200, {"ok": False, "error": "The user denied read access to C:\\Users\\me\\Documents."}))
    out = run(lc.LocalFilesTool(Path("/tmp")).execute("list", path="C:\\Users\\me\\Documents"))
    assert out == {"ok": False, "error": "The user denied read access to C:\\Users\\me\\Documents."}


def test_an_older_controller_is_explained(connected):
    respond, _ = connected
    respond(_Res(409, {"ok": False, "error": "no controller for fs.list"}))
    out = run(lc.LocalFilesTool(Path("/tmp")).execute("list", path="~"))
    assert "desktop app" in out["error"]


def test_read_binary_saves_into_the_workspace(connected, tmp_path):
    respond, _ = connected
    blob = b"PK\x03\x04 fake xlsx"
    respond(_Res(200, {"ok": True, "result": {
        "path": "C:/Users/me/leads.xlsx", "size": len(blob), "encoding": "base64",
        "content": base64.b64encode(blob).decode(), "truncated": False,
    }}))
    out = run(lc.LocalFilesTool(tmp_path).execute("read", path="C:/Users/me/leads.xlsx", save_to="inbox/leads.xlsx"))
    assert (tmp_path / "inbox" / "leads.xlsx").read_bytes() == blob
    assert "content" not in out and out["saved_to"].endswith("leads.xlsx")


def test_save_to_cannot_escape_the_workspace(connected, tmp_path):
    respond, _ = connected
    respond(_Res(200, {"ok": True, "result": {"path": "x", "size": 1, "encoding": "text", "content": "x"}}))
    out = run(lc.LocalFilesTool(tmp_path).execute("read", path="x", save_to="../../etc/evil"))
    assert out["ok"] is False and "outside your workspace" in out["error"]


def test_write_from_workspace_sends_the_file_bytes(connected, tmp_path):
    respond, seen = connected
    (tmp_path / "leads.xlsx").write_bytes(b"\x00\x01binary")
    respond(_Res(200, {"ok": True, "result": {"path": "C:/Users/me/leads.xlsx", "bytes": 8, "replaced": False}}))
    out = run(lc.LocalFilesTool(tmp_path).execute("write", path="C:/Users/me/leads.xlsx", from_workspace="leads.xlsx"))
    payload = seen[0]["json"]["payload"]
    assert seen[0]["json"]["capability"] == "fs.write"
    assert payload["encoding"] == "base64" and base64.b64decode(payload["content"]) == b"\x00\x01binary"
    assert payload["overwrite"] is False
    assert out["bytes"] == 8


def test_write_from_outside_the_workspace_is_refused(connected, tmp_path):
    respond, seen = connected
    out = run(lc.LocalFilesTool(tmp_path).execute("write", path="C:/x", from_workspace="/etc/passwd"))
    assert out["ok"] is False and not seen


def test_terminal_clamps_the_timeout(connected):
    respond, seen = connected
    respond(_Res(200, {"ok": True, "result": {"exitCode": 0, "stdout": "hi"}}))
    run(lc.LocalTerminalTool().execute("echo hi", timeout_s=9999))
    assert seen[0]["json"]["payload"]["timeoutMs"] == 100_000


def test_screenshot_lands_in_the_workspace_for_read_image(connected, tmp_path):
    respond, _ = connected
    jpeg = b"\xff\xd8\xff fake jpeg"
    respond(_Res(200, {"ok": True, "result": {
        "dataUrl": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode(), "width": 1600, "height": 900,
    }}))
    out = run(lc.LocalDesktopTool(tmp_path).execute("screenshot"))
    assert Path(out["saved_to"]).read_bytes() == jpeg
    assert "read_image" in out["next"]


def test_desktop_actions_map_to_capabilities(connected, tmp_path):
    respond, seen = connected
    respond(*[_Res(200, {"ok": True, "result": {}}) for _ in range(3)])
    tool = lc.LocalDesktopTool(tmp_path)
    run(tool.execute("click", x=10, y=20))
    run(tool.execute("key", keys="^s"))
    run(tool.execute("ui_tree"))
    assert [c["json"]["capability"] for c in seen] == ["desktop.click", "desktop.key", "desktop.ui_tree"]
    assert seen[0]["json"]["payload"]["x"] == 10


# ── phase 6: handing the local part off ──────────────────────────────────────

def test_queue_for_my_computer_posts_with_the_cycle_token(monkeypatch):
    from nanoagent.agent.tools import queue_for_my_computer as q

    monkeypatch.setenv("AGENT_ID", "a1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setenv("NanoCrew_HOST", "http://orch")
    seen: list = []

    class R:
        status_code = 201
        content = b"{}"

        def json(self):
            return {"queued": True, "id": "f1", "connected": False}

    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, headers=None, json=None, **k):
            seen.append((url, headers, json))
            return R()

    monkeypatch.setattr(q.httpx, "AsyncClient", C)
    out = json.loads(asyncio.run(q.QueueForMyComputerTool().execute(task="Send the 8 approved notes", reason="laptop shut")))
    assert out["queued"] is True
    url, headers, body = seen[0]
    assert url == "http://orch/api/agents/a1/self/local-followups"
    assert headers == {"Authorization": "Bearer tok"}
    assert body == {"task": "Send the 8 approved notes", "reason": "laptop shut"}


def test_queue_for_my_computer_outside_a_run(monkeypatch):
    from nanoagent.agent.tools import queue_for_my_computer as q

    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    out = json.loads(asyncio.run(q.QueueForMyComputerTool().execute(task="x")))
    assert out["queued"] is False
