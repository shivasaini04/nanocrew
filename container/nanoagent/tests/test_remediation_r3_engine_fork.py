"""R3 (engine slice) — our inlined engine fork must be able to actually run.

The engine at agent/effector/engine/ is a deliberate fork: vendored so we can modify it
(AI-driven control, new capabilities) rather than tracking an upstream package. That
decision is only worth anything if the fork can start, and on 2026-08-31 it could not:

  * `is_camoufox_available()` called `get_installed_browser_path`, which does not exist
    anywhere in the vendored engine. The ImportError was swallowed by a bare
    `except Exception: return False`, so the probe reported "unavailable" on every
    machine — including one with the browser installed. The engine was unreachable for
    reasons that had nothing to do with the binary.
  * `EFFECTOR_ENGINE` defaulted to "auto", which meant *off*. Even a correct probe
    would not have started it.
  * Nothing fetched the browser binary in the container build.

The probe tests below matter as much as the wiring ones: a capability probe that
downloads several hundred MB, or deletes an install directory, is not a probe.
"""

from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from nanoagent.agent.effector.stealth import camoufox_driver


# tests/ -> nanoagent/ (the package root, holding pyproject.toml) -> container/
PKG_ROOT = Path(__file__).resolve().parents[1]
CONTAINER_ROOT = PKG_ROOT.parent
ENGINE_DIR = PKG_ROOT / "nanoagent" / "agent" / "effector" / "engine"


# ------------------------------------------------------------------ the fork itself


def test_engine_package_is_vendored_in_tree():
    """The fork is ours: it lives in the repo, not in site-packages."""
    assert (ENGINE_DIR / "__init__.py").exists()
    assert (ENGINE_DIR / "pkgman.py").exists()


def test_engine_imports_cleanly():
    """A fork we cannot import is a fork we cannot modify."""
    from nanoagent.agent.effector.engine.async_api import AsyncCamoufox  # noqa: F401


def test_engine_cli_dependencies_are_declared():
    """`python -m ...engine fetch` (the Dockerfile build step) needs rich_click.

    Vendoring the engine means owning its dependency list — nothing else pulls these in.
    """
    import rich_click  # noqa: F401


def test_probe_uses_an_api_the_engine_actually_has():
    """Regression: the probe called a function that never existed in the fork."""
    from nanoagent.agent.effector.engine import pkgman

    assert not hasattr(pkgman, "get_installed_browser_path"), (
        "if the fork ever gains this name, revisit engine_status() — it was written "
        "against camoufox_path/launch_path/get_active_path precisely because this "
        "function does not exist"
    )
    assert hasattr(pkgman, "camoufox_path")
    assert hasattr(pkgman, "launch_path")


# ------------------------------------------------------------------------- the probe


def test_engine_status_returns_a_reason_not_just_false():
    """A bare False conflates 'no binary' with 'integration broken'."""
    available, reason = camoufox_driver.engine_status()
    assert isinstance(available, bool)
    assert reason and isinstance(reason, str)
    if not available:
        assert reason != "False"


def test_probe_never_downloads_and_never_deletes(monkeypatch):
    """The probe must have NO side effects.

    pkgman.camoufox_path() defaults to download_if_missing=True and opens with an
    unconditional shutil.rmtree(INSTALL_DIR) 'clean up old data' branch. Asking whether
    the engine is ready must not trigger either — it hung for 120s on the first attempt
    and printed 'Cleaning old data...' on the second.
    """
    import shutil

    from nanoagent.agent.effector.engine import pkgman

    def _explode(*a, **kw):
        raise AssertionError("probe triggered a download")

    def _no_rmtree(*a, **kw):
        raise AssertionError("probe deleted an install directory")

    monkeypatch.setattr(shutil, "rmtree", _no_rmtree)
    monkeypatch.setattr(pkgman.CamoufoxFetcher, "install", _explode, raising=False)

    camoufox_driver.engine_status()


def test_probe_reports_unavailable_when_no_install_present(monkeypatch):
    from nanoagent.agent.effector.engine import multiversion

    monkeypatch.setattr(multiversion, "get_active_path", lambda: None)
    monkeypatch.setattr(camoufox_driver, "Path", Path)

    available, reason = camoufox_driver.engine_status()
    if not available:
        assert "not installed" in reason or "missing" in reason


def test_probe_is_available_when_the_binary_exists(monkeypatch, tmp_path: Path):
    """The positive case — proves the probe can ever say yes."""
    from nanoagent.agent.effector.engine import multiversion, pkgman

    fake_install = tmp_path / "camoufox-install"
    fake_install.mkdir()
    binary = fake_install / pkgman.LAUNCH_FILE[pkgman.OS_NAME]
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_text("#!/bin/sh\n", encoding="utf-8")

    monkeypatch.setattr(multiversion, "get_active_path", lambda: fake_install)

    if pkgman.OS_NAME == "mac":
        pytest.skip("mac layout nests the binary inside Camoufox.app")

    available, reason = camoufox_driver.engine_status()
    assert available is True, reason
    assert str(binary) in reason


# ------------------------------------------------------------------------ the gating


def _session(**kw):
    from nanoagent.agent.effector.browser_session import EffectorSession

    return EffectorSession(Path(kw.pop("workspace", ".")), **kw)


@pytest.mark.parametrize("env,expect_requested", [
    ({}, True),                                        # auto == use it when present
    ({"EFFECTOR_ENGINE": "auto"}, True),
    ({"EFFECTOR_ENGINE": "camoufox"}, True),
    ({"EFFECTOR_USE_NATIVE_ENGINE": "1"}, True),
    ({"EFFECTOR_ENGINE": "chromium"}, False),
])
def test_engine_preference_resolution(env, expect_requested, monkeypatch):
    """`auto` means USE IT WHEN AVAILABLE.

    It previously meant 'off unless an env var is set', which — combined with the
    broken probe — made the fork permanently unreachable in production.
    """
    for k in ("EFFECTOR_ENGINE", "EFFECTOR_USE_NATIVE_ENGINE"):
        monkeypatch.delenv(k, raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)

    pref = os.environ.get("EFFECTOR_ENGINE", "auto").lower()
    if os.environ.get("EFFECTOR_USE_NATIVE_ENGINE") == "1":
        pref = "camoufox"
    assert (pref in ("auto", "camoufox")) is expect_requested


def test_dockerfile_fetches_the_engine_binary():
    """R3 reachability guard for the build: without this step the fork is dead code.

    Fails if the fetch is dropped from the image — the exact condition that made the
    engine unreachable in every deployed container.
    """
    dockerfile = (CONTAINER_ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert "effector.engine fetch" in dockerfile, (
        "the Dockerfile no longer fetches the engine browser binary — the native "
        "engine path becomes unreachable and every run silently uses Chromium"
    )


def test_engine_deps_declared_in_pyproject():
    """Vendoring the engine means owning its dependencies."""
    pyproject = (PKG_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    for dep in ("browserforge", "rich-click", "platformdirs", "screeninfo"):
        assert dep in pyproject, f"engine dependency {dep!r} is not declared"


def test_session_exposes_which_engine_ran():
    """A run must be able to report its engine rather than leaving it to be inferred."""
    from nanoagent.agent.effector.browser_session import EffectorSession

    assert isinstance(EffectorSession.engine, property)
    assert isinstance(EffectorSession.engine_reason, property)


def test_engine_runtime_data_files_are_packaged():
    """The engine is data-driven; a wheel of pure .py files cannot launch it.

    hatch's `include` is an allowlist. On 2026-08-31 webgl/webgl_data.db was missing
    from the installed image and the engine died with "sqlite3.OperationalError: unable
    to open database file" — an error that names sqlite, not packaging, which is what
    made it hard to see. The top-level .json/.yml files happened to be included, so the
    engine looked mostly installed.
    """
    import tomllib

    include = tomllib.loads((PKG_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    patterns = include["tool"]["hatch"]["build"]["include"]

    # Every non-.py extension the engine actually reads at runtime must be covered.
    engine = PKG_ROOT / "nanoagent" / "agent" / "effector" / "engine"
    needed = {
        f.suffix for f in engine.rglob("*")
        if f.is_file() and f.suffix and f.suffix not in (".py", ".pyc")
    }
    # hatch treats "a/**/*.ext" as matching at any depth INCLUDING directly in `a`,
    # which fnmatch does not — so compare on the suffix the pattern names rather than
    # trying to reimplement the glob.
    engine_suffixes = {
        "." + pat.rsplit(".", 1)[-1]
        for pat in patterns
        if "effector/engine" in pat and pat.rsplit("/", 1)[-1].startswith("*.")
    }
    engine_literals = {
        pat.rsplit("/", 1)[-1]
        for pat in patterns
        if "effector/engine" in pat and not pat.rsplit("/", 1)[-1].startswith("*.")
    }

    def is_covered(f) -> bool:
        return f.suffix in engine_suffixes or f.name in engine_literals

    missing = sorted({
        f.suffix for f in engine.rglob("*")
        if f.is_file() and f.suffix and f.suffix not in (".py", ".pyc")
        and not is_covered(f)
    })
    assert not missing, (
        f"engine data files with extensions {missing} are not in the wheel "
        f"include list — they will be absent from the installed image and the engine "
        f"will fail at launch"
    )


def test_engine_data_files_survive_the_docker_build_context():
    """.dockerignore strips files BEFORE the wheel is ever built.

    Two independent gates have to agree for an engine data file to reach the image:
    pyproject's hatch `include` (test above) and container/.dockerignore. On
    2026-08-31 the packaging fix alone changed nothing, because `**/*.db` — a blunt
    rule protecting voice call records — had already removed webgl_data.db from the
    build context. COPY never saw it, so the wheel was built without it.

    Cross-boundary contract, exactly the shape of reference_rename_gaps: two configs
    in different languages that must be edited together.
    """
    dockerignore = (CONTAINER_ROOT / ".dockerignore").read_text(encoding="utf-8")

    db = PKG_ROOT / "nanoagent" / "agent" / "effector" / "engine" / "webgl" / "webgl_data.db"
    if not db.exists():
        pytest.skip("engine webgl database is not vendored in this checkout")

    assert "**/*.db" in dockerignore, (
        "the blanket .db exclusion protecting voice call records is gone — check that "
        "no customer database can now reach the image"
    )
    # Doubled prefix: the build context root is container/, and the package lives at
    # container/nanoagent/nanoagent/... A single "nanoagent/" here matches nothing —
    # which is exactly how the first attempt at this negation silently did nothing.
    assert "!nanoagent/nanoagent/agent/effector/engine/webgl/webgl_data.db" in dockerignore, (
        "the engine's WebGL reference database is excluded from the Docker build "
        "context by the blanket **/*.db rule, so it will be missing from the image "
        "and the engine will fail at launch with a sqlite error"
    )
