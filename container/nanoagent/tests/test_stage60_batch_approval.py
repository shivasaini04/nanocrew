"""Stage 60 phase 3 — approve a list of sends once, instead of every send."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from nanoagent.agent.effector import batch_approval
from nanoagent.agent.tools import request_batch_approval as rba
from nanoagent.agent.tools.effector import _MAX_IDENTITY_ACTIONS, EffectorTool


@pytest.fixture(autouse=True)
def _clean():
    batch_approval.clear()
    yield
    batch_approval.clear()


def test_site_of():
    assert batch_approval.site_of("https://www.linkedin.com/in/someone") == "linkedin.com"
    assert batch_approval.site_of("linkedin.com") == "linkedin.com"
    assert batch_approval.site_of("") == ""


def test_a_grant_is_used_once_per_send_and_runs_out():
    batch_approval.grant("linkedin.com", "b1", 2)
    assert batch_approval.consume("https://www.linkedin.com/in/a", "Send invitation") is not None
    assert batch_approval.consume("https://linkedin.com/in/b", "Send") is not None
    assert batch_approval.consume("https://linkedin.com/in/c", "Send") is None


def test_a_grant_never_covers_money_or_destruction():
    batch_approval.grant("linkedin.com", "b1", 5)
    for words in ("Pay now", "Delete conversation", "Remove connection", "Cancel subscription", "Checkout"):
        assert batch_approval.consume("https://linkedin.com", words) is None
    assert batch_approval.active("linkedin.com").remaining == 5


def test_a_grant_is_per_site():
    batch_approval.grant("linkedin.com", "b1", 3)
    assert batch_approval.consume("https://x.com/home", "Send") is None


def test_a_grant_expires():
    g = batch_approval.grant("linkedin.com", "b1", 3)
    g.granted_at -= batch_approval.GRANT_TTL_S + 1
    assert batch_approval.active("linkedin.com") is None
    assert batch_approval.total_remaining() == 0


def test_render_shows_every_recipient_and_exact_text():
    md = rba.render("linkedin.com", "connection request", [{"to": "Priya | CTO", "text": "Hi Priya,\nsaw your post"}])
    assert "Priya / CTO" in md and "Hi Priya, saw your post" in md
    assert "Send 1 × connection request on linkedin.com" in md


# ── the tool's round trip ────────────────────────────────────────────────────

class _Res:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.is_success = 200 <= status < 300
        self.text = json.dumps(body)

    def json(self):
        return self._body


def _client(post: _Res, gets: list, seen: dict):
    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **k):
            seen["post"] = json
            return post

        async def get(self, url, **k):
            return gets.pop(0) if gets else _Res(200, {"status": "pending"})

    return C


def _run(**kw):
    kw.setdefault("site", "linkedin.com")
    kw.setdefault("action", "connection request with note")
    kw.setdefault("items", [{"to": "A", "text": "hi"}, {"to": "B", "text": "hello"}])
    return json.loads(asyncio.run(rba.RequestBatchApprovalTool().execute(**kw)))


@pytest.fixture
def env(monkeypatch):
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setattr(rba, "_POLL_INTERVAL_S", 0)

    async def never(*_a, **_k):
        return False
    from nanoagent.agent.tools import clarify as clarify_mod
    monkeypatch.setattr(rba, "stop_requested", never)
    monkeypatch.setattr(clarify_mod, "stop_requested", never)
    return monkeypatch


def test_approval_records_a_grant_for_exactly_the_list(env):
    seen: dict = {}
    env.setattr(rba.httpx, "AsyncClient", _client(
        _Res(201, {"id": "c1"}), [_Res(200, {"status": "responded", "user_reply": "approve"})], seen))
    out = _run()
    assert out["approved"] is True and out["approved_count"] == 2
    assert batch_approval.active("linkedin.com").remaining == 2
    payload = json.loads(seen["post"]["action_payload"])
    assert seen["post"]["action_type"] == "batch_send_live"
    assert payload["site"] == "linkedin.com" and len(payload["items"]) == 2


def test_rejection_grants_nothing(env):
    env.setattr(rba.httpx, "AsyncClient", _client(
        _Res(201, {"id": "c1"}), [_Res(200, {"status": "responded", "user_reply": "reject — change the text"})], {}))
    out = _run()
    assert out["approved"] is False and "change the text" in out["reply"]
    assert batch_approval.active("linkedin.com") is None


def test_the_daily_limit_comes_back_with_the_number_left(env):
    env.setattr(rba.httpx, "AsyncClient", _client(_Res(422, {"error": "Daily limit", "remaining": 1}), [], {}))
    out = _run()
    assert out["approved"] is False and out["limit_reached"] is True and out["remaining"] == 1
    assert batch_approval.active("linkedin.com") is None


# ── effector's budget on the identity lane ───────────────────────────────────

class _Session:
    def __init__(self, workspace, **kwargs):
        self._remote = kwargs.get("allow_remote") is not False
        self.page = object()
        self.context = None
        self.capabilities = None
        self.engine = "chromium"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False


def _budget(monkeypatch) -> int:
    import nanoagent.agent.effector.remote_page as rp

    monkeypatch.setattr(rp.RemoteConfig, "from_env", classmethod(lambda cls: object()))
    seen: dict = {}

    async def capture(*_a, **kw):
        seen.update(kw)
        raise RuntimeError("stop")

    tool = EffectorTool(Path("/tmp"), provider=object(), model="m")
    with patch("nanoagent.agent.effector.browser_session.EffectorSession", _Session):
        with patch("nanoagent.agent.effector.react_loop.run_react_loop", capture):
            asyncio.run(tool.execute(goal="send", identity="me", max_external_actions=200))
    return seen["max_external_actions"]


def test_without_a_batch_the_identity_cap_stays(monkeypatch):
    assert _budget(monkeypatch) == _MAX_IDENTITY_ACTIONS


def test_an_approved_batch_becomes_the_budget(monkeypatch):
    batch_approval.grant("linkedin.com", "b1", 10)
    assert _budget(monkeypatch) == 20


def test_the_loop_wires_the_grant_and_stops_counting_reads():
    import nanoagent.agent.effector.react_loop as rl

    src = Path(rl.__file__).read_text(encoding="utf-8")
    assert 'step.action == "navigate" and not _is_remote_lane(page)' in src
    assert "batch_approval.consume(page.url" in src
    assert "batch_approval.prompt_note()" in src


def test_the_wait_polls_the_cycle_token_route(env, monkeypatch):
    """Live test 2026-09-17: polling the session-auth route got a 401 on every poll, so
    no answer ever reached a waiting run. The poll must use /self/ with the cycle token."""
    from nanoagent.agent.tools import clarify as clarify_mod

    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok-123")
    monkeypatch.setenv("NanoCrew_HOST", "http://orch")
    gets: list = []

    class C:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def post(self, url, json=None, **k):
            return _Res(201, {"id": "c9"})

        async def get(self, url, headers=None, **k):
            gets.append((url, headers))
            return _Res(200, {"status": "responded", "user_reply": "approve"})

    env.setattr(rba.httpx, "AsyncClient", C)
    _run()
    monkeypatch.setattr(clarify_mod.httpx, "AsyncClient", C)
    monkeypatch.setattr(clarify_mod, "_POLL_INTERVAL_S", 0)
    asyncio.run(clarify_mod.ClarifyTool().execute(question="Which?"))

    assert len(gets) == 2
    for url, headers in gets:
        assert url == "http://orch/api/agents/agent-1/self/checkins/c9"
        assert headers == {"Authorization": "Bearer tok-123"}



def test_stop_ends_a_batch_wait(env):
    async def stopped(*_a, **_k):
        return True
    env.setattr(rba, "stop_requested", stopped)
    env.setattr(rba.httpx, "AsyncClient", _client(_Res(201, {"id": "c1"}), [], {}))
    out = _run()
    assert out["stopped"] is True and out["approved"] is False
    assert batch_approval.active("linkedin.com") is None
