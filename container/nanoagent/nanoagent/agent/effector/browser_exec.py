"""The escape hatch — running JavaScript the fixed vocabulary cannot express.

stage45 gap D. Effector's action list is closed: every novel widget has been a change
to `types.py` and `executor.py` shipped through a container rebuild. `select_combobox`
exists *because* the vocabulary was too small — it was added on 2026-08-23 to fix
"typed but never clicked the option" against one site. That is the fixed-vocabulary tax
being paid one action at a time.

This is the cheap version of the bet browser-use made with CLI 3.0 (the agent writes
code instead of picking from a menu) and the same hatch Hermes exposes as
`browser_console`. It is deliberately *only* the cheap version: JS in the page, not raw
CDP passthrough, and not a persistent agent-written helper library. See "What this is
not" below.

## The two worlds, and why isolated is the default

`world="isolated"` (default) runs through `Page.createIsolatedWorld` — the same
mechanism perception already uses. It sees the real DOM and is invisible to page
telemetry and prototype traps, which is why every snapshot goes through it.

`world="main"` runs in the page's own context. It is a real capability rather than a
footgun to be discouraged: an isolated world **cannot see the page's JS globals**, so
`window.__NEXT_DATA__`, a framework's store, or a widget's own method are unreachable
from it. Reading exactly that state is a large share of why this hatch exists, so main
is available — by asking for it, not by default.

## Why this goes through the danger gate

There is a bypass here that this repo has already been bitten by twice, in the same
shape both times. `escalation.py` records them: a model blocked from clicking "Submit"
navigated to the same destination instead (2026-08-27), and a model blocked from
clicking pressed Enter on the form instead (also 2026-08-27, test 1.3). Neither was a
targeted exploit — the model simply found the verb the gate did not look at.

`document.querySelector('#delete-account').click()` is the third instance of that
shape, and it would be the widest: one action that can express every other action.
So `is_dangerous` reads the script, and the primitives that *act on the world or move
data off the page* are gated exactly as the equivalent click would be:

  - activation:  `.click(`, `.submit(`, `requestSubmit`
  - navigation:  assigning `location`, `location.assign/replace`, `window.open`
  - egress:      `fetch(`, `XMLHttpRequest`, `sendBeacon`, `WebSocket`
  - credentials: `document.cookie`

Reading the page is free. That line is deliberate: a gate that fires on every exec is a
gate everyone learns to approve without reading, which is the failure
`capability_manifest.py`'s docstring describes for warnings. `SCRIPT_DANGER_PATTERN` is
the whole list, and it is meant to be read and argued with rather than grown by reflex.

**This is a speed bump, not a sandbox.** JS is not statically analysable and the list
above is trivially evadable by anyone trying (`el['cl'+'ick']()`). It is sized for the
realistic threat — a model that has been talked into something by page content, taking
the obvious route — not for an adversary with code execution, who has already won by
the time they can choose the script. The controls that actually hold are elsewhere:
page-initiated `fetch` still goes through the network shield's `page.route` handler and
its egress policy, and the canary guard still aborts the run if control-plane text
turns up in the script.

## What this is not

- **Not raw CDP.** Hermes ships `browser_cdp` alongside `browser_console`; that is a
  much larger surface (`Network.*`, `Emulation.*`, `Page.printToPDF`) and a separate
  decision. Not started, deliberately, rather than half-built.
- **Not a persistent helper library.** browser-use's actual idea is that the agent
  writes helpers into its workspace and they survive the run — their "self-healing".
  Our equivalent would be `synthesis/jit_metaprogrammer.py` pointed at the browser.
  This module makes that possible later; it does not do it.
- **Not available on the remote lane.** MV3's extension CSP forbids building a function
  from a string even in the isolated world, so the user's-own-browser lane cannot carry
  a script it was not shipped with. `remote_page.py` refuses `evaluate` for that reason
  and this inherits the refusal.
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any

from loguru import logger

# A script that runs forever hangs the whole cycle. Playwright's own evaluate has no
# default timeout, and `awaitPromise: true` on the isolated path means a never-settling
# promise waits indefinitely.
DEFAULT_TIMEOUT_S = 15.0
MAX_TIMEOUT_S = 60.0

# `return document.body.innerHTML` is a one-line way to put a megabyte into the next
# prompt. The cap is on the SERIALISED result, and truncation is reported to the model
# rather than silently trimming — a model that cannot tell it got a partial answer will
# reason confidently about the half it received.
MAX_RESULT_CHARS = 20_000

# Scripts longer than this are almost always the model pasting page content back at us
# rather than writing code, and they are the shape an injected page produces.
MAX_SCRIPT_CHARS = 8_000

WORLDS = ("isolated", "main")

# See the module docstring. Read this list; do not grow it by reflex.
SCRIPT_DANGER_PATTERN = re.compile(
    r"""
    \.\s*click\s*\(            # activation: el.click()
  | \.\s*submit\s*\(           #             form.submit()
  | requestSubmit              #             form.requestSubmit()
  | \blocation\s*(?:\.\s*href\s*)?=(?!=)   # navigation: location = / location.href =
  | \blocation\s*\.\s*(?:assign|replace)\s*\(
  | \bwindow\s*\.\s*open\s*\(
  | \bfetch\s*\(               # egress
  | XMLHttpRequest
  | sendBeacon
  | \bnew\s+WebSocket
  | document\s*\.\s*cookie     # credentials
    # Neutralising a confirmation prompt. Added 2026-09-02 after watching a real agent
    # do exactly this: blocked from a destructive click, it overrode window.confirm to
    # return true and clicked again. Replacing the browser's own "are you sure?" is not
    # an incidental side effect of some other goal — it is an attempt to remove a safety
    # prompt, and there is no legitimate reason for an agent to do it.
  | \b(?:window\s*\.\s*)?(?:confirm|alert|prompt)\s*=(?!=)
  | onbeforeunload\s*=(?!=)
    """,
    re.IGNORECASE | re.VERBOSE,
)


class BrowserExecError(Exception):
    """A script that could not be run, or refused before it was."""


def normalise_script(script: str) -> str:
    """Turn what a model actually writes into something evaluate() accepts.

    Three shapes turn up in practice and all three should work, because a hatch that
    demands an exact calling convention gets used wrong and then abandoned:

        document.title                      -> an expression
        return document.title               -> a function body
        () => document.title                -> already a function

    Detection is by leading token only. A bare expression can legitimately contain an
    arrow (`[1,2].map(x => x*2)`), so looking for `=>` anywhere would misread it as an
    already-wrapped function and evaluate the wrong thing.
    """
    s = (script or "").strip()
    if not s:
        raise BrowserExecError("browser_exec needs a script")
    if len(s) > MAX_SCRIPT_CHARS:
        raise BrowserExecError(
            f"script is {len(s)} characters, over the {MAX_SCRIPT_CHARS} limit — "
            f"a script this long is usually page content pasted back, not code"
        )

    if s.startswith("(") or s.startswith("function") or s.startswith("async"):
        return s
    if re.search(r"\breturn\b", s):
        return f"() => {{ {s} }}"
    return f"() => ({s.rstrip(';')})"


def is_dangerous_script(script: str | None) -> bool:
    """Whether this script does something a click would have needed approval for."""
    return bool(script) and bool(SCRIPT_DANGER_PATTERN.search(script))


def _serialise(value: Any) -> tuple[str, bool]:
    """The result as the model will see it, and whether it had to be cut short."""
    try:
        text = json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        text = str(value)
    if len(text) > MAX_RESULT_CHARS:
        return text[:MAX_RESULT_CHARS], True
    return text, False


async def run_script(
    page: Any,
    script: str,
    *,
    world: str = "isolated",
    timeout_s: float | None = DEFAULT_TIMEOUT_S,
    cdp_session: Any = None,
) -> dict[str, Any]:
    """Evaluate `script` against `page` and return a model-facing result dict.

    Raises BrowserExecError for anything the caller should see as a failed step —
    a bad world, a timeout, a script that threw. The executor turns that into a
    StepResult, so a broken script costs one turn and a clear message rather than
    ending the run.
    """
    if world not in WORLDS:
        raise BrowserExecError(f"world must be one of {WORLDS}, not {world!r}")

    timeout = max(0.5, min(float(timeout_s or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S))
    wrapped = normalise_script(script)

    async def _evaluate() -> Any:
        if world == "main":
            # The page's own context — this is the branch that can see window globals.
            return await page.evaluate(wrapped)
        from nanoagent.agent.effector.isolated_world import evaluate_isolated

        return await evaluate_isolated(page, wrapped, cdp_session=cdp_session)

    try:
        value = await asyncio.wait_for(_evaluate(), timeout=timeout)
    except asyncio.TimeoutError as err:
        raise BrowserExecError(
            f"the script did not finish within {timeout:.0f}s — it may be waiting on "
            f"something that never happens; return a value instead of awaiting forever"
        ) from err
    except Exception as err:
        # A NotSupportedOnRemoteLane from the remote page arrives here and its message
        # already explains itself; anything else is a real JS error, which is the most
        # useful thing to hand back to a model that is about to try again.
        raise BrowserExecError(str(err)) from err

    text, truncated = _serialise(value)
    logger.debug(
        f"effector: browser_exec ran in the {world} world, "
        f"{len(wrapped)} chars in, {len(text)} chars out"
    )

    result: dict[str, Any] = {"world": world, "result": text}
    if truncated:
        result["truncated"] = True
        result["note"] = (
            f"the result was cut off at {MAX_RESULT_CHARS} characters — "
            f"return less (a count, a slice, specific fields) rather than a whole page"
        )
    return result
