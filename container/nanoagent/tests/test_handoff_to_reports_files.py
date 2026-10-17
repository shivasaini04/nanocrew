"""handoff_to must say which files reached the recipient.

2026-09-13: Crawler handed Finder its 21-company list as a path under a key the orchestrator
did not read. The tool replied "delivered: true" and nothing was attached.
"""

import asyncio
import json

from nanoagent.agent.tools import handoff_to as ht


class _Resp:
    def __init__(self, body, status=201):
        self._body, self.status_code = body, status

    def json(self):
        return self._body


def _run(monkeypatch, stored_payload):
    body = {"id": "h1", "status": "pending", "payload": json.dumps(stored_payload)}

    class _Client:
        async def post(self, url, json=None, timeout=None):
            return _Resp(body)

    monkeypatch.setenv("AGENT_ID", "sender")
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: _Client())
    return json.loads(asyncio.run(ht.HandoffToTool().execute(to_agent_id="Finder", type="task", payload={})))


def test_lists_the_files_that_arrived(monkeypatch):
    out = _run(monkeypatch, {"file": "inbox/list.md", "_deliveredFiles": ["list.md"]})
    assert out["files_delivered"] == ["inbox/list.md"]
    assert "files_not_found" not in out


def test_warns_when_a_named_file_did_not_arrive(monkeypatch):
    out = _run(monkeypatch, {"report": "/workspace/group/workspace/tracked/gone.md",
                             "_undeliveredFiles": ["/workspace/group/workspace/tracked/gone.md"]})
    assert out["files_delivered"] == []
    assert out["files_not_found"] == ["/workspace/group/workspace/tracked/gone.md"]
    assert "did NOT get them" in out["files_warning"]


def test_the_description_says_how_to_attach_a_file():
    d = ht.HandoffToTool().description
    assert "payload.file" in d and "cannot read your workspace" in d
