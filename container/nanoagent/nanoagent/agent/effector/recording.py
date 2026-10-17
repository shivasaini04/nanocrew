"""God-level pillar 03, 2026-08-24: a grounded version
of "learn by watching a human."

Scope correction from the original doc: the container's own browser has no
human-visible display — browser_session.py's Xvfb virtual display is launched with
`-nolisten tcp` (desktop/xvfb_session.py), meaning it exists only for OS-level
automation (xdotool/scrot) inside this process, not as a remote desktop a person
could actually sit in front of. A human can never literally watch-and-mirror inside
THIS container the way the original doc pictured (30fps telemetry, live shadow-mode
prediction against a human's own session).

What IS real and buildable: a human can record a session with Playwright's own
`codegen` tool on their OWN machine — `playwright codegen <url> -o recording.py` is
the standard way anyone captures a Playwright session, nothing bespoke to install —
and hand the resulting script to the agent as a workspace file, the same way a
resume or portal credential already arrives as a workspace artifact (see
linkedin_job_applier.py's resume_path). This module turns that script into
domain-memory notes (reusing pillar 07's domain_memory.py storage) instead of the
doc's live decision-tree induction — a static AST parse of a small, well-known
call surface, never `exec`'d.
"""

from __future__ import annotations

import ast

from loguru import logger

# The subset of Playwright's Python API codegen actually emits that Effector's own
# executor.py already has an equivalent action for (click/type/select/navigate) —
# anything outside this set is silently skipped, not guessed at.
_RECOGNIZED_CALLS = {
    "goto", "click", "dblclick", "fill", "type", "check", "uncheck",
    "select_option", "press", "hover",
}

_LOCATOR_METHODS = ("locator", "get_by_role", "get_by_text", "get_by_label", "get_by_placeholder")


def _literal(node: ast.AST) -> str | None:
    """Best-effort constant-string extraction — codegen's own output is always a
    literal string for the calls this cares about; anything else (a variable, an
    f-string) is skipped rather than guessed at."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _describe_call(call: ast.Call) -> str | None:
    """`page.click("selector")` -> "click 'selector'". Also handles the chained
    form codegen emits for role/text-based locators — `page.get_by_role("button",
    name="Submit").click()` — by walking one level into the Attribute/Call the
    method is called on, same as the flat form."""
    if not isinstance(call.func, ast.Attribute):
        return None
    method = call.func.attr
    if method not in _RECOGNIZED_CALLS:
        return None

    target = call.func.value
    selector: str | None = None

    if (
        isinstance(target, ast.Call)
        and isinstance(target.func, ast.Attribute)
        and target.func.attr in _LOCATOR_METHODS
        and target.args
    ):
        selector = _literal(target.args[0])
    elif call.args:
        selector = _literal(call.args[0])

    if selector is None:
        return None

    extra = ""
    if method in ("fill", "type", "select_option", "press") and len(call.args) > 1:
        value = _literal(call.args[1])
        if value is not None:
            extra = f" -> {value!r}"

    return f"{method} {selector!r}{extra}"


def parse_codegen_script(source: str) -> list[str]:
    """Statically parses a Playwright Python codegen script (no exec — see module
    docstring) into an ordered list of human-readable step descriptions. Malformed
    input degrades to an empty list rather than raising, matching every other
    best-effort parser in this package (domain_memory.py, resolver.py's a11y
    layer)."""
    try:
        tree = ast.parse(source)
    except SyntaxError as err:
        logger.debug(f"effector recording: codegen script has a syntax error — {err}")
        return []

    steps: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            described = _describe_call(node)
            if described:
                steps.append(described)
    return steps


def summarize_for_domain_memory(steps: list[str], max_notes: int = 8) -> list[str]:
    """Shapes raw parsed steps into notes matching what react_loop.py's own
    _remember() already writes (short, one lesson per line) — capped at the same
    count domain_memory.py enforces on write, so one long recording doesn't crowd
    out everything a domain has learned from its own runs."""
    prefix = "Human recording showed this working step: "
    return [f"{prefix}{step}" for step in steps[:max_notes]]
