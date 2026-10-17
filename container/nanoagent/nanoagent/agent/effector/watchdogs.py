"""Two things that watch the browser, because until now only the loop did.

stage45 gap F. `01-gaps.md` named the two holes and `03-browser-use-teardown.md`
named the thing not to build:

> Skip the full `bubus` event bus. It is the right architecture at their scale; for us
> it is a rewrite of `react_loop.py` for a benefit we can get with two targeted
> watchdogs.

browser-use runs fourteen watchdogs on an event bus. This module is two plain objects
the session owns. No bus, no subscriptions, no rewrite of the loop — each one records
what it saw, and the loop asks.

## 1. Crash — the checkpoint machinery had no trigger

`resilience/checkpoint.py` can already resume an interrupted run. Nothing detected a
crash to interrupt it *with*, so a browser that died mid-task surfaced as an ordinary
snapshot failure, and the loop's handler persists those as `status="failed"`.

That status is the problem, and it is worth being precise about why:

    list_interrupted_checkpoints() -> status in ("running", "paused", "takeover")

`"failed"` is not in that list. So a crash — the one failure a resume was built for —
put the run into the single status that makes it unresumable. The recovery machinery
was complete and unreachable, which is the shape `CLAUDE.md` catalogues.

This watchdog gives the loop a way to ask "did the browser die, or did this page just
misbehave?", so the answer can decide the status. It does **not** relaunch anything: a
new browser means a new page object, a fresh context and lost in-page state, and every
caller holding the old `page` would be pointing at a corpse. Resume is the existing
answer to that and it already works.

## 2. Dialogs — the loop saw "the page didn't change"

The old handler dismissed every `confirm()` / `prompt()` / `beforeunload`, and its own
docstring was honest that this was a placeholder:

> Routing this through the real human-escalation round trip (like the click/
> select_combobox danger gate) is real future work, not delivered here — this pass is
> visibility + a safe default, not full escalation for dialogs.

Two things were missing, and only one of them is "escalation".

**Visibility.** A dismissed `confirm()` cancels the action that raised it. The loop then
sees a page that simply did not change, with nothing anywhere saying a dialog happened —
so the model retries the same click and gets the same silent nothing. Every dialog is
now recorded and handed to the model on the turn it happened.

**A reviewed way to say yes.** The old docstring's reasoning is exactly right: there is
no reviewed decision behind an accept, so dismiss is the only safe default. The fix is
to create such a decision rather than to weaken the default.

### Why the accept is pre-armed rather than escalated in the handler

The obvious design — call `request_approval` from inside the dialog handler — does not
work, and it is worth writing down so nobody tries it twice. **A JS dialog blocks the
page until it is answered**, and the Playwright call that triggered it does not return
until then. `escalation._MAX_WAIT_S` is thirty minutes. Escalating inside the handler
would hang the step, the turn and the run, holding a blocked page for half an hour to
ask a question the human may never answer.

So intent is declared *before* the action instead: a step carries `accept_dialog=True`,
which arms this watchdog for exactly that step. And because "accept the confirmation"
is precisely the consequential half of a destructive action, `escalation.is_dangerous`
treats an armed step as dangerous — so the human approves "click Delete **and** confirm
it" as one reviewed decision, through the gate that already exists, before anything
runs. That is what the old docstring was asking for; it just could not live in the
handler.

`alert()` is unchanged: it has no confirm/cancel semantics, so accepting merely closes
it.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

# A page that opens dialogs in a loop should not grow the record without bound. The
# model only ever sees the ones from the current step; this caps what the session holds.
_MAX_DIALOG_RECORDS = 200


@dataclass
class DialogRecord:
    """One JS dialog, and what was done about it."""

    type: str            # "alert" | "confirm" | "prompt" | "beforeunload"
    message: str
    action: str          # "accepted" | "dismissed"
    armed: bool = False  # whether an approved step had pre-armed the accept
    at: float = field(default_factory=time.monotonic)

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "message": self.message[:500],
            "action": self.action,
            "armed": self.armed,
        }


class DialogWatchdog:
    """Handles JS dialogs, records them, and honours a pre-armed accept.

    One per session, attached to every page including popups — a dialog from an OAuth
    popup is as blocking as one from the main tab.
    """

    def __init__(self) -> None:
        self._records: list[DialogRecord] = []
        self._armed: bool = False
        # Read by the loop to show only what happened during the step just executed,
        # rather than re-showing every dialog of the run on every turn.
        self._drained_to: int = 0

    # ── arming ───────────────────────────────────────────────────────────────

    def arm(self) -> None:
        """Accept the next consequential dialog instead of dismissing it.

        Only ever called for a step carrying `accept_dialog=True`, which
        `escalation.is_dangerous` treats as dangerous — so by the time this runs, a
        human has approved it or the run is unattended and it was denied.
        """
        self._armed = True

    def disarm(self) -> None:
        """Drop the arming. Called after the step whether or not a dialog appeared, so
        an armed accept can never leak into a later, unreviewed step."""
        self._armed = False

    @property
    def armed(self) -> bool:
        return self._armed

    # ── handling ─────────────────────────────────────────────────────────────

    async def handle(self, dialog: Any) -> None:
        """The `page.on("dialog")` callback. Never raises — a dialog handler that
        throws leaves the page blocked forever."""
        try:
            dialog_type = getattr(dialog, "type", "unknown")
            message = getattr(dialog, "message", "") or ""

            if dialog_type == "alert":
                # Nothing to decide: there is no cancel semantic, so accepting is just
                # closing it.
                await dialog.accept()
                self._record(dialog_type, message, "accepted", armed=False)
                logger.debug(f'effector: accepted an alert — "{message[:120]}"')
                return

            if self._armed:
                await dialog.accept()
                self._record(dialog_type, message, "accepted", armed=True)
                logger.info(
                    f'effector: accepted a {dialog_type} dialog — the step was approved '
                    f'with accept_dialog — "{message[:120]}"'
                )
                return

            await dialog.dismiss()
            self._record(dialog_type, message, "dismissed", armed=False)
            logger.warning(
                f'effector: dismissed a {dialog_type} dialog (nothing reviewed an accept) — '
                f'"{message[:120]}"'
            )
        except Exception as err:
            # Playwright raises here if the dialog was already handled or the page went
            # away. Both are survivable; a raise out of this callback is not.
            logger.debug(f"effector: dialog handling failed — {err}")

    def _record(self, dialog_type: str, message: str, action: str, armed: bool) -> None:
        self._records.append(
            DialogRecord(type=dialog_type, message=message, action=action, armed=armed)
        )
        if len(self._records) > _MAX_DIALOG_RECORDS:
            # Drop from the front; the newest are the ones anyone acts on.
            dropped = len(self._records) - _MAX_DIALOG_RECORDS
            self._records = self._records[dropped:]
            self._drained_to = max(0, self._drained_to - dropped)

    # ── reporting ────────────────────────────────────────────────────────────

    def drain(self) -> list[DialogRecord]:
        """Dialogs since the last drain. The loop calls this after each step, so the
        model is told about a dialog on the turn it happened rather than never."""
        new = self._records[self._drained_to:]
        self._drained_to = len(self._records)
        return new

    def records(self) -> list[DialogRecord]:
        return list(self._records)


class CrashWatchdog:
    """Notices when the browser dies, so a failure can be told apart from a crash.

    Attached to whatever of page / context / browser is available — the events differ
    by object and by engine, and a missing one is not an error:

        page.on("crash")            the renderer died; the page object is a corpse
        page.on("close")            the tab went away underneath us
        context.on("close")         the context was torn down
        browser.on("disconnected")  the browser process is gone
    """

    def __init__(self) -> None:
        self._reason: str | None = None
        self._attached_to: list[str] = []
        # (object, event, handler) for everything this watchdog wired, so detach() can
        # take it back off. Only the browser genuinely needs it — page and context are
        # thrown away with the run — but a browser is now POOLED across runs
        # (browser_pool.py), and a listener added per run and never removed is a leak
        # that grows for as long as the daemon lives.
        self._bindings: list[tuple[Any, str, Any]] = []

    @property
    def crashed(self) -> bool:
        return self._reason is not None

    @property
    def reason(self) -> str | None:
        return self._reason

    @property
    def attached_to(self) -> list[str]:
        """Which event sources were actually wired. Empty means this watchdog is
        decorative — worth being able to see rather than assume, since a session whose
        crash detection silently attached to nothing looks identical to one that never
        crashed."""
        return list(self._attached_to)

    def attach(self, *, page: Any = None, context: Any = None, browser: Any = None) -> int:
        """Wire up whichever objects were given. Returns how many events were bound."""
        bound = 0
        for obj, events, label in (
            (page, ("crash", "close"), "page"),
            (context, ("close",), "context"),
            (browser, ("disconnected",), "browser"),
        ):
            if obj is None:
                continue
            on = getattr(obj, "on", None)
            if not callable(on):
                continue
            for event in events:
                handler = self._make_handler(f"{label}.{event}")
                try:
                    on(event, handler)
                except Exception as err:  # pragma: no cover - engine-dependent
                    logger.debug(f"effector: could not watch {label}.{event} — {err}")
                    continue
                self._attached_to.append(f"{label}.{event}")
                self._bindings.append((obj, event, handler))
                bound += 1
        return bound

    def detach(self) -> int:
        """Remove every listener this watchdog added. Returns how many came off.

        Needed because a pooled browser outlives the session that borrowed it: without
        this, run 25 finds 25 `disconnected` handlers on the same browser, 24 of them
        belonging to watchdogs nobody will ever read again.
        """
        removed = 0
        for obj, event, handler in self._bindings:
            remove = getattr(obj, "remove_listener", None) or getattr(obj, "off", None)
            if not callable(remove):
                continue
            try:
                remove(event, handler)
            except Exception as err:  # pragma: no cover - engine-dependent
                logger.debug(f"effector: could not unwatch {event} — {err}")
                continue
            removed += 1
        self._bindings.clear()
        self._attached_to.clear()
        return removed

    def _make_handler(self, source: str):
        def _handler(*_args: Any) -> None:
            # First one wins: a crash cascades (renderer dies -> page closes -> context
            # closes) and the first event is the one that describes what happened.
            if self._reason is None:
                self._reason = source
                logger.warning(f"effector: the browser went away — {source}")

        return _handler

    def note(self, reason: str) -> None:
        """Record a crash observed some other way — an exception whose text is
        unmistakable. See `looks_like_a_dead_browser`."""
        if self._reason is None:
            self._reason = reason


# Playwright's own words when the object underneath is gone. Checked against an
# exception's text as a second opinion, because an event can be missed (a handler
# registered after the fact, an engine that does not emit it) while the very next call
# still fails with one of these — and mistaking a dead browser for a bad page is what
# marks a resumable run unresumable.
_DEAD_BROWSER_SIGNS = (
    "target crashed",
    "target closed",
    "browser has been closed",
    "browser closed",
    "connection closed",
    "page has been closed",
    "page closed",
    "context or browser has been closed",
    "websocket error",
    "browser.disconnected",
)


def looks_like_a_dead_browser(err: BaseException | str) -> bool:
    """Whether this exception says the browser is gone rather than the page is awkward.

    Deliberately a string match, and deliberately narrow. Playwright raises the same
    `Error` type for a missing selector and a dead browser, so the text is the only
    signal available without importing Playwright's internals into a module that must
    import cleanly without it.
    """
    text = str(err).lower()
    return any(sign in text for sign in _DEAD_BROWSER_SIGNS)
