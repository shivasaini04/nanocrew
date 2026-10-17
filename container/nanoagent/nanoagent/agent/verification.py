"""What the agent actually proved this turn — and one nudge when it proved nothing.

Stage 42 #8, following the split Hermes Agent uses across
``agent/verification_evidence.py`` and ``agent/verification_stop.py``
(NousResearch/hermes-agent @ a7cd15e).

Two layers, deliberately separate:

* **The evidence ledger is passive.** It records what ran — which files were edited,
  which checks were executed, in what order. It never decides to run a suite, never
  blocks completion, and never upgrades a targeted check into "the repo is green".
* **Verify-on-stop is policy only.** When the model tries to finish immediately after
  editing code with no fresh evidence, it turns that record into exactly one bounded
  follow-up. It runs nothing itself.

This is the direct guard against the failure mode ``CLAUDE.md`` calls out — *"Typecheck
and build pass over unreachable modules, dead test suites, and code nothing calls"* —
where the agent edits code and reports success without ever executing anything.

Freshness is ordering, not clock time: evidence counts only if it came *after* the
most recent code edit. A test run before the change proves nothing about the change.

Doc-only turns are exempt. Editing a ``SKILL.md``, a README or a JSON fixture must
never demand a verification script — that false positive is why Hermes carries an
explicit non-code extension list, and this carries one too.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath

# Tools that change code on disk.
EDIT_TOOLS = frozenset({"write_file", "edit_file", "append_file"})

# Tools whose successful use IS evidence: they execute the project's own checks.
EVIDENCE_TOOLS = frozenset({"run_tests", "deploy_check", "test_runner"})

# Free-form execution tools — evidence only if what they ran looks like a check.
SHELL_TOOLS = frozenset({"exec", "shell", "python_repl"})

# Substrings that make a shell command count as verification. Deliberately narrow:
# a false "yes, that was verified" is worse than asking for one extra check.
VERIFY_MARKERS = (
    "pytest", "unittest", "vitest", "jest", "mocha", "go test", "cargo test",
    "npm test", "npm run test", "yarn test", "pnpm test", "tsc", "mypy", "ruff",
    "eslint", "npm run build", "npm run lint", "make test", "make check",
)

# Extensions whose edits carry no verifiable runtime behaviour: prose, docs and data
# that no test or build exercises. A turn touching ONLY these has nothing to verify.
NON_CODE_SUFFIXES = frozenset({
    ".md", ".markdown", ".rst", ".txt", ".csv", ".tsv", ".log",
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".pdf", ".ico",
})


@dataclass
class VerificationLedger:
    """Passive per-turn record of edits and checks. Never blocks, never runs anything."""

    edits: list[tuple[int, str]] = field(default_factory=list)
    evidence: list[tuple[int, str]] = field(default_factory=list)
    nudged: bool = False
    _seq: int = 0

    def note(self, tool_name: str, args: dict | None) -> None:
        """Record one tool call. Unknown tools are ignored; nothing here can raise."""
        self._seq += 1
        try:
            args = args if isinstance(args, dict) else {}
            if tool_name in EDIT_TOOLS:
                path = str(args.get("path") or args.get("file_path") or "").strip()
                if path:
                    self.edits.append((self._seq, path))
            elif tool_name in EVIDENCE_TOOLS:
                self.evidence.append((self._seq, tool_name))
            elif tool_name in SHELL_TOOLS:
                blob = " ".join(
                    str(v) for k, v in args.items() if k in ("command", "code", "script")
                ).lower()
                if any(marker in blob for marker in VERIFY_MARKERS):
                    self.evidence.append((self._seq, blob[:120]))
        except Exception:  # noqa: BLE001 — a passive ledger may never break a tool call
            pass

    def code_edits(self) -> list[str]:
        """Edited paths that something could actually verify."""
        return [p for _, p in self.edits if is_code_path(p)]

    def last_code_edit_seq(self) -> int | None:
        seqs = [s for s, p in self.edits if is_code_path(p)]
        return max(seqs) if seqs else None

    def has_fresh_evidence(self) -> bool:
        """True when a check ran *after* the most recent code edit."""
        last_edit = self.last_code_edit_seq()
        if last_edit is None:
            return True  # nothing to verify
        return any(seq > last_edit for seq, _ in self.evidence)

    def needs_nudge(self) -> bool:
        """Whether the turn should be asked to verify before it finishes.

        Once per turn, only for code edits, only when nothing ran afterwards.
        """
        return bool(self.code_edits()) and not self.has_fresh_evidence() and not self.nudged

    def nudge_message(self, max_paths: int = 8) -> str:
        paths = self.code_edits()
        shown = ", ".join(paths[:max_paths])
        if len(paths) > max_paths:
            shown += f", and {len(paths) - max_paths} more"
        return (
            f"Before you finish: you edited {shown} this turn and nothing has been run "
            "since. Execute the project's own check for what you changed — its tests, "
            "type-check, build or lint — and report the real result. If the change "
            "genuinely cannot be verified here, say so explicitly and explain why; do "
            "not describe it as working on the strength of having written it."
        )


def is_code_path(path: str) -> bool:
    """Whether edits to this path are worth verifying.

    Extension-based and forgiving: an extensionless path (a script, a Makefile) counts
    as code, because the cost of asking for an unnecessary check is one nudge, while
    the cost of missing one is an unverified claim of success.
    """
    try:
        suffix = PurePosixPath(str(path).replace("\\", "/")).suffix.lower()
    except Exception:  # noqa: BLE001
        return False
    return suffix not in NON_CODE_SUFFIXES
