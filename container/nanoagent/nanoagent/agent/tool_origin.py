"""Tool write-origin provenance — who is driving the tool call right now.

Stage 42, item #2. This is the gate on autonomous skill curation: before anything
can safely archive, merge or rewrite a skill, it has to be able to tell apart

  * ``assistant_tool``    — a foreground agent doing work the user asked for
  * ``background_review`` — the agent's own post-turn review fork, writing sediment
  * ``user``              — a direct human/orchestrator write
  * ``curator``           — the curator retiring or consolidating the fork's output

A curator may only ever touch what it autonomously created. Skills a user asked a
foreground agent to write belong to the user and must never be auto-curated.

The signal is a :class:`~contextvars.ContextVar` rather than a parameter threaded
through every tool because it has to survive an arbitrary call depth (registry →
tool → helper → sidecar writer) without every layer in between knowing about it.
``asyncio.create_task`` copies the current context, so a task spawned inside a
tool inherits the origin; the registry resets it in a ``finally`` either way.

Usage — the registry sets it once around dispatch::

    token = set_current_write_origin("background_review")
    try:
        ...  # tool runs here
    finally:
        reset_current_write_origin(token)

and a tool that persists something durable reads it::

    from nanoagent.agent.tool_origin import get_current_write_origin
    origin = get_current_write_origin()

Deliberately stdlib-only and dependency-free: leaf tools import it without
dragging in the provider stack, and ``tests/conftest.py``'s package shim can
resolve it outside the container image.
"""

from __future__ import annotations

import contextvars
from contextlib import contextmanager
from typing import Iterator

# A foreground agent acting on the user's request. The safe default: anything
# whose origin we cannot establish is treated as user-owned, so an unattributed
# write is never eligible for autonomous curation.
DEFAULT_ORIGIN = "assistant_tool"

# The post-turn self-improvement fork (stage 42 item #1). Writes tagged with this
# are the ONLY ones a curator may autonomously archive or consolidate.
BACKGROUND_REVIEW = "background_review"

# A direct human or orchestrator write (dashboard, seeding, migration).
USER = "user"

# The curator archiving or consolidating what the review fork left behind. Distinct
# from BACKGROUND_REVIEW on purpose: "the curator retired this" and "the fork wrote
# this" are different facts, and conflating them would make the audit trail lie.
CURATOR = "curator"

KNOWN_ORIGINS = frozenset({DEFAULT_ORIGIN, BACKGROUND_REVIEW, USER, CURATOR})

_current_write_origin: contextvars.ContextVar[str] = contextvars.ContextVar(
    "nanoagent_write_origin", default=DEFAULT_ORIGIN
)


def normalize_origin(origin: str | None) -> str:
    """Coerce an origin to a known tag, defaulting to user-owned.

    An unrecognised origin falls back to :data:`DEFAULT_ORIGIN` rather than raising —
    provenance is telemetry on the write path, and must never be the reason a tool
    call fails. An unknown tag would otherwise silently widen what the curator
    considers its own, so failing *closed* (to user-owned) is the safe direction.
    """
    return origin if origin in KNOWN_ORIGINS else DEFAULT_ORIGIN


def get_current_write_origin() -> str:
    """Origin of the write happening right now. Never raises."""
    return _current_write_origin.get()


def set_current_write_origin(origin: str | None) -> contextvars.Token:
    """Set the current origin, returning a token for :func:`reset_current_write_origin`."""
    return _current_write_origin.set(normalize_origin(origin))


def reset_current_write_origin(token: contextvars.Token) -> None:
    """Restore the origin captured by ``token``. Never raises."""
    try:
        _current_write_origin.reset(token)
    except ValueError:
        # Token created in a different context (a tool that hopped threads). The
        # ContextVar in *this* context is already whatever it should be, so there
        # is nothing to undo and nothing worth failing a tool call over.
        pass


@contextmanager
def write_origin(origin: str) -> Iterator[str]:
    """Scope a block to ``origin``::

        with write_origin(BACKGROUND_REVIEW):
            await registry.execute("save_skill", params)
    """
    token = set_current_write_origin(origin)
    try:
        yield get_current_write_origin()
    finally:
        reset_current_write_origin(token)


def is_agent_created(origin: str | None) -> bool:
    """True only for writes the agent made autonomously, i.e. curator-eligible.

    Anything else — a foreground write, a user write, a missing or unrecognised
    tag on an old record — is user-owned and off-limits to autonomous curation.
    """
    return origin == BACKGROUND_REVIEW
