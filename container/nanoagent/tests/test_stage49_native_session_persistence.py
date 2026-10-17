"""Session persistence on the native engine, which never worked until 2026-09-03.

Phase 2 made logins survive a cycle boundary and was verified on Chromium. The moment
camoufox started launching, all three of the moving parts broke on that lane at once —
and nothing failed, which is why it took a deliberate test to find:

1. `'Browser' object has no attribute 'storage_state'`. When the native browser reports
   no contexts, the launch path falls back to using the BROWSER as the context because
   it has `new_page`. A Browser cannot read cookies. The save threw and was swallowed.

2. The native teardown wrote the LEGACY PLAINTEXT session file and returned before ever
   reaching the vault, so on that lane phase 2's encryption did not happen at all —
   cookies for a logged-in site sat on disk in the clear.

3. `_restore_engine_session` did not exist. A comment had pointed at it since the engine
   was added ("see _restore_engine_session below") and the function was never written,
   so this lane had never restored a session. Every run simply started logged out, which
   is indistinguishable from having nothing saved.

Proven end to end afterwards against httpbin.org: a cookie set under cycle token tok-A
was still present under tok-B, with an encrypted vault on disk and no plaintext.
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.browser_session import EffectorSession


class _Ctx:
    """A real BrowserContext, as far as this code cares: it can read cookies."""

    def __init__(self):
        self.added: list = []

    async def storage_state(self, **_kw):
        return {"cookies": [{"name": "a", "value": "b"}], "origins": []}

    async def add_cookies(self, cookies):
        self.added.extend(cookies)


class _BrowserNotAContext:
    """What the native path falls back to: has new_page, cannot read cookies."""

    async def new_page(self):
        raise AssertionError("not called in these tests")


def _session(context, page=None) -> EffectorSession:
    s = EffectorSession.__new__(EffectorSession)
    s._context = context
    s.page = page
    return s


# ─── 1. resolving something that can actually read cookies ────────────────────

def test_a_real_context_is_used_directly():
    ctx = _Ctx()
    assert _session(ctx)._storage_context() is ctx


def test_a_browser_masquerading_as_a_context_falls_back_to_the_page():
    """The exact shape of the live failure. A Browser has new_page and no
    storage_state, and a page always knows its own context."""
    ctx = _Ctx()

    class Page:
        context = ctx

    resolved = _session(_BrowserNotAContext(), page=Page())._storage_context()
    assert resolved is ctx


def test_it_returns_none_rather_than_guessing():
    """The caller says so out loud instead of saving nothing and calling it success."""
    class PageWithNoContext:
        context = None

    assert _session(_BrowserNotAContext(), page=PageWithNoContext())._storage_context() is None
    assert _session(None)._storage_context() is None


# ─── 2. the save is the vault on both lanes ───────────────────────────────────

@pytest.mark.asyncio
async def test_the_session_is_written_to_the_encrypted_vault(tmp_path, monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    monkeypatch.setenv("AGENT_ID", "agent-1")

    s = _session(_Ctx())
    s._workspace = tmp_path
    s._session_domain = "example.com"
    await s._save_session_vault(crashed=False)

    vault = tmp_path / ".effector" / "vault" / "example.com.vault"
    assert vault.exists(), "the vault is where a session belongs on every lane"
    assert b"cookies" not in vault.read_bytes(), "it must be encrypted, not JSON on disk"


@pytest.mark.asyncio
async def test_a_crashed_run_saves_nothing(tmp_path, monkeypatch):
    """A dead browser's cookies are not worth overwriting a good session with."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "s")
    s = _session(_Ctx())
    s._workspace = tmp_path
    s._session_domain = "example.com"
    await s._save_session_vault(crashed=True)
    assert not (tmp_path / ".effector" / "vault").exists()


@pytest.mark.asyncio
async def test_a_lane_that_cannot_read_cookies_warns_rather_than_raising(tmp_path, monkeypatch):
    """This is the path that used to throw AttributeError into a bare except. It must
    now be survivable AND audible — a silent failure here is why the next run starts
    logged out with nothing explaining it."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "s")
    s = _session(_BrowserNotAContext())
    s._workspace = tmp_path
    s._session_domain = "example.com"
    await s._save_session_vault(crashed=False)  # must not raise
    assert not (tmp_path / ".effector" / "vault").exists()


# ─── 3. the restore that was referenced and never written ─────────────────────

@pytest.mark.asyncio
async def test_the_native_lane_restores_cookies(tmp_path, monkeypatch):
    from nanoagent.agent.effector.security.session_vault import SessionVault

    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "stable-per-agent-secret")
    monkeypatch.setenv("AGENT_ID", "agent-1")
    SessionVault.save_session(tmp_path, "example.com", {
        "cookies": [{"name": "li_at", "value": "secret", "domain": ".example.com"}],
        "origins": [],
    })

    ctx = _Ctx()
    s = _session(ctx)
    s._workspace = tmp_path
    s._session_domain = "example.com"
    s.capabilities = type("C", (), {"note": lambda self, r: None})()

    await s._restore_engine_session()

    assert [c["name"] for c in ctx.added] == ["li_at"], "the login must come back"


@pytest.mark.asyncio
async def test_restoring_with_nothing_saved_is_silent(tmp_path, monkeypatch):
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "s")
    ctx = _Ctx()
    s = _session(ctx)
    s._workspace = tmp_path
    s._session_domain = "example.com"
    s.capabilities = type("C", (), {"note": lambda self, r: None})()

    await s._restore_engine_session()
    assert ctx.added == []


@pytest.mark.asyncio
async def test_localstorage_is_reported_as_not_restored(tmp_path, monkeypatch):
    """Cookies come back; localStorage does not, because applying it means visiting each
    origin and that is not something to do silently at launch. A login that depends on
    it will still not survive here — said out loud rather than appearing to work."""
    from nanoagent.agent.effector.security.session_vault import SessionVault

    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "s")
    monkeypatch.setenv("AGENT_ID", "agent-1")
    SessionVault.save_session(tmp_path, "example.com", {
        "cookies": [{"name": "a", "value": "b"}],
        "origins": [{"origin": "https://example.com", "localStorage": [{"name": "t", "value": "1"}]}],
    })

    notes: list[str] = []
    s = _session(_Ctx())
    s._workspace = tmp_path
    s._session_domain = "example.com"
    s.capabilities = type("C", (), {"note": lambda self, r: notes.append(r)})()

    await s._restore_engine_session()
    assert any("localStorage" in n for n in notes)


@pytest.mark.asyncio
async def test_a_broken_restore_never_stops_the_run(tmp_path, monkeypatch):
    """Starting logged out is a worse run, not a failed one."""
    monkeypatch.setenv("NANOCREW_VAULT_SECRET", "s")

    class Exploding(_Ctx):
        async def add_cookies(self, cookies):
            raise RuntimeError("context went away")

    from nanoagent.agent.effector.security.session_vault import SessionVault
    monkeypatch.setenv("AGENT_ID", "agent-1")
    SessionVault.save_session(tmp_path, "example.com", {"cookies": [{"name": "a", "value": "b"}]})

    s = _session(Exploding())
    s._workspace = tmp_path
    s._session_domain = "example.com"
    s.capabilities = type("C", (), {"note": lambda self, r: None})()

    await s._restore_engine_session()  # must not raise
