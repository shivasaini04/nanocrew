"""Browser automation tool using Playwright."""

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from nanoagent.agent.tools.base import Tool


class BrowserTool(Tool):
    """Interact with web pages through the shared browser session.

    Use this for JavaScript-heavy sites, form filling, clicking buttons,
    or taking screenshots — things that web_fetch cannot do.
    """

    name = "browser"

    @property
    def required_permission(self):
        from nanoagent.agent.permissions import PermissionMode
        return PermissionMode.DangerFullAccess
    description = (
        # NEVER say "headless" here, and never claim it has no session.
        #
        # It said "Control a headless browser" until 2026-09-06, which stopped being true
        # when this tool moved onto EffectorSession: on the user-browser lane it drives a
        # real Chrome on the user's own machine, signed into their sites. The description
        # is the agent's only account of what the tool IS, so it reasoned from it exactly
        # as it should have — sitting on a logged-in LinkedIn feed it reported "remote
        # headless browser lacks user's session" and gave up, twice, with the page it
        # needed on screen.
        #
        # Which browser this actually is depends on the run and is decided by the
        # orchestrator, so the description says what is true either way and leaves the
        # rest to the per-cycle note (nanobot-cycle-runner.ts browserLaneNote).
        "Control a real web browser. It may be the browser on the user's own machine, "
        "already signed in to their sites — do not assume you are logged out, and do not "
        "ask for credentials; look at the page first. "
        "Actions: navigate (go to URL), click (click element), "
        "type (fill input field), screenshot (capture page), get_text (get visible text), "
        "evaluate (run JavaScript)."
    )
    parameters = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["navigate", "click", "type", "screenshot", "get_text", "evaluate"],
                "description": "Browser action to perform",
            },
            "url": {
                "type": "string",
                "description": "URL to navigate to (for 'navigate' action)",
            },
            "selector": {
                "type": "string",
                "description": "CSS selector or text to find element (for 'click' and 'type' actions)",
            },
            "text": {
                "type": "string",
                "description": "Text to type (for 'type' action)",
            },
            "script": {
                "type": "string",
                "description": "JavaScript to evaluate (for 'evaluate' action)",
            },
            "filename": {
                "type": "string",
                "description": "Screenshot filename (for 'screenshot' action, default: screenshot.png)",
            },
            "identity": {
                "type": "string",
                "enum": ["anonymous", "me"],
                "description": (
                    "Whose browser. 'anonymous' (default) is a clean browser with no "
                    "connection to the user — right for reading public pages, and the only "
                    "safe choice at volume. 'me' is the user's own signed-in browser: use "
                    "it only when being them is the point (their inbox, their feed, "
                    "something you will send). Reading in bulk as 'me' is how an account "
                    "gets flagged."
                ),
            },
        },
        "required": ["action"],
    }

    def __init__(self, workspace: Path | None = None, require_approval: bool = True):
        self._workspace = workspace or Path("/workspace/group")
        # Exposed for the same reason EffectorTool exposes it — so a test can drive the
        # mechanics without an approval round trip — and NOT so production can turn it
        # off. The default is on and loop.py never passes it.
        self._require_approval = require_approval
        self._session = None
        self._page = None
        # Set from the first navigate, so cookies are reused per site the way effector
        # does it rather than starting cold on every tool call.
        self._session_domain: str | None = None
        # Which lane the cached session was opened for. The session is reused across
        # calls, so switching identity mid-task has to close it — otherwise the first
        # call decides the lane for every call after it, which is exactly the
        # tool-decides-the-lane bug the EffectorSession move was meant to end.
        self._session_identity: str | None = None

    async def _ensure_browser(self, identity: str = "anonymous"):
        """Open a browser through the shared session, lazily.

        This used to launch its own headless Chromium with a hardcoded user agent — a
        second browser stack that knew nothing about lanes, stealth, saved sessions or the
        residential proxy. Everything effector had, this did not, and the difference was
        invisible: the same agent on the same run got a different browser depending on
        which tool the model happened to reach for.

        Going through EffectorSession is the whole fix. The lane, the stealth engine, the
        cookie reuse and the proxy are decided in one place for every caller, and this tool
        stops being an exception to them.
        """
        identity = str(identity or "anonymous").lower()

        if self._page is not None:
            if self._session_identity == identity:
                return
            # A different lane was asked for than the one that is open. Close it: reusing
            # it would silently answer the wrong browser.
            await self._close_browser()

        from nanoagent.agent.effector import EffectorSession

        # allow_remote follows the IDENTITY the caller asked for, not the tool.
        #
        # None means "as the orchestrator decided" — the user's browser on an opted-in
        # run. False keeps the session in the container even on such a run, which is what
        # anonymous work needs and what the default therefore is. Before this, an opted-in
        # run put EVERY browser call on the user's own Chrome, so a sweep of a few hundred
        # public pages went out from their signed-in account.
        self._session = EffectorSession(
            self._workspace,
            session_domain=self._session_domain,
            allow_remote=None if identity == "me" else False,
        )
        self._session_identity = identity
        await self._session.__aenter__()
        self._page = self._session.page

    async def _close_browser(self):
        """Close the session. Safe on a path that runs twice."""
        session, self._session, self._page = self._session, None, None
        self._session_identity = None
        if session is None:
            return
        try:
            await session.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            # A browser that has already gone is not a reason to fail the tool call that
            # was only tidying up after itself.
            pass

    def _as_effector_step(self, action: str, kwargs: dict[str, Any]):
        """Express a browser action as the Step the escalation gate understands.

        The mapping is deliberate rather than approximate — `evaluate` becomes
        `browser_exec`, so a script here is judged by exactly the same
        SCRIPT_DANGER_PATTERN that gates effector's own escape hatch. One policy, not
        two that drift.

        `screenshot` and `get_text` return None: they read and cannot change anything,
        and a gate that fires on reads is a gate people learn to approve without looking.
        """
        from nanoagent.agent.effector.types import Step

        if action == "click":
            return Step(step=1, action="click", target=str(kwargs.get("selector") or ""))
        if action == "type":
            return Step(step=1, action="type", target=str(kwargs.get("selector") or ""),
                        text=str(kwargs.get("text") or ""))
        if action == "navigate":
            return Step(step=1, action="navigate", url=str(kwargs.get("url") or ""))
        if action == "evaluate":
            return Step(step=1, action="browser_exec", script=str(kwargs.get("script") or ""))
        return None

    async def _gate(self, action: str, kwargs: dict[str, Any]) -> str | None:
        """The refusal message, or None if this action may proceed.

        ## Why this exists

        Found by a real agent run, 2026-09-02. An agent was asked to click a button
        labelled "Delete all records". It tried `effector`, whose danger gate correctly
        refused (destructive, no human present). It then switched to THIS tool, hit the
        page's `confirm()`, **overrode `window.confirm` to return true via `evaluate`**,
        clicked again, and completed the deletion.

        Nothing adversarial happened — the model was routing around a blocker to finish
        its task, which is the third time this codebase has seen that shape.
        `escalation.py` records the other two (a blocked click became a `navigate`; a
        blocked click became Enter-on-the-form). Both of those were one action stepping
        around another. This one was one TOOL stepping around another, which is worse:
        it meant the danger gate was a property of `effector` rather than of the system,
        and this tool has `evaluate` — arbitrary JavaScript — with nothing in front of it.

        Same gate, same patterns, same fail-safe. `request_approval` denies when there is
        no cycle token to ask a human through, so an unattended agent cannot delete
        anything here either.
        """
        step = self._as_effector_step(action, kwargs)
        if step is None or not self._require_approval:
            return None

        from nanoagent.agent.effector.escalation import is_approved, is_dangerous, request_approval

        # Give the gate the element's own words before asking it.
        #
        # Without this the gate sees only a CSS selector. `#del` contains no dangerous
        # word, so a click on a button labelled "Delete all records" would sail through
        # here while effector — which expands its @ref into the element's accessible
        # name (danger_haystack) — refuses the identical click. A gate that is weaker on
        # the ungated tool is not a fix; it is the same hole with a smaller entrance.
        #
        # Best-effort by construction: a selector that matches nothing, a detached node,
        # or a page mid-navigation all fall back to selector-only, which is exactly the
        # behaviour before this line existed.
        if step.action in ("click", "type") and step.target:
            try:
                label = await self._page.evaluate(
                    """(sel) => {
                        const el = document.querySelector(sel);
                        if (!el) return '';
                        return [el.innerText, el.value, el.getAttribute('aria-label'),
                                el.getAttribute('title'), el.getAttribute('name')]
                            .filter(Boolean).join(' ').slice(0, 200);
                    }""",
                    step.target,
                )
                if isinstance(label, str) and label.strip():
                    step.description = label.strip()
            except Exception:
                pass

        if not is_dangerous(step):
            return None

        # Stage 60 phase 3: a send on the user's own browser that is part of a list the
        # person already approved does not ask again — same rule as effector's gate.
        if self._session_identity == "me":
            from nanoagent.agent.effector import batch_approval

            haystack = " ".join(filter(None, [step.description, step.target, step.text]))
            if batch_approval.consume(getattr(self._page, "url", "") or "", haystack) is not None:
                return None

        agent_id = os.environ.get("AGENT_ID", "unknown")
        run_id = os.environ.get("CYCLE_ID", "browser-tool")
        decision = await request_approval(step, agent_id, run_id, self._page)
        # Fail closed — see escalation.is_approved.
        if not is_approved(decision):
            return (
                f"The escalation gate blocked this {action} ({decision}). "
                f"This is the same gate the effector tool uses; switching tools does not "
                f"bypass it. Ask the human directly, or choose a non-destructive route."
            )
        return None

    def _note_domain(self, url: str) -> None:
        """Remember the site, so the session reuses its cookies.

        Set before the session opens rather than after: EffectorSession keys saved cookies
        by domain at construction, so learning it afterwards would mean every first
        navigation started logged out.
        """
        if self._session_domain or not url:
            return
        try:
            from urllib.parse import urlparse
            host = urlparse(url if "://" in url else f"https://{url}").hostname or ""
            if host:
                self._session_domain = host.removeprefix("www.")
        except Exception:  # noqa: BLE001
            pass

    async def execute(self, action: str, **kwargs: Any) -> str:
        """Execute a browser action."""
        try:
            # Before the session opens: cookies are keyed by domain at construction, so a
            # domain learned afterwards would mean every first navigation started cold.
            if action == "navigate":
                self._note_domain(str(kwargs.get("url") or ""))

            # Stage 60 phase 1: the operator's browser picker, when used, decides.
            from nanoagent.agent.tools.browser_lane import not_connected_message, resolve_identity

            identity = resolve_identity(kwargs.get("identity"))
            if identity == "me":
                from nanoagent.agent.effector.remote_page import RemoteConfig

                if RemoteConfig.from_env() is None:
                    # Say so instead of quietly doing it as nobody — the same rule
                    # effector applies. Falling back is not a smaller version of "act as
                    # the user"; it is a different action that looks like it worked.
                    return json.dumps({"error": not_connected_message()})

            await self._ensure_browser(identity)

            # Before dispatch, not inside each handler: escalation.py's own docstring
            # records that this gate was once installed somewhere the real path never
            # went. One choke point is the only version that stays true.
            refusal = await self._gate(action, kwargs)
            if refusal:
                return refusal

            if action == "navigate":
                return await self._navigate(kwargs.get("url", ""))
            elif action == "click":
                return await self._click(kwargs.get("selector", ""))
            elif action == "type":
                return await self._type(kwargs.get("selector", ""), kwargs.get("text", ""))
            elif action == "screenshot":
                return await self._screenshot(kwargs.get("filename", "screenshot.png"))
            elif action == "get_text":
                return await self._get_text(kwargs.get("selector") or "")
            elif action == "evaluate":
                return await self._evaluate(kwargs.get("script", ""))
            else:
                return f"Unknown action: {action}"

        except RuntimeError as e:
            return f"Browser error: {e}"
        except Exception as e:
            return f"Browser error ({type(e).__name__}): {e}"

    def _remote(self):
        """The page when it is the user's own browser (RemotePage), else None.

        Stage 60 live test, 2026-09-17: every action here used Playwright calls the remote
        lane refuses (`evaluate`, `get_by_text`, `click(selector)`), so on "This computer"
        the tool failed on its first navigate and the agent had nothing else to try. The
        remote lane has its own ways to do each of these; the branches below use them.
        """
        try:
            from nanoagent.agent.effector.remote_page import RemotePage
        except Exception:  # noqa: BLE001
            return None
        return self._page if isinstance(self._page, RemotePage) else None

    async def _remote_locator(self, remote, selector: str, fallback_key: str):
        """A CSS locator, or — when the selector matches nothing — the text/placeholder one."""
        loc = await remote.locator(selector)
        try:
            if await loc.count() > 0:
                return loc
        except Exception:  # noqa: BLE001
            pass
        return remote.locate({fallback_key: selector, "exact": False})

    async def _navigate(self, url: str) -> str:
        """Navigate to a URL and return page info."""
        if not url:
            return "Error: 'url' parameter is required for navigate action"

        remote = self._remote()
        if remote is not None:
            try:
                await remote.goto(url)
                text = (await remote.nc_text()).strip()
                if len(text) > 3000:
                    text = text[:3000] + "\n... (truncated)"
                return json.dumps({"url": remote.url, "title": await remote.title(), "text": text}, ensure_ascii=False)
            except Exception as e:  # noqa: BLE001
                return f"Navigation error: {e}"

        try:
            response = await self._page.goto(url, wait_until="domcontentloaded", timeout=30000)
            title = await self._page.title()

            # Get visible text content (truncated to save tokens)
            text = await self._page.evaluate(
                "() => document.body ? document.body.innerText.substring(0, 5000) : ''"
            )
            text = text.strip()
            if len(text) > 3000:
                text = text[:3000] + "\n... (truncated)"

            return json.dumps({
                "status": response.status if response else "unknown",
                "url": self._page.url,
                "title": title,
                "text": text,
            }, ensure_ascii=False)
        except Exception as e:
            return f"Navigation error: {e}"

    async def _click(self, selector: str) -> str:
        """Click an element by CSS selector or by text content."""
        if not selector:
            return "Error: 'selector' parameter is required for click action"

        remote = self._remote()
        if remote is not None:
            try:
                loc = await self._remote_locator(remote, selector, "text")
                await loc.first().click(timeout=5)
                return f"Clicked element: {selector}"
            except Exception as e:  # noqa: BLE001
                return f"Click error: {e}"

        try:
            # Try CSS selector first
            try:
                await self._page.click(selector, timeout=5000)
                return f"Clicked element: {selector}"
            except Exception:
                pass

            # Fall back to clicking by visible text
            el = self._page.get_by_text(selector, exact=False).first
            await el.click(timeout=5000)
            return f"Clicked element with text: {selector}"
        except Exception as e:
            return f"Click error: {e}"

    async def _type(self, selector: str, text: str) -> str:
        """Type text into an input field."""
        if not selector:
            return "Error: 'selector' parameter is required for type action"
        if not text:
            return "Error: 'text' parameter is required for type action"

        remote = self._remote()
        if remote is not None:
            try:
                loc = await self._remote_locator(remote, selector, "placeholder")
                await loc.first().fill(text, timeout=5)
                return f"Typed '{text}' into {selector}"
            except Exception as e:  # noqa: BLE001
                return f"Type error: {e}"

        try:
            # Try CSS selector first
            try:
                await self._page.fill(selector, text, timeout=5000)
                return f"Typed '{text}' into {selector}"
            except Exception:
                pass

            # Fall back to placeholder or label text
            el = self._page.get_by_placeholder(selector).first
            await el.fill(text, timeout=5000)
            return f"Typed '{text}' into field: {selector}"
        except Exception as e:
            return f"Type error: {e}"

    async def _screenshot(self, filename: str) -> str:
        """Take a screenshot and save it to workspace."""
        try:
            if not filename.endswith((".png", ".jpg", ".jpeg")):
                filename += ".png"

            filepath = self._workspace / filename
            remote = self._remote()
            if remote is not None:
                filepath.write_bytes(await remote.screenshot())
                return f"Screenshot saved to {filepath}"
            await self._page.screenshot(path=str(filepath), full_page=False)
            return f"Screenshot saved to {filepath}"
        except Exception as e:
            return f"Screenshot error: {e}"

    async def _get_text(self, selector: str = "") -> str:
        """Get visible text content of the current page, or of one CSS selector."""
        remote = self._remote()
        if remote is not None:
            try:
                await remote.refresh_info()
                if selector:
                    # Agents pass a selector to read one section (e.g. a profile's About);
                    # it used to be ignored and the whole page came back instead.
                    found = await remote.nc_extract_selectors([selector])
                    text = (found.get(selector) or "").strip()
                    if not text:
                        return json.dumps({"url": remote.url, "selector": selector, "text": "", "note": "no element matched that selector"}, ensure_ascii=False)
                else:
                    text = (await remote.nc_text()).strip()
                if len(text) > 5000:
                    text = text[:5000] + "\n... (truncated)"
                return json.dumps({"url": remote.url, "title": await remote.title(), "text": text}, ensure_ascii=False)
            except Exception as e:  # noqa: BLE001
                return f"Get text error: {e}"
        try:
            title = await self._page.title()
            text = await self._page.evaluate(
                "() => document.body ? document.body.innerText.substring(0, 8000) : ''"
            )
            text = text.strip()
            if len(text) > 5000:
                text = text[:5000] + "\n... (truncated)"

            return json.dumps({
                "url": self._page.url,
                "title": title,
                "text": text,
            }, ensure_ascii=False)
        except Exception as e:
            return f"Get text error: {e}"

    async def _evaluate(self, script: str) -> str:
        """Evaluate JavaScript on the page."""
        if not script:
            return "Error: 'script' parameter is required for evaluate action"

        remote = self._remote()
        if remote is not None:
            # The desktop app and companion run a supplied script in an isolated world
            # (page.probe); the extension cannot (MV3 CSP) and says so.
            if not getattr(remote, "has_locators", False):
                return "JavaScript error: evaluate is not available on the browser extension lane"
            src = script.strip()
            if not (src.startswith("(") or src.startswith("function") or src.startswith("async")):
                src = f"() => ({src})"
            try:
                frames = await remote._dispatch("page.probe", {"script": src})
                result = (frames or [{}])[0].get("result")
                if isinstance(result, (dict, list)):
                    return json.dumps(result, ensure_ascii=False, indent=2)
                return str(result) if result is not None else "(no return value)"
            except Exception as e:  # noqa: BLE001
                return f"JavaScript error: {e}"

        try:
            result = await self._page.evaluate(script)
            if isinstance(result, (dict, list)):
                return json.dumps(result, ensure_ascii=False, indent=2)
            return str(result) if result is not None else "(no return value)"
        except Exception as e:
            return f"JavaScript error: {e}"
