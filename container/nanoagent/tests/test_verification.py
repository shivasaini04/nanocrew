"""Don't let the agent call code "working" when it never ran anything.

Stage 42 item #8. This is the guard against the failure mode CLAUDE.md names
directly — "Typecheck and build pass over unreachable modules, dead test suites, and
code nothing calls" — where an agent edits code and reports success on the strength
of having written it.

Two layers, and the split matters: the ledger is **passive** (it records, it never
decides) and verify-on-stop is **policy** (it decides, it never runs anything).

The false positive to defend against is a doc-only turn. Editing a SKILL.md or a
README must never demand a verification script — that is why Hermes carries an
explicit non-code list, and why half these tests are about what does NOT nudge.
"""
from nanoagent.agent.verification import VerificationLedger, is_code_path


def ledger(*calls) -> VerificationLedger:
    led = VerificationLedger()
    for name, args in calls:
        led.note(name, args)
    return led


def edit(path):
    return ("write_file", {"path": path})


def shell(cmd):
    return ("exec", {"command": cmd})


# ─── when it asks for verification ──────────────────────────────────────────


def test_editing_code_and_stopping_earns_a_nudge():
    led = ledger(edit("src/loop.py"))

    assert led.needs_nudge()
    assert "src/loop.py" in led.nudge_message()


def test_running_the_tests_afterwards_satisfies_it():
    led = ledger(edit("src/loop.py"), shell("pytest tests/"))

    assert not led.needs_nudge()


def test_a_test_run_before_the_edit_proves_nothing():
    """Freshness is ordering, not clock time."""
    led = ledger(shell("pytest tests/"), edit("src/loop.py"))

    assert led.needs_nudge()


def test_a_second_edit_invalidates_earlier_evidence():
    led = ledger(edit("a.py"), shell("pytest"), edit("b.py"))

    assert led.needs_nudge()


def test_the_dedicated_test_tool_counts_as_evidence():
    led = ledger(edit("src/loop.py"), ("run_tests", {"framework": "pytest"}))

    assert not led.needs_nudge()


def test_a_build_or_typecheck_counts_too():
    for cmd in ("npm run build", "tsc --noEmit", "ruff check .", "mypy src"):
        assert not ledger(edit("a.py"), shell(cmd)).needs_nudge(), cmd


# ─── when it must stay quiet ────────────────────────────────────────────────


def test_a_doc_only_turn_is_never_nudged():
    """A SKILL.md edit must not demand a verification script."""
    led = ledger(edit("skills/outbound/SKILL.md"), edit("README.md"))

    assert not led.needs_nudge()


def test_data_and_image_edits_are_not_code():
    led = ledger(edit("data/leads.csv"), edit("docs/diagram.png"))

    assert not led.needs_nudge()


def test_a_turn_that_edited_nothing_is_never_nudged():
    led = ledger(("read_file", {"path": "src/loop.py"}), shell("ls"))

    assert not led.needs_nudge()


def test_it_fires_at_most_once_per_turn():
    """A bounded follow-up, not a standoff."""
    led = ledger(edit("a.py"))
    assert led.needs_nudge()

    led.nudged = True

    assert not led.needs_nudge()


def test_an_unrelated_shell_command_is_not_evidence():
    """A narrow marker list on purpose: a false 'verified' is worse than one nudge."""
    led = ledger(edit("a.py"), shell("ls -la && cat README.md"))

    assert led.needs_nudge()


# ─── robustness ─────────────────────────────────────────────────────────────


def test_malformed_args_never_raise():
    led = VerificationLedger()
    for args in (None, "a string", 42, [], {"path": None}):
        led.note("write_file", args)

    assert not led.needs_nudge()


def test_an_extensionless_path_counts_as_code():
    """A Makefile or a bare script is worth verifying; over-asking costs one nudge."""
    assert is_code_path("scripts/deploy")
    assert is_code_path("Makefile")


def test_mixed_turns_report_only_the_code_paths():
    led = ledger(edit("README.md"), edit("src/a.py"), edit("notes.txt"))

    assert led.code_edits() == ["src/a.py"]
    assert "README.md" not in led.nudge_message()


def test_the_nudge_caps_how_many_paths_it_lists():
    led = ledger(*[edit(f"src/f{i}.py") for i in range(20)])

    msg = led.nudge_message(max_paths=3)

    assert "and 17 more" in msg
