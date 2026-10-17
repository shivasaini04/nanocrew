"""Post-turn self-improvement fork — ask the agent what it just learned.

Stage 42 #1, the centrepiece, modelled on Hermes Agent's
``agent/background_review.py`` (NousResearch/hermes-agent @ a7cd15e).

When a turn finishes, spawn a restricted review pass over a snapshot of what just
happened and ask: *should any skill or memory be saved or updated?* Whatever it
decides goes straight to the skill and memory stores.

Why this exists
---------------
``self_improve`` already exists as a scheduled **cycle** (``agent-scheduler.ts``),
typically weekly, and it distils memory and rewrites ``IDENTITY.md``. It has never
written a skill, and it works from a summary rather than the trace. So the agent
learns roughly weekly, from a digest of what it did. This is the fast loop: after
each turn, from the actual transcript.

Invariants — the reasons this is safe to run unattended
-------------------------------------------------------
* **Fires once per turn, at the end of** ``_process_message`` — never inside
  ``_run_agent_loop``. That boundary is the whole cost story: ~$0.023 per turn on
  the cheap model, roughly 1% of a daily cap, versus ~$2 per cycle (about triple
  the cycle itself) if it fired per iteration.
* **Restricted tool whitelist.** The fork gets ``save_skill``, ``append_memory``
  and read-only lookups. Everything else is simply not registered, so denial is
  structural rather than a policy check it could argue its way past.
* **Its registry is tagged** ``BACKGROUND_REVIEW``, so everything it writes is
  marked agent-created and becomes the only thing a future curator may touch.
  Skills the user asked for stay user-owned. This is why stage 42 #2 had to land first.
* **Never touches the live conversation.** It works on a copied snapshot, its own
  message list, and its own registry. The main session's history and prompt cache
  are not in play.
* **Failure is silent and total.** Any exception is logged at debug and dropped:
  a turn that already succeeded must not be retroactively failed by its own
  bookkeeping.
* **Off by default** (``NANOAGENT_BACKGROUND_REVIEW=on`` to enable), pending a week
  of measured spend — see the stage 42 doc.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any

from loguru import logger

from nanoagent.agent.tool_origin import BACKGROUND_REVIEW
from nanoagent.agent.tools.registry import ToolRegistry

# How many tool-calling rounds the fork gets. It is answering one narrow question,
# not doing work: enough to look something up and write one or two things, and
# nowhere near enough to wander.
MAX_REVIEW_ITERATIONS = 4

# Cap on the transcript handed to the fork. A long tool-heavy cycle can carry far
# more than the question needs, and the fork pays input tokens for all of it.
MAX_SNAPSHOT_CHARS = 12_000

ENV_FLAG = "NANOAGENT_BACKGROUND_REVIEW"

# How long a caller will wait for in-flight reviews before giving up on them.
#
# This exists because ``spawn`` is fire-and-forget and a cycle's process does not
# outlive its turn. ``asyncio.run`` cancels every pending task the moment ``main()``
# returns, so without an explicit drain the review is killed partway through its
# first or second round and writes nothing — silently, since the cancellation lands
# outside the ``except Exception`` in ``_run``.
#
# The bound matters as much as the wait: a review that hangs must not hold a
# container open. Four rounds on the cheap model at 1024 max_tokens finishes well
# inside this; anything that does not is not worth a cycle's latency.
ENV_DRAIN_TIMEOUT = "NANOAGENT_BACKGROUND_REVIEW_TIMEOUT"
DRAIN_TIMEOUT_SECONDS = 60.0


def drain_timeout() -> float:
    """Configured drain bound in seconds, falling back to the default."""
    raw = os.environ.get(ENV_DRAIN_TIMEOUT, "").strip()
    if raw:
        try:
            value = float(raw)
            if value > 0:
                return value
        except ValueError:
            pass
    return DRAIN_TIMEOUT_SECONDS

REVIEW_PROMPT = """\
You have just finished a turn. Review the transcript above and decide whether \
anything is worth keeping for next time.

Save a SKILL (save_skill) only for a reusable *technique* — a working API call \
sequence, a format that got accepted, a procedure that succeeded after failing. \
Something you would want to re-read before attempting the same class of task again.

Save a MEMORY (append_memory) only for a durable *fact* — a verified detail about \
the user, the domain, or the environment that will still be true next week.

Most turns are worth neither. That is the expected outcome, and answering \
"nothing worth keeping" is a complete and correct answer. Do not invent a lesson \
to look useful, do not record what merely happened, and do not save anything you \
could not act on later.

If an existing skill is close but wrong, update it with save_skill using its exact \
name rather than adding a near-duplicate.

State briefly what you saved, or that you saved nothing."""


def is_enabled() -> bool:
    """Whether the post-turn review is switched on for this process."""
    return os.environ.get(ENV_FLAG, "").strip().lower() in {"on", "1", "true", "yes"}


def build_snapshot(turn_record: list[dict[str, Any]], limit: int = MAX_SNAPSHOT_CHARS) -> str:
    """Render the turn as a plain transcript, newest content preserved.

    Truncates from the *front*: the end of a turn — the answer, and the tool results
    that produced it — carries most of what is worth learning, while the opening is
    usually setup.
    """
    lines: list[str] = []
    for msg in turn_record or []:
        role = str(msg.get("role", "?"))
        content = msg.get("content")
        if isinstance(content, list):  # structured content blocks
            content = " ".join(
                str(b.get("text", "")) for b in content if isinstance(b, dict)
            )
        content = str(content or "").strip()
        if not content:
            continue
        lines.append(f"[{role}] {content}")
    text = "\n\n".join(lines)
    if len(text) > limit:
        text = "…(earlier turn content trimmed)…\n\n" + text[-limit:]
    return text


def build_review_registry(source: ToolRegistry) -> ToolRegistry:
    """A registry holding only what the fork is allowed to do.

    Denial by omission rather than by policy: a tool that was never registered
    cannot be called, argued for, or reached through a retry.
    """
    allowed = ("save_skill", "append_memory", "search_memory", "skill_search")
    registry = ToolRegistry(write_origin=BACKGROUND_REVIEW)
    for name in allowed:
        tool = source.get(name)
        if tool is not None:
            registry.register(tool)
    return registry


class BackgroundReviewer:
    """Runs the post-turn review against a snapshot, off the turn's critical path."""

    def __init__(self, loop: Any) -> None:
        # Holds the AgentLoop rather than subclassing it: the fork needs the loop's
        # provider, model and tools, but must never be mistaken for the loop itself.
        self._loop = loop
        self._tasks: set[asyncio.Task] = set()
        self._in_flight: set[str] = set()

    def spawn(self, session_key: str, turn_record: list[dict[str, Any]]) -> asyncio.Task | None:
        """Fire the review for a finished turn. Returns the task, or None if skipped."""
        if not is_enabled() or not turn_record:
            return None
        if session_key in self._in_flight:
            # One review per session at a time. A burst of quick turns should not
            # stack forks that would all reach the same conclusion.
            logger.debug("Background review already running for {} — skipping", session_key)
            return None

        snapshot = build_snapshot(turn_record)
        if not snapshot.strip():
            return None

        self._in_flight.add(session_key)
        task = asyncio.create_task(self._run(session_key, snapshot))
        self._tasks.add(task)
        # Strong refs until done — a bare create_task can be garbage-collected
        # mid-flight, the same reason _consolidation_tasks exists.
        task.add_done_callback(self._tasks.discard)
        return task

    @property
    def pending(self) -> int:
        """How many reviews are still in flight."""
        return len(self._tasks)

    async def drain(self, timeout: float | None = None) -> bool:
        """Wait for in-flight reviews to finish. True if they all completed.

        Must be awaited before a process or request that spawned a review goes away.
        A review is a plain background task, so nothing else keeps it alive: in a
        one-shot cycle ``asyncio.run`` cancels it at exit, and in daemon mode the
        next request tears down the MCP stack and provider it is still using. Either
        way the write never lands and nothing says so.

        Overrunning the bound is not an error worth failing a turn over — the turn is
        already answered. The reviews are cancelled and the caller is told, so the
        decision of what to do about it stays with the caller.
        """
        # Snapshot: the done-callback mutates _tasks as reviews finish.
        pending = set(self._tasks)
        if not pending:
            return True

        _, still_running = await asyncio.wait(
            pending, timeout=drain_timeout() if timeout is None else timeout
        )
        if still_running:
            for task in still_running:
                task.cancel()
            # Reap them here so the loop does not close over live tasks and print
            # "Task was destroyed but it is pending!" into a cycle's stderr.
            await asyncio.gather(*still_running, return_exceptions=True)
            logger.debug("Background review: {} still running at drain — cancelled", len(still_running))
            return False
        return True

    async def _run(self, session_key: str, snapshot: str) -> str | None:
        try:
            return await self._review(snapshot)
        except Exception as e:  # noqa: BLE001 — a finished turn must not fail here
            logger.debug("Background review failed for {}: {}", session_key, e)
            return None
        finally:
            self._in_flight.discard(session_key)

    async def _review(self, snapshot: str) -> str | None:
        loop = self._loop
        tools = build_review_registry(loop.tools)
        if not len(tools):
            logger.debug("Background review has no writable tools registered — skipping")
            return None

        messages = [
            {"role": "user", "content": f"Transcript of the turn:\n\n{snapshot}"},
            {"role": "user", "content": REVIEW_PROMPT},
        ]

        model = self._cheap_model()
        final: str | None = None

        for _ in range(MAX_REVIEW_ITERATIONS):
            response = await loop.provider.chat(
                messages=messages,
                tools=tools.get_definitions(),
                model=model,
                temperature=0.0,
                max_tokens=1024,
            )
            if not response.tool_calls:
                final = (response.content or "").strip()
                break

            messages.append({
                "role": "assistant",
                "content": response.content or "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        # ToolCallRequest.arguments is a dict; the wire format wants a
                        # JSON string.
                        "function": {"name": call.name, "arguments": json.dumps(call.arguments)},
                    }
                    for call in response.tool_calls
                ],
            })
            for call in response.tool_calls:
                result = await tools.execute(call.name, call.arguments)
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.id,
                    "content": str(result)[:1000],
                })

        if final:
            logger.info("Background review: {}", final[:200])
        return final

    def _cheap_model(self) -> str | None:
        """The compaction-tier model, or the configured default if unavailable."""
        try:
            router = getattr(self._loop, "_model_router", None)
            if router is not None:
                keys = getattr(self._loop, "_available_keys", {}) or {}
                return router.select("compaction", keys) or self._loop.model
        except Exception:  # noqa: BLE001
            pass
        return self._loop.model
