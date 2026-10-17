"""The blocking approval prompter.

Every failure path here must resolve to "no". A gate that fails open is worse
than no gate, because it also removes the operator's suspicion that they need one.
"""

import json

import pytest

from nanoagent.agent.permissions import HostApprovalPrompter


class _Response:
    def __init__(self, status_code: int, payload=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}

    @property
    def is_success(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self):
        return self._payload


class _FakeClient:
    """Scripts the poll sequence and records what the prompter sent."""

    def __init__(self, create=None, polls=None, raise_on_post=False):
        self.create = create if create is not None else _Response(201, {"id": "ap_1"})
        self.polls = list(polls or [])
        self.raise_on_post = raise_on_post
        self.posted: list[tuple[str, dict]] = []
        self.polled: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        if self.raise_on_post:
            raise RuntimeError("connection refused")
        self.posted.append((url, json or {}))
        if url.endswith("/expire"):
            return _Response(200, {"status": "expired"})
        return self.create

    async def get(self, url):
        self.polled.append(url)
        if self.polls:
            return self.polls.pop(0)
        return _Response(200, {"status": "pending"})


def _prompter(client: _FakeClient, wait_seconds: float = 10.0) -> HostApprovalPrompter:
    return HostApprovalPrompter(
        agent_id="agent_1",
        host="http://host.docker.internal:3002",
        cycle_id="cycle_1",
        wait_seconds=wait_seconds,
        http_client_factory=lambda: client,
    )


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch):
    monkeypatch.setattr(HostApprovalPrompter, "POLL_INTERVAL_SECONDS", 0.001)


@pytest.mark.asyncio
async def test_approval_allows_the_call():
    client = _FakeClient(polls=[_Response(200, {"status": "pending"}), _Response(200, {"status": "approved"})])
    assert await _prompter(client).ask("gmail_send", {"to": "a@b.test"}, "sends mail") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["denied", "expired"])
async def test_refusal_blocks_the_call(status):
    client = _FakeClient(polls=[_Response(200, {"status": status})])
    assert await _prompter(client).ask("gmail_send", {}, "sends mail") is False


@pytest.mark.asyncio
async def test_timeout_denies_and_closes_the_request():
    """An unanswered request must stop blocking and stop looking live in the inbox."""
    client = _FakeClient()  # every poll stays pending
    result = await _prompter(client, wait_seconds=0.05).ask("gmail_send", {}, "sends mail")
    assert result is False
    assert any(url.endswith("/expire") for url, _ in client.posted)


@pytest.mark.asyncio
async def test_unreachable_orchestrator_denies():
    assert await _prompter(_FakeClient(raise_on_post=True)).ask("gmail_send", {}, "x") is False


@pytest.mark.asyncio
async def test_rejected_creation_denies():
    assert await _prompter(_FakeClient(create=_Response(500, {}))).ask("gmail_send", {}, "x") is False


@pytest.mark.asyncio
async def test_creation_without_an_id_denies():
    assert await _prompter(_FakeClient(create=_Response(201, {}))).ask("gmail_send", {}, "x") is False


@pytest.mark.asyncio
async def test_transient_poll_failures_do_not_decide_anything():
    client = _FakeClient(polls=[_Response(503, {}), _Response(200, {"status": "approved"})])
    assert await _prompter(client).ask("gmail_send", {}, "x") is True


@pytest.mark.asyncio
async def test_request_carries_the_context_a_human_needs():
    client = _FakeClient(polls=[_Response(200, {"status": "approved"})])
    await _prompter(client).ask("gmail_send", {"to": "client@corp.test"}, "gmail_send acts outside the workspace")
    url, body = client.posted[0]
    assert url == "http://host.docker.internal:3002/api/agents/agent_1/tool-approvals"
    assert body["tool"] == "gmail_send"
    assert body["reason"] == "gmail_send acts outside the workspace"
    assert body["cycle_id"] == "cycle_1"
    assert "client@corp.test" in body["args_preview"]


@pytest.mark.asyncio
async def test_argument_preview_is_truncated():
    """Full arguments can carry file contents and secrets; the row stores a preview."""
    client = _FakeClient(polls=[_Response(200, {"status": "approved"})])
    await _prompter(client).ask("http_request", {"body": "x" * 5000}, "reason")
    _, body = client.posted[0]
    assert len(body["args_preview"]) < 400
    assert "chars)" in body["args_preview"]


@pytest.mark.asyncio
async def test_unserialisable_arguments_still_produce_a_preview():
    client = _FakeClient(polls=[_Response(200, {"status": "approved"})])
    await _prompter(client).ask("http_request", {"session": object()}, "reason")
    _, body = client.posted[0]
    assert body["args_preview"]


@pytest.mark.asyncio
async def test_host_trailing_slash_does_not_double_up():
    client = _FakeClient(polls=[_Response(200, {"status": "approved"})])
    prompter = HostApprovalPrompter(
        agent_id="agent_1",
        host="http://host.docker.internal:3002/",
        wait_seconds=5.0,
        http_client_factory=lambda: client,
    )
    await prompter.ask("gmail_send", {}, "x")
    url, _ = client.posted[0]
    assert "//api" not in url.replace("http://", "")
    assert json.loads(json.dumps(url))  # url is a plain string, not a path object
