"""Cheap content-sanity check for truncated model responses.

Stage 42 item #9, ported from Hermes Agent's ``agent/repetition_guard.py``
(NousResearch/hermes-agent @ a7cd15e). Their incident: a model in a degenerate
repetition loop spent its ENTIRE output budget echoing one fragment, and the
continuation path stitched it into the final response with no content check —
one turn produced a 60,698-char answer delivered as 31 Discord messages.

Our exposure is the same shape but bills differently. ``AgentLoop`` never reads
``LLMResponse.finish_reason`` (every provider sets it; nothing consumed it before
stage 42), so a response truncated at ``max_tokens`` was handed back as though the
model had finished speaking. When that truncated text is repetition garbage it also
lands in ``turn_record`` → the session → and is resent on every subsequent
iteration, and since each iteration resends the whole history (see the
``_last_prompt_tokens`` note in ``loop.py``) 4k tokens of echoed text is charged
again and again against a per-cycle budget.

This module only answers "is this fragment degenerate?". The policy — what to do
about it — lives at the call site in ``loop.py``, which routes a degenerate
truncation into the existing grace-call recovery rather than showing it to anyone.

Detection is deliberately conservative: only LONG verbatim repeats (60+ chars)
whose occurrences cover a majority of the fragment trip the guard, so ordinary
truncated responses (a sentence cut mid-word, a repeated heading, code with
similar-looking lines) are never flagged. It fails *open* — anything it cannot
confidently judge is treated as fine.

Pure and stdlib-only on purpose: importable by the test suite's package shim
without the provider stack, and cheap enough to run on every terminal turn.
"""

from __future__ import annotations

import math

# A fragment must be at least this long before the repetition check runs at all.
# Short truncations (a sentence cut mid-word) can trivially contain repeated
# tokens and are legitimately incomplete rather than degenerate.
MIN_FRAGMENT_LENGTH = 400

# Length of the exact-repeat window. A verbatim repeat of this many chars is far
# beyond ordinary phrasing reuse (citations, headings, similar code).
_REPEAT_WINDOW = 60

# A window that repeats at least this many times is a repetition signal, even
# for shorter fragments.
_MIN_REPEAT_COUNT = 5

# A fragment is "repetition-dominated" when repeated windows account for at
# least this fraction of its characters.
_DOMINANCE_RATIO = 0.5


def is_repetition_dominated(text: object) -> bool:
    """True when ``text`` is dominated by verbatim repeated fragments.

    A response is repetition-dominated when a single 60+ char substring appears
    often enough that its occurrences cover at least half the text. That shape is
    the signature of a model repetition loop.

    Returns False for non-string, empty, or short inputs — fail-open, so the guard
    never suppresses an answer it cannot confidently judge.
    """
    if not isinstance(text, str):
        return False
    n = len(text)
    if n < MIN_FRAGMENT_LENGTH:
        return False

    # Fast path: one normalised line duplicated often enough to cover half the
    # fragment — the most common echo shape (a repeated sentence or paragraph on
    # its own line). Cheap, no large allocations.
    if _line_repetition_dominated(text, n):
        return True

    # General path: fixed-size exact-repeat windows, sliding one char at a time.
    # Catches repetition that does not align to line boundaries.
    window = _REPEAT_WINDOW
    needed = max(_MIN_REPEAT_COUNT, math.ceil(n * _DOMINANCE_RATIO / window))
    counts: dict[str, int] = {}
    for i in range(n - window + 1):
        key = text[i : i + window]
        c = counts.get(key, 0) + 1
        if c >= needed:
            return True
        counts[key] = c
    return False


def _line_repetition_dominated(text: str, n: int) -> bool:
    """True when a single normalised line covers half the fragment via repeats."""
    counts: dict[str, int] = {}
    for line in text.splitlines():
        norm = line.strip()
        if not norm:
            continue
        counts[norm] = counts.get(norm, 0) + 1
    for line, c in counts.items():
        if c >= _MIN_REPEAT_COUNT and c * len(line) >= n * _DOMINANCE_RATIO:
            return True
    return False
