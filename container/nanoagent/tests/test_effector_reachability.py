"""The reachability contract — every security component must be REACHED, not just work.

On 2026-08-31 this suite was 951 passed / 1 skipped while five components were
unreachable in production:

  * MerkleActionLedger    — built, filled, and dropped on function return
  * PromptFirewall        — wired downstream of every decision it should gate
  * CDPTargetInterceptor  — never constructed
  * CanaryGuard           — never constructed
  * the Camoufox fork     — probe called a function that does not exist

Every one had a passing test. Each imported the class, called its methods, and asserted
on the return values. **Not one asserted that production reaches it.** That is the whole
category of test this file adds.

## Doctrine

When testing a security control, assert on the **effect in the production path** — the
file that appears on disk, the prompt that was actually sent, the action that did not
execute. Asserting that a class returns the right value when called directly proves the
class works; it proves nothing about whether anything calls it.

Prefer driving the real chain (see `test_effector_phase0.FakeSession` /
`ScriptedProvider`) over patching the layer you are trying to verify. The Phase 16 tests
passed throughout because they mocked `run_react_loop` — replacing the very path that
was broken.

These checks are grep-based against a declared contract. That is deliberate: crude, but
it fails loudly the moment a call site disappears, and it costs nothing to run.
Sophistication here would be false economy — an AST walker that silently stops matching
is exactly the failure it exists to prevent.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

PKG_ROOT = Path(__file__).resolve().parents[1]
EFFECTOR = PKG_ROOT / "nanoagent" / "agent" / "effector"
TOOLS = PKG_ROOT / "nanoagent" / "agent" / "tools"


# (symbol, human-readable role, path relative to the nanoagent package root)
REACHABILITY_CONTRACT: list[tuple[str, str, str]] = [
    ("MerkleActionLedger", "R1 — tamper-evident action chain",
     "nanoagent/agent/tools/effector.py"),
    ("PromptFirewall", "R2 — perception sanitised before the model reads it",
     "nanoagent/agent/tools/effector.py"),
    ("wrap_untrusted_perception", "R2 — taint boundary around page content",
     "nanoagent/agent/effector/react_loop.py"),
    ("is_adversarial_injection", "R2 — injection detection that gates actions",
     "nanoagent/agent/effector/react_loop.py"),
    ("engine_status", "R3 — engine availability probe",
     "nanoagent/agent/effector/browser_session.py"),
    ("CapabilityManifest", "R3 — degradation reported to the caller",
     "nanoagent/agent/effector/browser_session.py"),
    ("CDPTargetInterceptor", "R4 — popups patched before their first script",
     "nanoagent/agent/effector/browser_session.py"),
    ("CanaryGuard", "R5 — control-plane leak detection",
     "nanoagent/agent/effector/react_loop.py"),
    ("DlpScanner", "outbound PII/secret blocking",
     "nanoagent/agent/effector/stealth/network_shield.py"),
    ("L7NetworkPolicy", "SSRF / egress allowlist",
     "nanoagent/agent/effector/browser_session.py"),
    ("SessionVault", "encrypted cookie storage",
     "nanoagent/agent/effector/browser_session.py"),
    ("IsolatedWorldManager", "CDP isolated-world execution",
     "nanoagent/agent/effector/browser_session.py"),
    ("ChallengeSolver", "anti-bot challenge interaction",
     "nanoagent/agent/tools/effector.py"),
]

CONTRACT_SYMBOLS = {symbol for symbol, _, _ in REACHABILITY_CONTRACT}

# Classes that are deliberately NOT constructed from a production path. Each entry must
# name the reason. The point of this list is to make "not wired" a conscious, reviewed
# act rather than an oversight — which is how R1-R5 happened.
WAIVED: dict[str, str] = {
    "MerkleBlock": "dataclass carried inside MerkleActionLedger, not a component",
    "BenchmarkCategoryResult": "dataclass, part of the benchmark report",
    "BenchmarkReport": "dataclass, part of the benchmark report",
    "AdversarialBenchmarkHarness": (
        "offline tool — run by scripts/run_stealth_benchmark.py, not from a cycle (R5 §3)"
    ),
    "SpatialVisualMarker": (
        "dataclass in perception/spatial_vla.py; the module is reached through "
        "ground_canvas_coordinates() in resolver.py"
    ),
    "PixelElement": (
        "dataclass in perception/pixel_elements.py; the module is reached through "
        "pixel_elements.detect()/table() in react_loop.py when the DOM finds no "
        "interactive elements (stage 61 phase 8)"
    ),
    "VaultKeyUnavailable": (
        "exception type raised by session_vault._derive_vault_key and handled in "
        "SessionVault.load_session, not a component with its own call site (stage 49 "
        "phase 2)"
    ),
}


@pytest.mark.parametrize(
    "symbol,role,call_site",
    REACHABILITY_CONTRACT,
    ids=[f"{s}" for s, _, _ in REACHABILITY_CONTRACT],
)
def test_component_is_reachable_from_production(symbol: str, role: str, call_site: str):
    """Every security component must be referenced from its declared call site.

    Being defined, exported and unit-tested is not enough — that was true of all five
    components broken on 2026-08-31.
    """
    path = PKG_ROOT / call_site
    assert path.exists(), f"declared call site {call_site} does not exist"

    source = path.read_text(encoding="utf-8")
    assert symbol in source, (
        f"{symbol} ({role}) is not referenced in {call_site}.\n"
        f"It may be defined, exported and unit-tested while production never calls it.\n"
        f"Wire it, or remove it from REACHABILITY_CONTRACT *and* from the codebase."
    )


def _public_classes(package: str) -> set[str]:
    """Top-level class names declared under effector/<package>/."""
    found: set[str] = set()
    for py in (EFFECTOR / package).glob("*.py"):
        if py.name == "__init__.py":
            continue
        tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
        for node in tree.body:
            if isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
                found.add(node.name)
    return found


@pytest.mark.parametrize("package", ["security", "lifecycle", "perception", "benchmarks"])
def test_no_orphaned_security_components(package: str):
    """A new component with no production call site and no waiver fails the suite.

    This is the check that would have caught phases 8, 14 and 15 on the day they
    shipped, instead of two weeks later in an audit.
    """
    for symbol in sorted(_public_classes(package)):
        assert symbol in CONTRACT_SYMBOLS or symbol in WAIVED, (
            f"{symbol} (effector/{package}/) is a new security component with no "
            f"production call site and no waiver.\n"
            f"Either wire it and add it to REACHABILITY_CONTRACT, delete it, or add a "
            f"WAIVED entry saying why it is deliberately not wired."
        )


def test_every_waiver_states_a_reason():
    """A waiver without a reason is just an exemption nobody reviewed."""
    for symbol, reason in WAIVED.items():
        assert len(reason) > 25, f"waiver for {symbol} does not explain itself: {reason!r}"


def test_contract_has_no_stale_entries():
    """A contract row naming a symbol that no longer exists passes vacuously."""
    defined: set[str] = set()
    for py in EFFECTOR.rglob("*.py"):
        if "engine" in py.parts:          # the vendored fork is not ours to police
            continue
        tree = ast.parse(py.read_text(encoding="utf-8", errors="ignore"), filename=str(py))
        for node in ast.walk(tree):
            if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
                defined.add(node.name)

    for symbol, _, _ in REACHABILITY_CONTRACT:
        assert symbol in defined, (
            f"{symbol} is in the contract but is defined nowhere under effector/ — "
            f"the row is stale and its test is passing on a substring coincidence"
        )


# ─── Properties the audit showed a plain reference check cannot catch ──────────


def test_ledger_output_is_persisted_not_discarded():
    """R1: the dispatcher referenced MerkleActionLedger the whole time it was broken.

    A grep for the symbol would have passed. What was missing was the persist call —
    the chain was built into a local and dropped on return.
    """
    source = (TOOLS / "effector.py").read_text(encoding="utf-8")
    assert "ledger.persist(" in source, (
        "the audit ledger is constructed but never written — an audit nobody can read "
        "afterwards audits nothing (R1)"
    )


def test_firewall_runs_before_the_decision_not_only_after():
    """R2: the firewall was referenced from the dispatcher while defending nothing.

    Sanitising `extracted_data` after the loop protects the result JSON. The load-
    bearing call is inside react_loop, upstream of the decision prompt.
    """
    loop = (EFFECTOR / "react_loop.py").read_text(encoding="utf-8")
    assert "wrap_untrusted_perception(" in loop
    build_at = loop.index("_build_turn_prompt(")
    wrap_at = loop.index("wrap_untrusted_perception(perception_summary")
    assert wrap_at < loop.index("prompt = _build_turn_prompt(", build_at), (
        "perception is wrapped after the prompt is built — the model still sees raw "
        "page text (R2)"
    )


def test_canary_is_validated_before_a_step_executes():
    """R5: validating after execution would be a post-mortem, not a control."""
    loop = (EFFECTOR / "react_loop.py").read_text(encoding="utf-8")
    assert "canary.validate_step(" in loop
    assert loop.index("canary.validate_step(") < loop.index("await execute_step("), (
        "the canary is checked after the step executes (R5)"
    )


def test_interceptor_is_armed_before_the_first_page_exists():
    """R4: arming after new_page() reopens the race it exists to close."""
    session = (EFFECTOR / "browser_session.py").read_text(encoding="utf-8")
    assert session.index("enable_auto_attach") < session.index(
        "self.page = await self._context.new_page()"
    ), "auto-attach is armed after the first page already exists (R4)"


def test_capability_probe_has_no_side_effects():
    """R3: a probe that downloads a browser or deletes an install is not a probe.

    Both happened while wiring this — pkgman.camoufox_path() defaults to
    download_if_missing=True and opens with an unconditional rmtree.
    """
    driver = (EFFECTOR / "stealth" / "camoufox_driver.py").read_text(encoding="utf-8")
    body = driver[driver.index("def engine_status"):driver.index("def is_camoufox_available")]
    # Comments in this function NAME the dangerous calls in order to explain why they
    # are avoided — match against code only, or the explanation trips the check.
    code = "\n".join(
        line.split("#", 1)[0] for line in body.splitlines() if not line.strip().startswith("#")
    )
    for unsafe in ("camoufox_path(", "launch_path("):
        assert unsafe not in code, (
            f"engine_status() calls {unsafe} — it downloads a browser and rmtree's the "
            f"install dir, so a bare availability probe hangs and destroys state (R3)"
        )


def test_no_self_assessed_rating_in_source():
    """R7: a log line must not assert a security rating.

    browser_session logged 'Tier: 9.8+' on every native-engine start — an unmeasured
    claim that read as fact in every trace.
    """
    offenders = [
        py.name
        for py in EFFECTOR.rglob("*.py")
        if "engine" not in py.parts
        and "Tier: 9" in py.read_text(encoding="utf-8", errors="ignore")
    ]
    assert not offenders, f"self-assessed rating in source: {offenders}"
