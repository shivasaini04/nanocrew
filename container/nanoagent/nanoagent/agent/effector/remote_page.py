"""RemotePage — effector's browser, running in the user's own browser.

Wired and live-verified 2026-08-31: a real
cycle reaches a real Chrome through the broker, sees content inside cross-origin frames,
and clicks it with trusted input. EffectorSession builds one of these when — and only
when — the orchestrator opted the run in.

stage45 doc 05, phase 3. This is the object effector's executor and resolver hold instead
of a Playwright ``Page`` when the remote lane is on. Same call sites, same snapshot, same
resolver, same macros — the difference is that the browser is on someone's laptop and is
already signed in.

WHAT IT IMPLEMENTS, AND WHAT IT REFUSES

Effector touches about two dozen members of ``Page``. They split cleanly:

    reproducible over a bridge   url, title, viewport_size, goto, mouse, keyboard,
                                 screenshot, wait_for_timeout
    not reproducible             locator, frame_locator, get_by_role/text/label/placeholder

Playwright's Locator is not a selector string; it is an engine with auto-wait,
actionability checks and retry. Reimplementing it over a WebSocket to a browser extension
would be a second, subtly different engine, and the whole point of this lane is that there
is only one. So the locator members raise, loudly, naming the reason.

Nothing is lost by that, because every element from this lane is ``coordinate_only`` — the
flag stage45 doc 04 phase 2 added for elements in frames we cannot name. The resolver
already skips its locator layers for those and goes straight to the page-absolute
coordinate, and the executor already has coordinate branches for click, type, clear, hover,
right-click, double-click and upload.

THE SNAPSHOT

``capture_dom_snapshot`` normally runs ``_SNAPSHOT_JS`` through ``page.evaluate``. It cannot
here: MV3's extension CSP forbids building a function from a string even in the isolated
world (measured 2026-08-30, docs/research/stage45/spikes/csp_probe.py). The extension
carries the same script — generated from dom_snapshot.py by extension/build_probes.py, not
copied — and the container names it. So this class exposes ``nc_remote_snapshot()`` and
``capture_dom_snapshot`` calls that instead when it is present.
"""

from __future__ import annotations

import asyncio
import base64
import os
from dataclasses import dataclass
from typing import Any

import httpx
from loguru import logger

from nanoagent.agent.effector.types import Bounds, DOMElementNode, DOMSnapshot, Point


class RemoteLaneUnavailable(RuntimeError):
    """No browser is connected for this owner, or the one that was has gone."""


class NotSupportedOnRemoteLane(RuntimeError):
    """A Playwright member this lane deliberately does not reproduce."""


@dataclass
class RemoteConfig:
    host: str
    agent_id: str
    cycle_token: str
    controller_id: str
    browser_profile_id: str = "default"
    timeout_s: float = 45.0

    @classmethod
    def from_env(cls) -> "RemoteConfig | None":
        """Build from the cycle's environment, or None when the lane is not configured.

        Returning None rather than raising is deliberate: "no remote browser" is the
        ordinary case, not an error, and the caller falls back to the container's own
        Chromium.
        """
        controller = os.environ.get("NC_BROWSER_CONTROLLER_ID", "").strip()
        token = os.environ.get("NANOCREW_CYCLE_TOKEN", "").strip()
        agent_id = os.environ.get("AGENT_ID", "").strip()
        host = os.environ.get("NanoCrew_HOST", "").strip() or os.environ.get("NANOCREW_HOST", "").strip()
        if not (controller and token and agent_id and host):
            return None
        return cls(host=host.rstrip("/"), agent_id=agent_id, cycle_token=token, controller_id=controller)


class _RemoteLocator:
    """Playwright's Locator surface, as far as effector uses it, backed by the real one.

    Every method here is one round trip that ends in a genuine Playwright call on the
    companion. That is the difference from the extension lane: nothing about auto-wait,
    actionability or retry is reimplemented here — the real engine runs where the browser
    is, and this object only names what to do and reads back what happened.

    Deliberately narrow. It covers what effector's executor actually calls and no more;
    a wider surface would be more code to keep in step with Playwright for no caller.
    """

    def __init__(self, page: "RemotePage", spec: dict):
        self._page = page
        self._spec = spec

    def _with(self, **extra: Any) -> "_RemoteLocator":
        return _RemoteLocator(self._page, {**self._spec, **extra})

    # ── refinement ───────────────────────────────────────────────────────────

    def nth(self, index: int) -> "_RemoteLocator":
        return self._with(nth=index)

    def first(self) -> "_RemoteLocator":
        return self._with(first=True)

    def last(self) -> "_RemoteLocator":
        return self._with(last=True)

    def filter(self, *, has_text: str | None = None, **_kw: Any) -> "_RemoteLocator":
        return self._with(hasText=has_text) if has_text is not None else self

    # ── reading ──────────────────────────────────────────────────────────────

    async def count(self) -> int:
        res = await self._page._dispatch("locator.query", {"spec": self._spec, "includeText": False})
        return int((res or {}).get("count", 0))

    async def bounding_box(self, **_kw: Any) -> dict | None:
        res = await self._page._dispatch("locator.query", {"spec": self._spec, "includeText": False})
        matches = (res or {}).get("matches") or []
        return matches[0].get("bounds") if matches else None

    async def inner_text(self, timeout: float | None = None, **_kw: Any) -> str:
        res = await self._page._dispatch(
            "locator.act",
            {"spec": self._spec, "action": "text", "timeoutMs": _ms(timeout)},
        )
        return (res or {}).get("text", "")

    async def get_attribute(self, name: str, timeout: float | None = None, **_kw: Any) -> str | None:
        res = await self._page._dispatch(
            "locator.act",
            {"spec": self._spec, "action": "attribute", "value": name, "timeoutMs": _ms(timeout)},
        )
        return (res or {}).get("value")

    async def is_visible(self, **_kw: Any) -> bool:
        res = await self._page._dispatch("locator.query", {"spec": self._spec, "includeText": False})
        matches = (res or {}).get("matches") or []
        return bool(matches and matches[0].get("visible"))

    async def is_enabled(self, **_kw: Any) -> bool:
        res = await self._page._dispatch("locator.query", {"spec": self._spec, "includeText": False})
        matches = (res or {}).get("matches") or []
        return bool(matches and matches[0].get("enabled"))

    # ── acting ───────────────────────────────────────────────────────────────

    async def _act(self, action: str, value: Any = None, timeout: float | None = None,
                   force: bool = False) -> Any:
        return await self._page._dispatch("locator.act", {
            "spec": self._spec,
            "action": action,
            "value": value,
            "timeoutMs": _ms(timeout),
            "force": force,
        })

    async def click(self, timeout: float | None = None, force: bool = False, **_kw: Any) -> None:
        await self._act("click", timeout=timeout, force=force)

    async def dblclick(self, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("dblclick", timeout=timeout)

    async def hover(self, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("hover", timeout=timeout)

    async def fill(self, value: str, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("fill", value=value, timeout=timeout)

    async def press(self, key: str, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("press", value=key, timeout=timeout)

    async def check(self, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("check", timeout=timeout)

    async def select_option(self, value: Any, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("selectOption", value=value, timeout=timeout)

    async def scroll_into_view_if_needed(self, timeout: float | None = None, **_kw: Any) -> None:
        await self._act("scrollIntoView", timeout=timeout)


def _ms(timeout: float | None) -> int:
    """Playwright's Python API takes milliseconds; effector passes seconds in places.

    A value under 1000 is read as seconds — no real timeout is under a second, and the
    two units silently differing by 1000x is the kind of bug that shows up as a flake.
    """
    if timeout is None:
        return 15_000
    return int(timeout if timeout >= 1000 else timeout * 1000)


class _RemoteMouse:
    """page.mouse, as far as effector uses it."""

    def __init__(self, page: "RemotePage"):
        self._page = page
        # Where the pointer last went. Playwright's mouse is stateful in the same way,
        # and `wheel` needs it: a wheel event with no position goes to the document
        # rather than to whatever the user is actually looking at.
        self._x = 0.0
        self._y = 0.0

    async def move(self, x: float, y: float, **_kw: Any) -> None:
        self._x, self._y = x, y
        await self._page._dispatch("input.mouse", {"type": "move", "x": x, "y": y})

    async def click(self, x: float, y: float, button: str = "left", click_count: int = 1, **_kw: Any) -> None:
        self._x, self._y = x, y
        await self._page._dispatch(
            "input.mouse", {"type": "click", "x": x, "y": y, "button": button, "clickCount": click_count}
        )

    async def wheel(self, delta_x: float, delta_y: float) -> None:
        """Scroll, Playwright-shaped, so callers need no lane branch.

        Dispatched at the current pointer position rather than a corner: a wheel event
        goes to whatever is under the pointer, which is how an inner scroll container
        receives it instead of the document. takeover.py probes for this method with
        getattr, so an extension too old to have `input.scroll` degrades to no scroll
        rather than an error.
        """
        await self._page._dispatch("input.scroll", {
            "x": self._x, "y": self._y, "deltaX": delta_x, "deltaY": delta_y,
        })

    async def dblclick(self, x: float, y: float, **_kw: Any) -> None:
        self._x, self._y = x, y
        await self.click(x, y, click_count=2)


class _RemoteKeyboard:
    """page.keyboard, as far as effector uses it."""

    def __init__(self, page: "RemotePage"):
        self._page = page

    async def type(self, text: str, **_kw: Any) -> None:
        # insertText in one call rather than per-character key events: it handles IME,
        # emoji and long values, and it is what a paste looks like to the page.
        await self._page._dispatch("input.key", {"text": text})

    async def press(self, key: str, **_kw: Any) -> None:
        await self._page._dispatch("input.key", {"key": key})

    async def insert_text(self, text: str) -> None:
        await self.type(text)


class RemotePage:
    """Page-shaped, backed by the broker. Construct with ``RemoteConfig``."""

    def __init__(self, config: RemoteConfig):
        self._cfg = config
        self._client = httpx.AsyncClient(timeout=config.timeout_s)
        self._url = "about:blank"
        self._title = ""
        self._viewport = {"width": 1280, "height": 720}
        self.mouse = _RemoteMouse(self)
        self.keyboard = _RemoteKeyboard(self)
        # What the controller on the far end can do (stage 52 step 3). Empty until
        # discover_capabilities() has run, and an EXTENSION lane leaves it without
        # "locator.act" forever — which is exactly what tells the snapshot below whether
        # its elements can be located or must be aimed at by coordinate.
        self._capabilities: set[str] = set()
        # Which document the frame bridge was installed into, and whether that document
        # actually has child frames. Both exist to avoid network hops: on this lane a
        # probe is ~600 ms, so re-installing a bridge into an unchanged page, or asking
        # for frame origins on a page with no frames, is pure latency.
        self._frame_bridge_for: str | None = None
        self._has_child_frames: bool | None = None
        # One command at a time over the bridge.
        #
        # Nothing enforced this while the agent was the only caller, because the ReAct
        # loop is sequential by construction. The live-view refresher (browser_session's
        # _remote_frame_pump) is a second caller on a timer, and the extension attaches
        # and detaches the CDP debugger around input commands — two of those interleaving
        # would have one detach the debugger the other is mid-way through using. The
        # broker correlates replies by id, so concurrency is safe on the wire; it is the
        # single shared browser at the far end that is not.
        self._lock = asyncio.Lock()

    # ── transport ────────────────────────────────────────────────────────────

    async def _dispatch(self, capability: str, payload: dict | None = None) -> Any:
        async with self._lock:
            return await self._dispatch_locked(capability, payload)

    async def _dispatch_locked(self, capability: str, payload: dict | None = None) -> Any:
        url = f"{self._cfg.host}/api/agents/{self._cfg.agent_id}/browser-control/dispatch"
        try:
            res = await self._client.post(
                url,
                headers={"X-Cycle-Token": self._cfg.cycle_token},
                json={
                    "capability": capability,
                    "payload": payload or {},
                    "controllerId": self._cfg.controller_id,
                    "browserProfileId": self._cfg.browser_profile_id,
                },
            )
        except Exception as err:  # noqa: BLE001 — the network is the lane; name it plainly
            raise RemoteLaneUnavailable(f"could not reach the broker: {err}") from err

        if res.status_code == 409:
            # The ordinary "nobody has connected their browser" case, distinguished from a
            # fault so the caller can say something useful to the user.
            raise RemoteLaneUnavailable("no browser is connected for this owner")
        if res.status_code == 401:
            raise RemoteLaneUnavailable("cycle token rejected — the cycle may have ended")
        if res.status_code >= 400:
            raise RemoteLaneUnavailable(f"broker refused {capability}: {res.status_code} {res.text[:200]}")
        body = res.json()
        if not body.get("ok"):
            raise RemoteLaneUnavailable(str(body.get("error") or "unknown broker error"))
        return body.get("result")

    async def close(self) -> None:
        await self._client.aclose()

    # ── the members effector uses ────────────────────────────────────────────

    @property
    def url(self) -> str:
        return self._url

    async def title(self) -> str:
        return self._title

    @property
    def viewport_size(self) -> dict[str, int]:
        return dict(self._viewport)

    @property
    def has_locators(self) -> bool:
        """Can the far end resolve a selector, or must everything be a coordinate?

        False for the extension lane and for any controller whose capabilities have not
        been discovered yet. Defaulting to False is the safe direction: coordinates work
        on every lane, so a wrong answer here degrades aim rather than breaking the run.
        """
        return "locator.act" in self._capabilities

    async def discover_capabilities(self) -> None:
        """Ask the broker what this controller can do. Never raises.

        The broker already knows, so asking costs one request and saves discovering the
        same fact by spending a failed dispatch and its timeout on every action.
        """
        try:
            url = (
                f"{self._cfg.host}/api/agents/{self._cfg.agent_id}/browser-control/status"
                f"?controllerId={self._cfg.controller_id}"
                f"&browserProfileId={self._cfg.browser_profile_id}"
            )
            res = await self._client.get(
                url, headers={"X-Cycle-Token": self._cfg.cycle_token}
            )
            if res.status_code == 200:
                self._capabilities = set(res.json().get("capabilities") or [])
                # Always logged, both ways. Whether locators are available decides whether
                # elements are coordinate_only, which decides how well the agent can work
                # — and when it silently came back False there was no way to tell that
                # from a network failure or a scope mismatch without a rebuild.
                logger.info(
                    f"effector(remote): controller capabilities = "
                    f"{sorted(self._capabilities) or 'NONE'} (locators: {self.has_locators})"
                )
            else:
                logger.warning(
                    f"effector(remote): capability discovery returned HTTP "
                    f"{res.status_code} — assuming no locators, elements stay coordinate-only"
                )
        except Exception as err:  # noqa: BLE001
            # An older orchestrator has no capabilities field, and a network blip is not
            # worth failing a run over. Both mean "assume coordinates", which always works.
            logger.debug(f"effector(remote): could not discover capabilities ({err})")

    async def locator(self, selector: str, **_kw: Any) -> "_RemoteLocator":
        """A locator, when the far end has a real Playwright engine to back it.

        On the extension lane this still raises, and the message is unchanged: MV3 cannot
        run Playwright's Locator and reimplementing it over that bridge would be a second,
        subtly different engine. On the companion lane there is nothing to reimplement —
        the real engine runs there and only the result crosses the wire.
        """
        if not self.has_locators:
            raise NotSupportedOnRemoteLane(
                "page.locator does not exist on the extension lane: Playwright's Locator "
                "is an engine (auto-wait, actionability, retry), not a selector string, "
                "and reimplementing it over the extension bridge would be a second "
                "engine. Use the coordinate path instead — see remote_page.py's module "
                "docstring. A companion controller (companion/) does support locators."
            )
        return _RemoteLocator(self, {"css": selector})

    def locate(self, spec: dict) -> "_RemoteLocator":
        """Locator from a full spec — role, text, label and the rest. See locator.mjs."""
        if not self.has_locators:
            raise NotSupportedOnRemoteLane("this controller cannot resolve locators")
        return _RemoteLocator(self, spec)

    async def refresh_info(self) -> None:
        """Pull url/title/viewport. Called before each snapshot, since all three are read
        as plain attributes downstream and would otherwise go stale after a navigation."""
        info = await self._dispatch("page.info") or {}
        self._url = info.get("url") or self._url
        self._title = info.get("title") or ""
        vp = info.get("viewport") or {}
        if vp.get("width") and vp.get("height"):
            self._viewport = {"width": int(vp["width"]), "height": int(vp["height"])}

    async def goto(self, url: str, **_kw: Any) -> None:
        await self._dispatch("page.navigate", {"url": url})
        # A navigation is not instant and the extension does not wait for load, so give the
        # page a beat before anything reads it. The ReAct loop's own settle step does the
        # rest; this only stops an immediate snapshot catching the previous document.
        await asyncio.sleep(1.0)
        await self.refresh_info()

    async def screenshot(self, **_kw: Any) -> bytes:
        shot = await self._dispatch("page.screenshot") or {}
        data_url = shot.get("dataUrl") or ""
        if "," not in data_url:
            raise RemoteLaneUnavailable("screenshot came back without image data")
        return base64.b64decode(data_url.split(",", 1)[1])

    async def wait_for_timeout(self, ms: float) -> None:
        await asyncio.sleep(ms / 1000.0)

    async def wait_for_load_state(self, *_a: Any, **_kw: Any) -> None:
        # There is no load event to await across the bridge; the loop settles by snapshot.
        await asyncio.sleep(0.3)

    # ── perception ───────────────────────────────────────────────────────────

    async def nc_remote_snapshot(self) -> DOMSnapshot:
        """Assemble a DOMSnapshot from the extension.

        It used to be five calls every turn: refresh, place the frames, re-place them,
        read the origins, snapshot. On this lane every call is a network hop to the
        user's machine — measured 2026-09-21 at roughly 600 ms — so one look at the page
        cost 2–4 s, six times over in a single run.

        What is avoidable is narrower than it first looks. The frame work — install,
        seed, read origins — is only meaningful on a page that HAS child frames. On a
        page with none, ox and oy are zero and all three are round trips to fetch a pair
        of zeros. So once a look has shown there are no child frames, later looks at the
        same document skip all three: six hops become three.

        On a page that DOES have frames, all three run on every look. A first attempt at
        this kept only installFrameBridge per document and still read the origins — and
        the suite caught it: seedFrames is the RE-PLACE step, and phase 0 measured a
        child frame 900 px wrong when the tree was seeded once. Stale origins click in
        the wrong place, which is worse than being slow.

        A frame appearing for the first time has its elements DROPPED rather than placed
        at zero for that one look, and the next look picks it up — the existing rule,
        because a wrong coordinate clicks something real.
        """
        await self.refresh_info()
        document = self.url or ""

        if self._frame_bridge_for != document:
            # A new document tells us nothing about its frames until we have looked.
            self._frame_bridge_for = document
            self._has_child_frames = None

        origins_raw = []
        if self._has_child_frames is not False:
            # Every look, not once per document. seedFrames is the RE-PLACE step, and
            # phase 0 measured a child frame 900 px wrong when the tree was seeded only
            # once — origins are viewport-relative and go stale on any scroll. An
            # earlier version of this optimisation skipped it and kept reading the
            # origins, which would have read stale ones and clicked in the wrong place.
            await self._dispatch("page.probe", {"probe": "installFrameBridge"})
            await self._dispatch("page.probe", {"probe": "seedFrames"})
            origins_raw = await self._dispatch("page.probe", {"probe": "frameOrigin"}) or []
        frames_raw = await self._dispatch("page.probe", {"probe": "snapshot"}) or []
        self._has_child_frames = any(
            f.get("frameId") not in (0, None) for f in frames_raw
        )

        origins = {r.get("frameId"): r.get("result") for r in origins_raw}

        elements: list[DOMElementNode] = []
        dropped = 0
        for frame in frames_raw:
            frame_id = frame.get("frameId")
            raw = frame.get("result") or []
            origin = origins.get(frame_id)
            if origin is None and frame_id not in (0, None):
                # Same rule as the local lane: a frame we cannot PLACE is dropped, never
                # placed at zero. A wrong coordinate clicks something real.
                dropped += len(raw)
                continue
            ox = float((origin or {}).get("x", 0) or 0)
            oy = float((origin or {}).get("y", 0) or 0)
            in_frame = bool(frame_id)

            for el in raw:
                bounds = el.get("bounds", {}) or {}
                center = el.get("center", {}) or {}
                elements.append(DOMElementNode(
                    ref=f"@e{len(elements) + 1}",
                    tag=el.get("tag", ""),
                    role=el.get("role"),
                    name=el.get("name"),
                    value=el.get("value"),
                    placeholder=el.get("placeholder"),
                    type=el.get("type"),
                    selector=el.get("selector", el.get("tag", "")),
                    bounds=Bounds(x=bounds.get("x", 0) + ox, y=bounds.get("y", 0) + oy,
                                  width=bounds.get("width", 0), height=bounds.get("height", 0)),
                    center=Point(x=center.get("x", 0) + ox, y=center.get("y", 0) + oy),
                    is_visible=True,
                    is_enabled=el.get("isEnabled", True),
                    frame_selector=None,
                    frame_bounds=Bounds(x=ox, y=oy, width=0, height=0) if in_frame else None,
                    # Coordinate-only unless the far end can resolve selectors. On the
                    # extension lane there is no Locator engine, so a selector has nothing
                    # to resolve through; on a companion there is a real one, and letting
                    # the resolver use it is the whole point of stage 52 step 3.
                    coordinate_only=not self.has_locators,
                    shadow_host=el.get("shadowHost"),
                    is_occluded=bool(el.get("isOccluded")),
                ))

        if dropped:
            logger.debug(f"effector(remote): dropped {dropped} element(s) in frames that could not be placed")

        from nanoagent.agent.effector.dom_snapshot import build_content_summary, build_summary

        # What the page SAYS, via the same named probe the local lane evaluates inline.
        # Never fatal: an agent with controls and no prose can still act, one with
        # neither cannot.
        content: list[dict] = []
        try:
            frames = await self._dispatch("page.probe", {"probe": "pageContent", "allFrames": False})
            for frame in frames or []:
                res = frame.get("result")
                if isinstance(res, list):
                    content.extend(c for c in res if isinstance(c, dict))
        except Exception as err:  # noqa: BLE001
            logger.debug(f"effector(remote): page content scan failed — {err}")

        summary = build_summary(self._url, self._title, elements)
        content_summary = build_content_summary(content)
        if content_summary:
            summary = summary + "\n\n" + content_summary

        return DOMSnapshot(
            url=self._url,
            title=self._title,
            elements=elements,
            summary=summary,
            viewport=dict(self._viewport),
            content=content,
        )

    # ── text, without a Locator to read it with ─────────────────────────────

    async def nc_probe(self, name: str, args: Any = None) -> list:
        """Run one NAMED probe in the extension. The container chooses which probe and
        what arguments; it cannot send code (MV3 forbids it) — see the module docstring."""
        payload: dict[str, Any] = {"probe": name}
        if args is not None:
            payload["args"] = [args]
        return await self._dispatch("page.probe", payload) or []

    async def nc_extract_selectors(self, selectors: list[str]) -> dict[str, str]:
        """Text for each CSS selector, searched in EVERY frame.

        The longest answer wins when several frames match: a parent whose iframe element
        is empty must not shadow the child that actually holds the text.
        """
        if not selectors:
            return {}
        found: dict[str, str] = {}
        for frame in await self.nc_probe("extractText", {"selectors": selectors}):
            for selector, text in (frame.get("result") or {}).items():
                if text and len(text) > len(found.get(selector, "")):
                    found[selector] = text
        return found

    async def nc_text(self, point: dict | None = None) -> str:
        """Text at a page-absolute point, or the whole page when no point is given."""
        spec = {"point": point} if point else {}
        frames = await self.nc_probe("extractText", spec)
        if not point:
            # The whole page is the TOP frame's text. "Longest frame wins" returned
            # LinkedIn's reCAPTCHA iframe — a script blob longer than the profile — to
            # every get_text on a profile page (live, 2026-09-17, Mechanic cycle
            # 5d4f7703). Other frames are only a fallback for a top frame with no text
            # (a page that is just an iframe shell).
            for frame in frames:
                if frame.get("frameId") == 0:
                    top = ((frame.get("result") or {}).get("body") or "").strip()
                    if top:
                        return top
        best = ""
        for frame in frames:
            result = frame.get("result") or {}
            text = result.get("point") or result.get("body") or ""
            # Deepest frame wins for a point (the top frame returns the iframe element,
            # which is empty across an origin boundary); longest wins for the fallback.
            if len(text) > len(best):
                best = text
        return best

    # ── deliberately absent ──────────────────────────────────────────────────

    def _unsupported(self, name: str):
        raise NotSupportedOnRemoteLane(
            f"page.{name} does not exist on the remote lane: Playwright's Locator is an "
            f"engine (auto-wait, actionability, retry), not a selector string, and "
            f"reimplementing it over the extension bridge would be a second engine. Every "
            f"element from this lane is coordinate_only, so the resolver takes the "
            f"coordinate path instead — see remote_page.py's module docstring."
        )

    def expect_download(self, *_a: Any, **_kw: Any):
        """Downloads do not exist on this lane, and saying so is the point.

        stage45 gap E: the extension's wire vocabulary is four primitives and none of
        them moves a file. A download in the user's own Chrome also lands in the
        *user's* Downloads folder, on their laptop — nowhere the container can read —
        so even a probe that triggered one would leave the agent claiming a file it
        cannot open. Refusing here turns that into one clear message on the turn it is
        attempted, instead of a run that reports success over a file that never
        arrived.
        """
        raise NotSupportedOnRemoteLane(
            "downloads are not available when working in your own browser: the "
            "extension bridge carries no file transport, and a file saved by your "
            "Chrome lands on your machine rather than in the agent's workspace. Run "
            "this task without the user-browser lane if it needs to save a file."
        )

    def locator(self, *_a: Any, **_kw: Any):
        self._unsupported("locator")

    def frame_locator(self, *_a: Any, **_kw: Any):
        self._unsupported("frame_locator")

    def get_by_role(self, *_a: Any, **_kw: Any):
        self._unsupported("get_by_role")

    def get_by_text(self, *_a: Any, **_kw: Any):
        self._unsupported("get_by_text")

    def get_by_label(self, *_a: Any, **_kw: Any):
        self._unsupported("get_by_label")

    def get_by_placeholder(self, *_a: Any, **_kw: Any):
        self._unsupported("get_by_placeholder")

    async def evaluate(self, *_a: Any, **_kw: Any):
        raise NotSupportedOnRemoteLane(
            "page.evaluate does not exist on the remote lane: MV3's extension CSP forbids "
            "building a function from a string, even in the isolated world. The extension "
            "carries named probes generated from dom_snapshot.py instead — see "
            "nc_remote_snapshot, and extension/build_probes.py."
        )

    @property
    def frames(self):
        # Frames exist, but not as objects with their own evaluate(). The snapshot already
        # folds every frame's elements into one page-absolute list, which is the only thing
        # effector used page.frames for.
        return []
