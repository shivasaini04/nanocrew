"""get_credential never hands a secret to the model (stage 64 phase 2).

It used to return the vault's raw fields as the tool result — the key landed in the model's
context and in cycle_steps. It now says which fields exist, never their values.
"""

import asyncio
import json

import httpx

from nanoagent.agent.tools.get_credential import GetCredentialTool


class _Resp:
    status_code = 200

    def json(self):
        return {"api_key": "sk-live-SECRET", "email": "", "client_secret": "cs-SECRET"}


class _Client:
    async def get(self, *a, **kw):
        return _Resp()


def test_values_never_come_back(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "a1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok")
    monkeypatch.setattr(httpx, "AsyncClient", lambda *a, **kw: _Client())
    out = asyncio.run(GetCredentialTool().execute(service="apollo"))
    assert "SECRET" not in out
    data = json.loads(out)
    assert data["connected"] is True
    assert data["fields"] == {"api_key": "stored (hidden)", "email": "empty", "client_secret": "stored (hidden)"}
