"""Tests for the phase-5 gap-closing pass (stage43 doc 03): credential_inject.py,
action_log.py, escalation_notifier.py, local_ocr.py, session_keepalive.py — found
missing during the pre-deletion coverage check of the raw TS staging copy, and
closed before it was deleted. Same discipline as every other phase: prove the real
wiring works, not just that the function exists.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from nanoagent.agent.effector.action_log import append_action_log, build_log_entry, classify_step, read_action_log
from nanoagent.agent.effector.capabilities.local_ocr import parse_document_offline
from nanoagent.agent.effector.credential_inject import has_credential_ref, resolve_credential_ref
from nanoagent.agent.effector.escalation import request_approval
from nanoagent.agent.effector.escalation_notifier import EscalationAlert, dispatch_escalation_alert
from nanoagent.agent.effector.executor import ExecutorOptions, execute_step
from nanoagent.agent.effector.types import Step, StepResult

from test_effector_phase0 import FakeKeyboard, FakeLocator, FakeMouse


# ─── credential_inject ────────────────────────────────────────────────────────

def test_has_credential_ref():
    assert has_credential_ref("github:password") is True
    assert has_credential_ref("plain text, no colon") is False
    assert has_credential_ref(None) is False


@pytest.mark.asyncio
async def test_resolve_credential_ref_returns_none_outside_a_real_cycle(monkeypatch):
    """No AGENT_ID/NANOCREW_CYCLE_TOKEN in env (as in any dev/test run) — must fail
    closed (None), never raise, matching get_credential.py's own contract."""
    monkeypatch.delenv("AGENT_ID", raising=False)
    monkeypatch.delenv("NANOCREW_CYCLE_TOKEN", raising=False)
    result = await resolve_credential_ref("github:password")
    assert result is None


@pytest.mark.asyncio
async def test_resolve_credential_ref_hits_the_same_vault_route_get_credential_uses(monkeypatch):
    """Confirms the URL shape matches the real orchestrator route
    (agents.ts: credentialManager.get(req.params.service), literal lookup — so
    'browser:github' as the :service segment IS the TS original's 'browser:${service}'
    key convention, not a guess)."""
    monkeypatch.setenv("AGENT_ID", "agent-1")
    monkeypatch.setenv("NANOCREW_CYCLE_TOKEN", "tok-1")
    monkeypatch.setenv("NanoCrew_HOST", "http://host.docker.internal:3002")

    captured = {}

    class FakeResponse:
        status_code = 200
        def json(self):
            return {"password": "hunter2"}

    class FakeAsyncClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            pass
        async def get(self, url, headers=None, timeout=None):
            captured["url"] = url
            captured["headers"] = headers
            return FakeResponse()

    with patch("httpx.AsyncClient", FakeAsyncClient):
        value = await resolve_credential_ref("github:password")

    assert value == "hunter2"
    assert captured["url"] == "http://host.docker.internal:3002/api/agents/agent-1/credentials/browser:github"
    assert captured["headers"]["Authorization"] == "Bearer tok-1"


@pytest.mark.asyncio
async def test_executor_type_action_injects_a_credential_and_never_leaks_it_to_the_caller():
    class FakePage:
        def __init__(self):
            self.mouse = FakeMouse(self)
            self.keyboard = FakeKeyboard(self)
            self.actions = []
            self.url = "https://example.test"

        def locator(self, selector):
            return FakeLocator(self, selector, matched=(selector == "#password"))

    page = FakePage()
    step = Step(step=1, action="type", target="#password", credential_ref="github:password")
    options = ExecutorOptions(require_approval=False, use_human_cadence=False)

    async def fake_resolve(ref):
        assert ref == "github:password"
        return "hunter2"

    with patch("nanoagent.agent.effector.credential_inject.resolve_credential_ref", fake_resolve):
        result = await execute_step(step, page, options)

    assert result.status == "success"
    assert ("fill", "#password", "hunter2") in page.actions
    # The result payload itself never carries the plaintext.
    assert "hunter2" not in json.dumps(result.__dict__, default=str)


@pytest.mark.asyncio
async def test_executor_type_action_fails_clearly_when_the_credential_is_missing():
    class FakePage:
        url = "https://example.test"

        def locator(self, selector):
            return FakeLocator(self, selector, matched=True)

    step = Step(step=1, action="type", target="#password", credential_ref="github:password")
    options = ExecutorOptions(require_approval=False, use_human_cadence=False)

    async def fake_resolve(ref):
        return None

    with patch("nanoagent.agent.effector.credential_inject.resolve_credential_ref", fake_resolve):
        result = await execute_step(step, FakePage(), options)

    assert result.status == "failed"
    assert "Credential not found" in result.error


# ─── action_log ───────────────────────────────────────────────────────────────

def test_classify_step_flags_dangerous_click_targets_as_external():
    assert classify_step(Step(step=1, action="click", target="Submit payment")) == "external"
    assert classify_step(Step(step=1, action="click", target="Next page")) == "write"
    assert classify_step(Step(step=1, action="navigate", url="https://x.test")) == "read"


def test_build_log_entry_redacts_credential_text():
    step = Step(step=1, action="type", target="#password", text="hunter2", credential_ref="github:password")
    result = StepResult(step=1, status="success")
    entry = build_log_entry(step, result, run_id="r1", agent_id="a1")
    assert entry.action["text"] == "[CREDENTIAL_REDACTED]"


def test_action_log_round_trips_through_the_workspace(tmp_path: Path):
    step = Step(step=1, action="click", target="#next-page")  # not "#submit" — that IS a danger keyword
    result = StepResult(step=1, status="success")
    entry = build_log_entry(step, result, run_id="run-1", agent_id="agent-1")

    append_action_log(tmp_path, "run-1", entry)
    append_action_log(tmp_path, "run-1", entry)

    entries = read_action_log(tmp_path, "run-1")
    assert len(entries) == 2
    assert entries[0]["classification"] == "write"

    log_file = tmp_path / ".effector" / "logs" / "run-1.ndjson"
    assert log_file.exists()


@pytest.mark.asyncio
async def test_react_loop_actually_writes_the_action_log_not_just_defines_it(tmp_path: Path):
    """The reachability check that matters: a real run_react_loop call must
    produce a real NDJSON file, not just have action_log.py sitting unwired."""
    from test_effector_phase0 import FakeSession, ScriptedProvider
    from nanoagent.agent.tools.effector import EffectorTool

    script = [
        {"thought": "click it", "action": "click", "target": "@e2"},
        {"thought": "done", "action": "done"},
    ]
    provider = ScriptedProvider(script)
    tool = EffectorTool(require_approval=False, workspace=tmp_path, provider=provider, model="fake/primary",
                         decision_provider=provider, decision_model="fake/decision",
                         use_human_cadence=False)

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", FakeSession):
        raw = await tool.execute(goal="click the submit button")
    result = json.loads(raw)

    log_dir = tmp_path / ".effector" / "logs"
    assert log_dir.exists()
    log_files = list(log_dir.glob(f"{result['run_id']}.ndjson"))
    assert len(log_files) == 1
    lines = log_files[0].read_text().splitlines()
    assert len(lines) == 1  # one non-"done" action logged
    assert json.loads(lines[0])["action"]["type"] == "click"


# ─── escalation_notifier ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_dispatch_escalation_alert_falls_back_to_console_with_no_webhook(monkeypatch):
    monkeypatch.delenv("ESCALATION_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("SLACK_WEBHOOK_URL", raising=False)
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)

    alert = EscalationAlert(run_id="r1", domain="example.test", reason="CAPTCHA", details="stuck")
    result = await dispatch_escalation_alert(alert)

    assert result.dispatched is True
    assert result.channel == "console"


@pytest.mark.asyncio
async def test_dispatch_escalation_alert_posts_to_a_configured_webhook():
    posted = {}

    class FakeResponse:
        status_code = 200

    class FakeAsyncClient:
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            pass
        async def post(self, url, json=None, timeout=None):
            posted["url"] = url
            posted["payload"] = json
            return FakeResponse()

    alert = EscalationAlert(run_id="r1", domain="example.test", reason="2FA_REQUIRED", details="needs a code")

    with patch("httpx.AsyncClient", FakeAsyncClient):
        result = await dispatch_escalation_alert(alert, custom_webhook_url="https://hooks.example/x")

    assert result.dispatched is True
    assert result.channel == "webhook"
    assert posted["url"] == "https://hooks.example/x"
    assert posted["payload"]["reason"] == "2FA_REQUIRED"


@pytest.mark.asyncio
async def test_request_approval_denies_and_notifies():
    """The actual safety property: a dangerous step is denied AND a human is
    actually notified (not just a log line)."""
    class FakePage:
        url = "https://checkout.example/pay"

    notified = {}

    async def fake_dispatch(alert, custom_webhook_url=None):
        notified["alert"] = alert
        from nanoagent.agent.effector.escalation_notifier import EscalationNotificationResult
        return EscalationNotificationResult(dispatched=True, channel="console")

    step = Step(step=1, action="click", target="Confirm payment", is_dangerous=True)

    with patch("nanoagent.agent.effector.escalation_notifier.dispatch_escalation_alert", fake_dispatch):
        decision = await request_approval(step, agent_id="a1", run_id="r1", page=FakePage())

    # The safety property is that it BLOCKS — assert that, not the spelling of the
    # label. Stage 49 phase 1 split the old blanket "denied" into four outcomes so the
    # ledger stops claiming a human refused when nobody was ever asked; with no cycle
    # token there is no gate to reach, which is `unavailable`, and it blocks all the same.
    from nanoagent.agent.effector.escalation import APPROVAL_UNAVAILABLE, is_approved
    assert not is_approved(decision)
    assert decision == APPROVAL_UNAVAILABLE
    assert notified["alert"].domain == "checkout.example"
    assert notified["alert"].reason == "CRITICAL_ACTION"


# ─── local_ocr ────────────────────────────────────────────────────────────────

def test_parse_document_offline_flags_a_mismatched_invoice():
    # Deliberately "Total:" not "Total Due:" — the total-amount regex (ported
    # faithfully from the TS original) only recognizes bare "total"/"balance due"/
    # "amount due", not "total due" as a combined phrase. A real, pre-existing gap
    # in the inherited regex, not something to silently change here — see
    # financial_extractor.py's _TOTAL_RE.
    text = "Invoice #INV-9\nSubtotal: $100.00\nTax: $8.00\nTotal: $999.00\nDate: 2026-01-01"
    doc = parse_document_offline(text)
    assert doc.doc_type == "invoice"
    assert doc.is_compliant is False
    assert any("discrepancy" in w.lower() for w in doc.warnings)
    assert doc.fields["invoice_number"] == "INV-9"


def test_parse_document_offline_reconciliation_always_present_even_with_nothing_found():
    # Another inherited quirk (present identically in the TS original, not
    # introduced here): parse_invoice_text_with_invariants never returns None —
    # only an exception would make doc_type "generic", and a plain no-match text
    # doesn't raise. So doc_type is "invoice" even for non-financial text; what's
    # actually meaningful here is that nothing gets falsely flagged as unbalanced.
    doc = parse_document_offline("Just a random memo with no numbers.")
    assert doc.reconciliation is not None
    assert doc.is_compliant is True
    assert doc.warnings == []
