"""R3 (manifest) + R4 (lifecycle interception).

R3: an optional engine may degrade, but never silently. The audit found capabilities
failing behind clean try/except and a logger.debug line — good engineering in isolation,
bad system behaviour in aggregate, because an operator reading "stealth=True" believed
they had protection they did not have. Degradation now reaches the caller.

R4: CDPTargetInterceptor was 129 lines that nothing constructed. `context.on("page")`
fires only AFTER a popup exists and has begun executing, so a detection script in its
first inline <script> beats every Python handler. Target.setAutoAttach with
waitForDebuggerOnStart is the only thing that closes that race.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from nanoagent.agent.effector.capability_manifest import CapabilityManifest
from nanoagent.agent.effector.lifecycle.cdp_target_interceptor import CDPTargetInterceptor


# ------------------------------------------------------------------------- manifest


def test_requested_but_unavailable_is_a_degradation():
    m = CapabilityManifest()
    m.degrade("native engine unavailable — no binary", requested=True)
    assert m.degraded is True
    assert any("native engine" in d for d in m.degradations)


def test_not_requested_is_recorded_but_is_not_a_degradation():
    """`auto` on an image without the binary is a supported configuration.

    Recording it as a fault would put a permanent warning on every session, which is
    how real warnings get ignored.
    """
    m = CapabilityManifest()
    m.degrade("no uTLS virtualizer available", requested=False)
    assert m.degraded is False
    assert m.degradations == []


def test_manifest_is_json_serializable():
    """It goes straight into the tool's json.dumps."""
    json.dumps(CapabilityManifest().to_dict())


def test_manifest_reports_every_capability_the_audit_cared_about():
    d = CapabilityManifest().to_dict()
    for key in (
        "engine", "engine_requested", "engine_reason", "tls_virtualizer",
        "stealth", "network_shield", "isolated_worlds", "lifecycle_interception",
        "proxy", "degradations",
    ):
        assert key in d, f"manifest lost the {key!r} field"


def test_log_summary_does_not_raise_on_an_empty_manifest():
    CapabilityManifest().log_summary()


# --------------------------------------------------------------- interceptor itself


class _FakeCDP:
    """Records CDP traffic; optionally fails a named command."""

    def __init__(self, fail_on: str | None = None):
        self.sent: list[tuple[str, dict, dict]] = []
        self.handlers: dict = {}
        self._fail_on = fail_on

    def on(self, event, handler):
        self.handlers[event] = handler

    async def send(self, method, params=None, **kwargs):
        if self._fail_on and method == self._fail_on:
            raise RuntimeError(f"simulated {method} failure")
        self.sent.append((method, params or {}, kwargs))
        return {}

    def methods(self) -> list[str]:
        return [m for m, _, _ in self.sent]


@pytest.mark.asyncio
async def test_auto_attach_never_pauses_targets():
    """waitForDebuggerOnStart MUST stay false — it hung every navigation.

    Measured live 2026-08-31. Chromium pauses each new target and will not run until
    Runtime.runIfWaitingForDebugger reaches that target's OWN session, which a
    Playwright browser-level CDPSession cannot send. The pause was therefore permanent
    and page.goto() timed out on every URL, silently breaking ALL browsing under
    stealth=True.

    The earlier version of this test asserted True and so encoded the bug. It passed
    the whole time, because the probes around it used about:blank and data: URLs driven
    through page.evaluate — which never need the target to be released.
    """
    cdp = _FakeCDP()
    ok = await CDPTargetInterceptor(init_script="/*x*/").enable_auto_attach(cdp)

    assert ok is True
    method, params, _ = next(s for s in cdp.sent if s[0] == "Target.setAutoAttach")
    assert params["autoAttach"] is True
    assert params["flatten"] is True
    assert params["waitForDebuggerOnStart"] is False, (
        "targets are being paused again — every page.goto() will hang, because nothing "
        "in this stack can release them"
    )


@pytest.mark.asyncio
async def test_attached_target_is_patched_then_resumed_in_that_order():
    """Patching after the resume would defeat the entire mechanism."""
    cdp = _FakeCDP()
    interceptor = CDPTargetInterceptor(
        init_script="window.__patched = 1;",
        user_agent_override={"userAgent": "UA"},
    )
    await interceptor._on_target_attached(
        cdp,
        {"targetInfo": {"targetId": "T1", "type": "page"}, "sessionId": "S1"},
    )

    methods = cdp.methods()
    assert "Page.addScriptToEvaluateOnNewDocument" in methods
    assert "Runtime.runIfWaitingForDebugger" in methods
    assert methods.index("Page.addScriptToEvaluateOnNewDocument") < methods.index(
        "Runtime.runIfWaitingForDebugger"
    ), "the resume is sent before the patch attempt"


@pytest.mark.asyncio
async def test_interceptor_never_passes_sessionId_to_playwright():
    """Playwright's CDPSession.send(method, params) accepts NO sessionId.

    Corrects an earlier version of this test, which asserted the opposite and so
    encoded the bug. Measured on a live browser 2026-08-31: passing the kwarg raised
    `CDPSession.send() got an unexpected keyword argument 'sessionId'` on EVERY
    attached target, which the handlers logged as "non-fatal" — so every popup patch
    silently failed and every target failed to resume, while the capability manifest
    still reported lifecycle_interception=true.

    Playwright owns one session per target and flattens routing itself, so the calls
    must be positional-only.
    """
    cdp = _FakeCDP()
    interceptor = CDPTargetInterceptor(
        init_script="window.__patched = 1;", user_agent_override={"userAgent": "UA"},
    )

    await interceptor._on_target_attached(
        cdp, {"targetInfo": {"targetId": "T1", "type": "page"}, "sessionId": "S1"},
    )

    assert cdp.sent, "no CDP commands were issued"
    for method, _params, kwargs in cdp.sent:
        assert "sessionId" not in kwargs, (
            f"{method} was sent with a sessionId kwarg — Playwright raises TypeError, "
            f"which the non-fatal handlers swallow, leaving the target unpatched"
        )
    assert "Runtime.runIfWaitingForDebugger" in cdp.methods()


@pytest.mark.asyncio
async def test_target_is_resumed_even_when_every_patch_step_fails():
    cdp = _FakeCDP(fail_on="Network.setUserAgentOverride")
    interceptor = CDPTargetInterceptor(user_agent_override={"userAgent": "UA"})

    await interceptor._on_target_attached(
        cdp, {"targetInfo": {"targetId": "T2", "type": "page"}, "sessionId": "S2"},
    )

    assert "Runtime.runIfWaitingForDebugger" in cdp.methods()


@pytest.mark.asyncio
async def test_detach_all_disables_auto_attach():
    cdp = _FakeCDP()
    interceptor = CDPTargetInterceptor()
    await interceptor.enable_auto_attach(cdp)
    await interceptor.detach_all(cdp)

    assert interceptor.is_active is False
    last = [s for s in cdp.sent if s[0] == "Target.setAutoAttach"][-1]
    assert last[1]["autoAttach"] is False


@pytest.mark.asyncio
async def test_arming_failure_is_reported_not_raised():
    """A browser build without Target.setAutoAttach must degrade, not crash the run."""
    assert await CDPTargetInterceptor().enable_auto_attach(
        _FakeCDP(fail_on="Target.setAutoAttach")
    ) is False


# ------------------------------------------------------- reachability (R3 + R4)


def test_browser_session_constructs_the_interceptor():
    """R4 reachability guard: the class must be referenced from the session.

    It was defined, exported and unit-tested for a full day while nothing built one.
    """
    source = (
        Path(__file__).resolve().parents[1]
        / "nanoagent" / "agent" / "effector" / "browser_session.py"
    ).read_text(encoding="utf-8")

    assert "CDPTargetInterceptor(" in source, (
        "browser_session no longer constructs CDPTargetInterceptor — popups lose "
        "pre-script stealth patching and the first-inline-script race reopens"
    )
    assert "enable_auto_attach" in source
    assert "detach_all" in source, "interceptor is armed but never disarmed"


def test_interceptor_is_armed_before_the_first_page_is_opened():
    """Ordering is the whole point: arming after new_page() reopens the race."""
    source = (
        Path(__file__).resolve().parents[1]
        / "nanoagent" / "agent" / "effector" / "browser_session.py"
    ).read_text(encoding="utf-8")

    arm_at = source.index("enable_auto_attach")
    page_at = source.index("self.page = await self._context.new_page()")
    assert arm_at < page_at, "auto-attach is armed after the first page already exists"


def test_popup_shares_the_openers_user_agent_payload():
    """A popup whose client hints disagree with its opener is a louder tell than
    either alone — so both must come from one builder, not two copies."""
    source = (
        Path(__file__).resolve().parents[1]
        / "nanoagent" / "agent" / "effector" / "browser_session.py"
    ).read_text(encoding="utf-8")

    assert source.count("def _user_agent_override") == 1
    assert source.count("_user_agent_override()") >= 2, (
        "the interceptor and the main page must share one UA payload builder"
    )


def test_no_self_assessed_rating_in_any_log_line():
    """R7 rule, enforced here: a log line must not assert a security rating.

    browser_session logged 'Tier: 9.8+' on every native-engine start — an unmeasured
    self-assessment that read as fact in every trace.
    """
    effector_dir = (
        Path(__file__).resolve().parents[1] / "nanoagent" / "agent" / "effector"
    )
    offenders = []
    for py in effector_dir.rglob("*.py"):
        if "engine" in py.parts:          # the vendored fork is not ours to restyle
            continue
        text = py.read_text(encoding="utf-8", errors="ignore")
        if "Tier: 9" in text or "Tier:9" in text:
            offenders.append(py.name)
    assert not offenders, f"self-assessed rating in log/source: {offenders}"


@pytest.mark.asyncio
async def test_dispatcher_returns_the_capability_manifest(tmp_path: Path):
    """R3 reachability guard: capabilities must reach the caller's JSON."""
    from nanoagent.agent.tools.effector import EffectorTool

    from test_effector_phase0 import FakeSession, ScriptedProvider

    class _ManifestSession(FakeSession):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self.capabilities = CapabilityManifest(
                engine="chromium", stealth=True, isolated_worlds=True,
                lifecycle_interception=True,
            )

    provider = ScriptedProvider([{"thought": "done", "action": "done"}])
    tool = EffectorTool(
        workspace=tmp_path, provider=provider, model="fake/primary",
        decision_provider=provider, decision_model="fake/decision",
        require_approval=False,
    )

    with patch("nanoagent.agent.effector.browser_session.EffectorSession", _ManifestSession):
        out = json.loads(await tool.execute(goal="test"))

    caps = out["capabilities"]
    assert caps["engine"] == "chromium"
    assert caps["lifecycle_interception"] is True
    assert caps["tls_virtualizer"] == "unavailable"
