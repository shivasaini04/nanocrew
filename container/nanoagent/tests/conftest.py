"""Let leaf-module unit tests run without the full agent runtime installed.

``nanoagent/agent/__init__.py`` eagerly re-exports ``AgentLoop``, which imports
litellm, loguru, telegram, slack and the rest of the provider stack. That makes
even a pure-stdlib module like ``agent.security`` unimportable outside the built
container image, so the whole ``tests/`` directory failed at collection.

Registering a lightweight stand-in for the package — same ``__path__``, no
eager re-exports — lets ``nanoagent.agent.<leaf>`` resolve normally. Tests that
genuinely need ``AgentLoop`` still import it explicitly and still require the
full environment.
"""

import sys
import types
from pathlib import Path

_PACKAGE_ROOT = Path(__file__).resolve().parents[1]

if str(_PACKAGE_ROOT) not in sys.path:
    sys.path.insert(0, str(_PACKAGE_ROOT))

if "nanoagent.agent" not in sys.modules:
    import nanoagent  # noqa: F401  (light: version constants only)

    _agent_pkg = types.ModuleType("nanoagent.agent")
    _agent_pkg.__path__ = [str(_PACKAGE_ROOT / "nanoagent" / "agent")]
    sys.modules["nanoagent.agent"] = _agent_pkg


# ─── Real-browser fixtures (stage45 doc 04) ─────────────────────────────────
#
# Most effector tests drive a fake page whose evaluate() returns canned dicts. That
# is right for the Python around the snapshot and useless for the parts of it that
# ARE JavaScript — the shadow-DOM walker (phase 3) and the occlusion hit-test (phase
# 4). A fake there proves only that Python copies dict keys onto a dataclass.
#
# The launch probe is cached so it costs one browser start per session, not one per
# test file, and it is a skip rather than a failure so the suite stays runnable on a
# machine with no browsers installed.

import functools

import pytest


@functools.lru_cache(maxsize=1)
def chromium_available() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            p.chromium.launch().close()
        return True
    except Exception:
        return False


requires_chromium = pytest.mark.skipif(
    not chromium_available(),
    reason="real Chromium not installed — this covers JavaScript and needs one",
)


@pytest.fixture
async def page():
    """A blank page in a fresh browser, one per test."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        pg = await browser.new_page()
        yield pg
        await browser.close()


@pytest.fixture(autouse=True)
def _isolate_yc_detail_cache(monkeypatch, tmp_path):
    """yc_jobs remembers descriptions it has read in a file under /workspace. Without this,
    one test's cached description would silently answer another test's detail fetch."""
    yc_jobs = sys.modules.get("nanoagent.agent.tools.yc_jobs")  # only if a test imported it
    if yc_jobs is not None:
        monkeypatch.setattr(yc_jobs, "_DETAIL_CACHE_PATH", tmp_path / "yc_detail_cache.json")


@pytest.fixture(autouse=True)
def _isolate_warm_browser_pool(monkeypatch):
    """Effector keeps a launched browser alive between runs (effector/browser_pool.py).
    That is the point of it in production and a trap in tests: the pool is per PROCESS,
    so a session built on one test's fake Playwright chain gets handed straight to the
    next test, which then asserts against a browser it never created.

    Same shape as the yc_jobs cache above — shared state that silently answers the wrong
    question. Off by default here; the pool's own tests turn it back on deliberately.
    """
    monkeypatch.setenv("EFFECTOR_WARM_BROWSER", "0")


@pytest.fixture(autouse=True)
def _no_proxied_429_backoff(monkeypatch):
    """source_fetch backs off 10s+ before retrying a proxied 429 on a fresh exit. Real
    behaviour, but no test is measuring the wait."""
    sf = sys.modules.get("nanoagent.agent.source_fetch")
    if sf is not None:
        monkeypatch.setattr(sf, "_PROXIED_429_BACKOFF_S", 0.0)
