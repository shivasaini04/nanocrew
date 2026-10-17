"""Browser + per-domain session lifecycle for Effector.

Not a port of a specific TS file — the TS engine's `sandbox.ts`/`session.ts` stay in
`nanocrew-main/src/agents/runtime/computer-use/` (they back the dashboard's direct-run
route, kept per stage43 doc 03). Effector needs its own Python-side equivalent since it
runs inside the per-cycle container, not the TS orchestrator process.

Launch args match the existing `browser.py` tool exactly, so both tools behave
identically in the same container image (same Chromium, same sandbox flags).

Phase 2 (stealth): every context gets the fingerprint-masking init script and network
shield applied by default — this is baseline hardening for a class of tool
(`DangerFullAccess`, browses arbitrary real sites) where the alternative is a context
that announces itself as an automated browser, not an opt-in feature. Residential-proxy
routing activates only for `session_domain`s known to rate-limit/block by IP
reputation (see agent/proxy_config.py) and only if credentials are actually configured
— unconfigured is a silent no-op, not an error, same as the existing linkedin_jobs.py/
yc_jobs.py callers.

Gap-closing pass, 2026-08-23: default is non-headless, rendering onto a lazily-started
Xvfb virtual display (desktop/xvfb_session.py) rather than Chromium's own headless
renderer. This is what makes desktop/desktop_vision.py's OS-level click (executor.py's
click-action last resort, after every DOM-based resolution layer fails) a real
capability instead of dead code with nothing to see or click — a headless-rendered
page has no pixels on any display for xdotool/scrot to touch. Falls back to headless
automatically if Xvfb isn't installed on this image (or a caller explicitly asks for
headless), matching every other "gracefully degrade, don't hard-fail" contract in this
package (see xvfb_session.py's own docstring).
"""

from __future__ import annotations

import asyncio
import base64
import os
from pathlib import Path
from typing import Any

from loguru import logger

from nanoagent.agent.effector import browser_pool
from nanoagent.agent.effector.capability_manifest import CapabilityManifest
from nanoagent.agent.effector.downloads import DownloadManager
from nanoagent.agent.effector.watchdogs import CrashWatchdog, DialogWatchdog
from nanoagent.agent.effector.stealth.camoufox_driver import (
    engine_status,
    get_camoufox_engine_options,
    is_camoufox_available,
)
from nanoagent.agent.effector.stealth.fingerprint_pool import pick_device_profile
from nanoagent.agent.effector.stealth.geo_profile import resolve_geo_profile
from nanoagent.agent.effector.stealth.network_shield import apply_network_shield
from nanoagent.agent.effector.stealth.proxy_router import playwright_proxy_kwargs
from nanoagent.agent.effector.stealth.stealth import (
    apply_stealth_to_context,
    build_stealth_init_script,
)
from nanoagent.agent.proxy_config import get_proxy_url, should_route_through_proxy

# stage44 doc 01, step 1 of 5: CDP's own live-frame API (Page.startScreencast),
# reused as-is rather than standing up a VNC server or a second Chromium output.
# Quality matches resolver.py's own vision-fallback screenshots (proven "good
# enough to read, small enough to transmit" for this codebase already); the
# frame is downscaled from the real viewport since a live-watch view doesn't
# need full-resolution pixels, and smaller frames mean less to base64-encode,
# POST, and re-emit per frame once step 2 (react_loop.py) wires a consumer.
_SCREENCAST_FORMAT = "jpeg"
_SCREENCAST_QUALITY = 60
_SCREENCAST_MAX_WIDTH = 800
_SCREENCAST_MAX_HEIGHT = 600

# How often the user-browser lane refreshes its live frame. Each one is a round
# trip over the extension bridge and shares the single browser with the agent, so
# this is deliberately seconds rather than the container lane's ~2fps: enough to
# watch the work, not enough to slow it down.
_REMOTE_FRAME_INTERVAL_S = 1.5

# The same pump on the container's own browser, where a screenshot is a local call
# rather than a bridge round trip — so it can run faster. Still well short of the
# CDP screencast's ~2fps: that costs the page nothing, and this does.
_LOCAL_FRAME_INTERVAL_S = 1.0

# A whole-display grab (stage 50 phase 1) forks a process, so it needs a ceiling.
# Comfortably longer than a real grab (tens of milliseconds) and shorter than the pump
# interval, so a wedged scrot gets dropped rather than queued behind itself.
_DISPLAY_GRAB_TIMEOUT_S = 4.0

_PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47])   # PNG
_JPEG_MAGIC = bytes([0xFF, 0xD8, 0xFF])


def _image_mime(data: bytes) -> str:
    """The real type of a screenshot, read from its magic bytes.

    The pump used to label everything `image/jpeg` while Playwright was handing it PNG.
    Browsers sniff and render it regardless, so it looked fine and was simply untrue —
    and a consumer that trusts the label rather than sniffing would have been wrong
    about every frame.

    Magic numbers are spelled with bytes([...]) rather than escapes: a \x89 written
    into this file through a shell heredoc arrives as the literal character U+0089, which
    is a real byte that is not the one meant, and the mistake is invisible on the page.
    """
    if data.startswith(_PNG_MAGIC):
        return "image/png"
    if data.startswith(_JPEG_MAGIC):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    # Unknown: JPEG is what both producers are asked for, so it is the best guess — but
    # say so here rather than in a data URL nobody can question.
    logger.debug("effector: unrecognised screenshot format — labelling it jpeg")
    return "image/jpeg"


# stage45 gap F: the session's own DialogWatchdog handles dialogs now — it records what
# it saw and can honour a pre-armed accept, neither of which a module-level function
# could do. This is kept as the fallback for the one case that has no session: a page
# hardened before `self.dialogs` exists, and any external caller still importing it.
async def _handle_dialog(dialog) -> None:
    """God-level pillar 08, 2026-08-23: with no listener
    registered at all, Playwright already auto-dismisses every dialog silently
    — so the real gap isn't "the page hangs," it's zero visibility into what
    happened. This makes the dismiss explicit and logged instead of invisible.

    `alert()` has nothing to decide (no confirm/cancel semantics) — accepting
    just closes it. `confirm()`/`prompt()`/`beforeunload` DO have a real
    choice, and there's no code path here that's actually reviewed the
    message the way the click-target danger gate reviews a step — so the
    fail-safe default is always dismiss (cancels the action; recoverable),
    never a blind accept of something unreviewed. Routing this through the
    real human-escalation round trip (like the click/select_combobox danger
    gate) is real future work, not delivered here — this pass is visibility
    + a safe default, not full escalation for dialogs."""
    try:
        if dialog.type == "alert":
            logger.debug(f'effector: accepting an alert dialog — "{dialog.message}"')
            await dialog.accept()
        else:
            logger.warning(
                f'effector: dismissing a {dialog.type} dialog (no reviewed default to accept it) — '
                f'"{dialog.message}"'
            )
            await dialog.dismiss()
    except Exception as err:
        logger.debug(f"effector: dialog handling failed — {err}")


def build_chromium_launch_args(strict_sandbox: bool | None = None) -> list[str]:
    """Constructs hardened Chromium command-line launch arguments.

    If strict_sandbox is True (or EFFECTOR_STRICT_SANDBOX=1 is set), --no-sandbox
    and --disable-setuid-sandbox are omitted and --site-per-process is enabled.
    """
    if strict_sandbox is None:
        strict_sandbox = os.environ.get("EFFECTOR_STRICT_SANDBOX", "0") == "1"

    base_args = [
        "--disable-dev-shm-usage",
        "--disable-gpu",
        # Stealth: suppress automation flag and WebRTC STUN IP leak
        "--disable-blink-features=AutomationControlled",
        "--enforce-webrtc-ip-permission-check",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--password-store=basic",
        "--use-mock-keychain",
    ]

    if strict_sandbox:
        base_args.extend([
            "--site-per-process",
            "--enable-features=IsolateOrigins,site-per-process",
        ])
    else:
        base_args.extend([
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-features=IsolateOrigins,site-per-process",
        ])

    return base_args


def resolve_engine_preference() -> str:
    """Which engine this run asks for: "auto", "camoufox" or "chromium".

    `or "auto"` rather than a plain default, because `docker run -e EFFECTOR_ENGINE=`
    SETS the variable to an empty string. "" is not "auto", so an empty value used to
    mean "not native" and silently forced Chromium — which would have made the control
    arm of an engine comparison run the treatment engine and report no difference.
    """
    if os.environ.get("EFFECTOR_USE_NATIVE_ENGINE") == "1":
        return "camoufox"
    return (os.environ.get("EFFECTOR_ENGINE") or "auto").strip().lower()


class EffectorSession:
    """Async context manager owning one Playwright browser/context/page, with
    optional per-domain session (cookies + localStorage) persisted to the agent's
    workspace so a later task against the same site doesn't have to log in again."""

    def __init__(
        self,
        workspace: Path,
        session_domain: str | None = None,
        headless: bool = False,
        viewport: dict[str, int] | None = None,
        stealth: bool = True,
        network_shield: bool = True,
        allow_remote: bool | None = None,
    ):
        self._workspace = Path(workspace)
        self._session_domain = session_domain
        self._headless = headless
        self._viewport = viewport or {"width": 1280, "height": 720}
        self._stealth = stealth
        self._network_shield = network_shield
        # Whether this session may run in the user's own browser.
        #
        # None — the default — means "the orchestrator decides", which is the right answer
        # for almost every caller. Passing True or False is an override, and exists only
        # for the two cases that are genuinely about the WORK rather than about the tool:
        # keeping a container-side login warm, and a swarm whose sessions would otherwise
        # fight over the one tab a remote browser gives them.
        #
        # It used to default to False, so a session was in the container unless the CALLER
        # asked otherwise — and exactly one caller did (effector.py). The result was that
        # "which browser am I driving" depended on which tool the model happened to pick:
        # the same agent, the same run, the same configuration, and `browser` silently went
        # to the container while `effector` went to the user's machine. A wrong pick was
        # not an error, it was a plausible-looking success from the wrong machine.
        #
        # That is the same shape as reference_gate_is_per_tool_not_system, where an agent
        # bypassed effector's danger gate by switching to the browser tool. Authorisation
        # attached to a tool is authorisation that can be routed around. The orchestrator's
        # decision now applies unless a caller states a reason to differ.
        self._allow_remote = allow_remote
        self._remote = False
        self._playwright = None
        self._browser = None
        self._context = None
        self._profile = None
        self._geo = None
        self._cdp_session = None
        # The pool's handle on the browser this session borrowed, or None on a cold or
        # non-Chromium run. Held so __aexit__ returns it instead of closing it.
        self._pooled = None
        # True when the native engine handed back something with no contexts to isolate
        # runs with. Such a browser is never shared — see the native launch in _enter.
        self._native_unpoolable = False
        self._camoufox_cm = None
        self._native_engine = False
        # R3: what this run actually had available, filled in as each subsystem
        # resolves in __aenter__. Read this rather than inferring from the private
        # flags: "off by config" and "on by config but impossible in this image" are
        # different situations, and only the manifest distinguishes them.
        self.capabilities = CapabilityManifest(
            stealth=stealth, network_shield=network_shield,
        )
        self._engine_reason = "not resolved"
        self._target_interceptor = None
        self._browser_cdp = None
        self.isolated_world = None
        self._tls_virtualizer = None
        self.context = None
        self.page = None
        # Set by the tool once TabManager exists, to `tab_manager.get_active_page`.
        # Bug found live 2026-09-03: `page` above is captured once at launch, and the
        # screenshot pump kept reading it forever — so the moment a page opened a popup
        # (Google's "Continue with Google" is exactly this), the human driving during a
        # takeover kept watching the ORIGINAL tab, frozen, while their clicks landed on
        # a page nobody could see. `page` stays the launch tab for everything else that
        # legitimately wants it; only the frame pump needs the one that is actually
        # on screen right now.
        self.active_page_resolver: Any = None
        # The X display the browser is actually painting on, or None when this run has
        # no display at all (the remote lane, or a headless fallback). Stage 50 phase 1:
        # what the live view captures is chosen by this — a display we own gets grabbed
        # whole, so a popup or a native dialog is visible; anything else falls back to
        # photographing the one page we can reach.
        self._display: str | None = None
        # stage44 doc 01: the latest screencast frame, kept here (not pushed
        # anywhere) until step 2 wires a real consumer — a ready-made hook for
        # react_loop.py's throttle+POST to read from without touching this file
        # again, and a way to verify frames actually arrive (a debug log plus
        # this attribute updating) before any transport exists.
        self.last_frame_data_url: str | None = None
        # The screenshot pump, on whichever lane has no CDP screencast.
        self._frame_pump: asyncio.Task | None = None
        self._screencast_on = False
        # stage45 gap E: the run's downloads. Created here rather than in __aenter__ so
        # a caller can read `session.downloads.directory` before the browser starts, and
        # so the object a step result points at is the same one for the whole session.
        # `policy` is filled in later, once the network policy exists — see __aenter__.
        self.downloads = DownloadManager(workspace=self._workspace)
        # stage45 gap F. Two objects, not an event bus — see watchdogs.py for why the
        # bus was skipped and why the dialog accept is pre-armed rather than escalated
        # from inside the handler.
        self.dialogs = DialogWatchdog()
        self.crash = CrashWatchdog()
        # stage45 item 3: the timer-driven live-frame pump, started by whoever owns the
        # sink (the effector tool). None until then.
        self._frame_pump = None

    @property
    def display(self) -> str | None:
        """The X display the browser is painting on, or None when there is not one.

        Public because the live screen (stage 50) is served by whoever owns the session
        rather than by the session itself — it needs a cycle token and an orchestrator,
        neither of which this class knows anything about.
        """
        return getattr(self, "_display", None)

    def _session_path(self) -> Path | None:
        if not self._session_domain:
            return None
        safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in self._session_domain)
        d = self._workspace / ".effector" / "sessions"
        d.mkdir(parents=True, exist_ok=True)
        return d / f"{safe}.json"

    async def __aenter__(self) -> "EffectorSession":
        """Start the session, and give the browser back if starting it fails.

        `async with` does NOT call __aexit__ when __aenter__ raises, so a failure after
        the browser was borrowed would hold a pool reference forever — the entry would
        never reach refs == 0, never be swept, and the process would keep a browser it
        could not lend. A cold launch leaked the same way, but only the one process; a
        pooled one leaks the pool.
        """
        try:
            return await self._enter()
        except BaseException:
            if self._pooled is not None:
                await browser_pool.release(self._pooled, discard=True)
                self._pooled = self._browser = self._playwright = None
            raise

    async def _enter(self) -> "EffectorSession":
        from playwright.async_api import async_playwright

        # stage45 doc 05 — the real-browser lane. Two gates, and both have to be open:
        # this caller must be allowed to use it, AND this run must have been opted in by
        # the orchestrator (which is what sets NC_BROWSER_CONTROLLER_ID, and only when the
        # agent is configured for it and its owner has a browser actually attached).
        # "Configured" alone is never enough — the lane moves a mouse in a browser signed
        # into someone's email, so it does not turn itself on.
        # None means "follow the orchestrator", which is what RemoteConfig.from_env()
        # reports. An explicit False still keeps a session in the container.
        if self._allow_remote is not False:
            from nanoagent.agent.effector.remote_page import RemoteConfig, RemotePage

            remote_cfg = RemoteConfig.from_env()
            if remote_cfg is not None:
                self.page = RemotePage(remote_cfg)
                # No Playwright context exists on this lane, and nothing may pretend one
                # does: `context` stays None and every caller branches on it. The active
                # tab is chosen in the extension on each command, so there is also no tab
                # manager here — the browser is the tab manager.
                self.context = None
                self._remote = True
                # stage 52 step 3: find out which kind of controller this is before the
                # first snapshot, because that snapshot's elements are marked
                # coordinate_only or not depending on the answer.
                await self.page.discover_capabilities()
                await self.page.refresh_info()
                logger.info(
                    f"effector: running in the user browser (controller "
                    f"{remote_cfg.controller_id[:8]}) — currently at {self.page.url}"
                )
                # Phase 5.1: make this lane watchable.
                #
                # This branch returns before _start_screencast(), which is correct —
                # there is no Playwright and no CDP session here — but it left the
                # user-browser lane the one lane you could not see from NanoCrew, which
                # is the opposite of the point. The extension already exposes
                # page.screenshot, so the same `last_frame_data_url` the live view reads
                # gets a different producer rather than the view needing a second path.
                self._frame_pump = asyncio.create_task(
                    self._screenshot_frame_pump(_REMOTE_FRAME_INTERVAL_S)
                )
                return self

        # Real root cause, 2026-08-24, found only after two other genuine-but-
        # insufficient fixes (Xvfb-liveness check, then socket-poll instead of a
        # flat sleep — both correct, neither explained why the failure kept
        # recurring even with them deployed). `async_playwright().start()` forks
        # Playwright's own Node.js driver subprocess — a SEPARATE OS process whose
        # environment is a snapshot taken at fork time, not a live view into this
        # Python process's os.environ. The old order started that driver FIRST,
        # then called ensure_virtual_display() (which sets os.environ["DISPLAY"]
        # in THIS process, after the driver already exists) — so no matter how
        # correctly Xvfb started, the driver process that actually launches
        # Chromium never saw DISPLAY at all. Every manual reproduction during
        # debugging happened to call ensure_virtual_display() before starting
        # Playwright, which is why isolated tests could never reproduce a bug
        # that was live in prod on every single run. Fix: resolve the display
        # BEFORE forking the driver, so the fork inherits it correctly.
        launch_headless = self._headless
        if not launch_headless:
            from nanoagent.agent.effector.desktop.xvfb_session import ensure_virtual_display
            display = ensure_virtual_display()
            # Remembered for the live view (stage 50 phase 1). This is the ONLY place
            # that knows a real display exists for this run; the pump would otherwise
            # have to re-derive it and could disagree.
            self._display = display
            if display is None:
                # No Xvfb on this image (e.g. a dev machine, or an image built before
                # the desktop-automation packages were added) — degrade to headless
                # rather than handing Chromium a DISPLAY that doesn't exist.
                logger.debug("effector: no virtual display available — falling back to headless")
                launch_headless = True

        session_path = self._session_path()
        storage_state = str(session_path) if session_path and session_path.exists() else None
        if storage_state:
            logger.debug(f"effector: restoring session for {self._session_domain}")

        # Our inlined native engine fork (agent/effector/engine/). Vendored so we can
        # modify it — AI-driven control, new capabilities — rather than tracking an
        # upstream package.
        #
        # "auto" (the default) means USE IT WHEN THE BINARY IS PRESENT. It previously
        # meant "off unless someone sets an env var", which combined with a broken
        # availability probe to make the engine permanently unreachable. The binary is
        # fetched as an explicit Dockerfile build step; if that step was skipped or
        # failed, engine_status() says so and we fall back to Chromium — visibly, in
        # the capability manifest, not silently.
        engine_pref = resolve_engine_preference()
        requested_native = engine_pref in ("auto", "camoufox")
        engine_ok, engine_reason = engine_status()

        # Profile/engine coherence gate, 2026-08-31 — measured, not theorised.
        #
        # The vendored engine is Gecko (Camoufox 152 ships application.ini and a
        # Firefox version line). Every profile in the pool claims Chrome, and the
        # stealth init script defines window.chrome, navigator.userAgentData,
        # deviceMemory and Chrome PDF plugins — none of which exist in Firefox.
        #
        # Running the two together does not produce a partial disguise; it produces a
        # browser whose JS says Chrome while its TLS handshake, HTTP/2 SETTINGS and
        # header order all say Firefox. That contradiction is *easier* to detect than
        # plain unmodified Chromium, so the engine is worse than not using it until a
        # Gecko profile pool exists. fingerprint_pool's own rule: detection scores
        # inconsistency, not rarity.
        #
        # This is a gate, not a warning: an incoherent pairing must not run.
        engine_family = "gecko"  # what the vendored fork actually is
        # A Gecko pool now exists (fingerprint_pool._GECKO_PROFILES, measured from this
        # engine on 2026-08-31), so coherence is achieved by DRAWING FROM IT rather than
        # by refusing the engine. The gate stays as a hard check: if the Gecko pool ever
        # goes missing or stops claiming Firefox, we fall back to Chromium instead of
        # wearing a Chrome disguise on a Firefox transport.
        pool_family = pick_device_profile(
            self._session_domain, browser_family=engine_family,
        ).browser_family if requested_native else "chromium"
        coherent = pool_family == engine_family
        if requested_native and engine_ok and not coherent:
            engine_reason = (
                f"engine is {engine_family} but the available fingerprint pool is "
                f"{pool_family} — refusing to pair them (a Chrome JS surface over a "
                f"Firefox transport is more detectable than plain Chromium)"
            )

        use_native = requested_native and engine_ok and coherent

        self.capabilities.engine_requested = engine_pref
        self.capabilities.engine_reason = engine_reason
        self.capabilities.profile_family = pool_family
        self._engine_reason = engine_reason

        if requested_native and engine_ok and not coherent:
            # A real fault whenever the engine was explicitly asked for: the operator
            # believes they are getting it and they are not.
            self.capabilities.degrade(
                f"native engine held back — {engine_reason}",
                requested=(engine_pref == "camoufox"),
            )

        if requested_native and not engine_ok:
            # Only an EXPLICIT `camoufox` request that cannot be honoured is a fault.
            # Plain `auto` on an image built without the binary is a supported
            # configuration — recording it as a degradation would put a permanent
            # warning on every session, which is how real warnings get ignored.
            self.capabilities.degrade(
                f"native engine unavailable — {engine_reason}; using Chromium",
                requested=(engine_pref == "camoufox"),
            )

        if use_native:
            from nanoagent.agent.effector.engine.async_api import AsyncCamoufox

            # Gecko pool — see the coherence note above. Passing the family here is
            # what makes the disguise match the browser wearing it.
            self._profile = pick_device_profile(
                self._session_domain, browser_family=engine_family,
            )
            proxying = should_route_through_proxy(self._session_domain)
            proxy = playwright_proxy_kwargs() if proxying else None
            self._geo = await resolve_geo_profile(get_proxy_url() if proxy else None)

            engine_opts = get_camoufox_engine_options(
                profile=self._profile,
                geo=self._geo,
                headless=launch_headless,
                viewport=self._viewport,
                proxy=proxy,
            )
            # NB: no storage_state here. It is a Playwright new_context() kwarg, not an
            # engine launch option — passing it raised TypeError and the run fell back to
            # Chromium. Session restore on this path is applied to the context after
            # launch instead — see _restore_engine_session, which since 2026-09-03
            # actually exists. It was referenced here and never written, so this lane
            # restored nothing and every run quietly started logged out.

            # The native engine bakes the disguise in at LAUNCH — device profile, geo,
            # proxy, viewport — so unlike Chromium a warm one is only reusable by a run
            # that resolved the identical fingerprint. The key is therefore the
            # fingerprint, not just the engine. `pick_device_profile` is stable per
            # domain, so an agent working one site repeatedly reuses its browser; an
            # agent hopping domains correctly gets a fresh one rather than wearing the
            # previous site's disguise.
            #
            # The key is the PROFILE NAME, not its user agent. Every Gecko profile in
            # the pool carries the same UA string ("…rv:152.0…Firefox/152.0") and
            # differs in hardware_concurrency, GPU and screen — so keying on the UA
            # made two domains that pick_device_profile deliberately gave different
            # DEVICES share one warm browser, and a site would see the core count and
            # screen belonging to another site's visit. Found live 2026-09-20 when 15 of
            # 16 runs came back warm across 14 different domains, which should have been
            # impossible.
            native_key = "|".join([
                "camoufox", self._display or "headless", str(launch_headless),
                getattr(self._profile, "name", "") or getattr(self._profile, "user_agent", ""),
                self._geo.timezone_id, self._geo.locale,
                str((proxy or {}).get("server", "")),
                f"{self._viewport.get('width')}x{self._viewport.get('height')}",
            ])

            async def _launch_native() -> browser_pool.PooledBrowser:
                cm = AsyncCamoufox(**engine_opts)
                browser = await cm.__aenter__()

                async def _close() -> None:
                    await cm.__aexit__(None, None, None)

                return browser_pool.PooledBrowser(browser=browser, close=_close)

            try:
                self._pooled = await browser_pool.acquire(native_key, _launch_native)
                self._browser = self._pooled.browser
                self._native_engine = True
                if hasattr(self._browser, "new_context"):
                    # ALWAYS a fresh context, never `contexts[0]`. The default context
                    # holds the previous run's cookies and localStorage, and with a
                    # pooled browser the previous run is a DIFFERENT TASK. This single
                    # line is the difference between a speed change and one task reading
                    # another's logged-in session.
                    self._context = await self._browser.new_context()
                else:
                    # This build hands back something page-like with no contexts to
                    # separate runs with. Nothing can be isolated, so it must not be
                    # shared: this session keeps it and teardown retires it, which is
                    # exactly the old one-browser-per-run behaviour.
                    self._native_unpoolable = True
                    self._context = self._browser
                    logger.debug("effector: the native engine exposes no contexts — not pooling it")
                self.capabilities.warm_browser = not self._pooled.cold and not self._native_unpoolable
                self.context = self._context
                self.page = (
                    self._context.pages[0]
                    if hasattr(self._context, "pages") and self._context.pages
                    else await self._context.new_page()
                )
                self.page.on("dialog", self.dialogs.handle)
                self._context.on("page", self._on_new_page)
                await self._restore_engine_session()
                # Bind whatever this engine actually exposes. `bound` is logged rather
                # than assumed: a session whose crash detection quietly attached to
                # nothing is indistinguishable from one that never crashed, and on this
                # branch `self._context` may be a browser rather than a context.
                bound = self.crash.attach(
                    page=self.page, context=self._context, browser=self._browser,
                )
                logger.debug(f"effector: crash watchdog bound {bound} event(s) [native]")
                # attach() returns False rather than raising when this object is a
                # browser rather than a context (the fallback branch above can produce
                # either) — passive capture is a safety net, not something worth
                # failing a session over. The explicit `download` action still works.
                self.downloads.attach(self._context)

                if self._network_shield:
                    await apply_network_shield(self.page)

                # NOTE: apply_stealth_to_context is deliberately NOT called on this
                # path, and this branch returns before it. That script is Chrome-shaped
                # — it defines window.chrome, navigator.userAgentData and
                # navigator.deviceMemory, all three of which read `undefined` on a real
                # Firefox (measured 2026-08-31). Injecting them INTO Firefox would
                # manufacture the exact contradiction the Gecko pool exists to avoid.
                # The engine does its masking natively, in C++, which is the reason to
                # use it at all.

                # No self-assessed rating in a log line — this one used to carry a
                # tier number, an unmeasured claim that read as fact in every trace.
                # Say what started, not how good it is.
                self.capabilities.engine = "camoufox-native"
                self.capabilities.proxy = bool(proxy)

                # The live view, which this branch would otherwise skip entirely.
                #
                # This path returns before _start_screencast() the same way the remote
                # lane does, and for the same underlying reason: the engine is Gecko and
                # CDP is Chromium-only ("CDP session is only available in Chromium").
                # Verified live in a live cycle, the first real run on this engine —
                # it worked perfectly and the drawer showed nothing, because no producer
                # for `last_frame_data_url` ever started.
                #
                # Putting the fallback after _start_screencast() was not enough: the
                # early return means execution never gets there. It has to be here.
                logger.info("effector: no CDP screencast on the native engine — using screenshot frames")
                self._frame_pump = asyncio.create_task(
                    self._screenshot_frame_pump(_LOCAL_FRAME_INTERVAL_S)
                )

                # Say what this engine costs, in the result payload and not only a log.
                #
                # The first live run on it a live cycle reported isolated_worlds and
                # lifecycle_interception as false with `degradations: []` beside them —
                # the facts were present and unexplained, and the one that matters is not
                # obvious from a boolean: DOM introspection runs in the page's own world
                # here, so a hostile page can observe the agent reading it. That is a real
                # trade for native fingerprint masking, and worth making deliberately
                # rather than discovering.
                self.capabilities.note(
                    "no CDP on this engine (Gecko): DOM introspection runs in the page's "
                    "own world and is visible to page scripts"
                )
                self.capabilities.note(
                    "no CDP lifecycle interception on this engine — navigation is observed, "
                    "not intercepted"
                )
                self.capabilities.note(
                    "live view is screenshot frames (~1/s) rather than the CDP screencast"
                )

                self.capabilities.log_summary()
                logger.info("effector: initialized inlined native engine (agent/effector/engine)")
                return self
            except Exception as err:
                # A launch failure IS a degradation regardless of how the engine was
                # requested: the binary is present and we asked it to start.
                self.capabilities.degrade(
                    f"native engine launch failed ({err}) — falling back to Chromium",
                    requested=True,
                )
                self._camoufox_cm = None
                self._native_engine = False
                # The native browser may already have been borrowed before whatever
                # failed afterwards. Retire it: this run is about to launch Chromium,
                # and a half-initialised Gecko browser must not be lent to the next run.
                if self._pooled is not None:
                    await browser_pool.release(self._pooled, discard=True)
                    self._pooled = None
                self._browser = None
                self._context = None
                self._native_unpoolable = False

        chromium_path = os.environ.get(
            "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH",
            os.environ.get("CHROME_PATH", "/usr/bin/chromium"),
        )
        launch_args = build_chromium_launch_args()

        # The browser process outlives the run; the CONTEXT below does not. Everything
        # this session is identified by — cookies, user agent, proxy, timezone — is a
        # new_context() argument a few lines down, so one warm browser serves every
        # domain without any of them leaking between runs. See browser_pool.py for the
        # measurement that motivated this (5.5 s of an 18.5 s task was launching).
        #
        # The display is part of the key: a browser painting on one Xvfb display cannot
        # be lent to a run that resolved a different one.
        pool_key = "|".join([
            "chromium", chromium_path, str(launch_headless),
            self._display or "headless", str(hash(tuple(launch_args))),
        ])

        async def _launch_chromium() -> browser_pool.PooledBrowser:
            pw = await async_playwright().start()
            browser = await pw.chromium.launch(
                headless=launch_headless,
                executable_path=chromium_path,
                args=launch_args,
            )
            return browser_pool.PooledBrowser(browser=browser, playwright=pw)

        self._pooled = await browser_pool.acquire(pool_key, _launch_chromium)
        self._browser = self._pooled.browser
        self._playwright = self._pooled.playwright
        self.capabilities.warm_browser = not self._pooled.cold
        if not self._pooled.cold:
            logger.debug("effector: reusing a warm browser — no launch this run")

        session_data = None
        if self._session_domain:
            from nanoagent.agent.effector.security.session_vault import SessionVault
            session_data = SessionVault.load_session(self._workspace, self._session_domain)

        session_path = self._session_path()
        storage_state_arg = None
        if session_data is not None:
            logger.debug(f"effector: restored AES-256-GCM encrypted session for {self._session_domain}")
            storage_state_arg = session_data
        elif session_path and session_path.exists():
            logger.debug(f"effector: restoring legacy plaintext session for {self._session_domain}")
            storage_state_arg = str(session_path)

        # One profile drives both the HTTP UA header and the injected JS fingerprint,
        # so they can't disagree (a mismatched header vs. navigator.platform is its
        # own detectable signal) — picked stably per session_domain, not randomly
        # every launch, so the same site sees the same "device" across visits.
        #
        # Review finding, 2026-08-30: the version is then restated from the browser
        # that is actually running. The pool used to hardcode Chrome 123/124 while
        # the image installs Debian's unpinned `chromium`, so the UA advertised one
        # version and the TLS/HTTP2 fingerprint underneath it belonged to another.
        self._profile = pick_device_profile(self._session_domain)
        try:
            self._profile = self._profile.with_chrome_version(self._browser.version)
        except Exception as err:
            logger.debug(f"effector: could not read the live Chromium version — {err}")

        proxying = should_route_through_proxy(self._session_domain)
        proxy = playwright_proxy_kwargs() if proxying else None

        # Review finding, 2026-08-30: without an explicit timezone/locale the context
        # reported the container's own UTC clock behind whatever city the residential
        # exit node geolocates to. Resolved through the proxy so the answer describes
        # the exit node, not this container.
        self._geo = await resolve_geo_profile(get_proxy_url() if proxy else None)
        logger.debug(
            f"effector: claiming timezone {self._geo.timezone_id} / locale {self._geo.locale} "
            f"(source: {self._geo.source})"
        )

        context_kwargs: dict = dict(
            viewport=self._viewport,
            # Playwright's own default, stated explicitly: it is what makes a download
            # reach a temp file at all, and gap E depends on it being on. A silent
            # default is the kind of thing that changes in a minor release and takes a
            # capability with it.
            accept_downloads=True,
            user_agent=self._profile.user_agent,
            storage_state=storage_state_arg,
            locale=self._geo.locale,
            timezone_id=self._geo.timezone_id,
            extra_http_headers={"Accept-Language": self._geo.accept_language},
        )
        if proxy:
            from nanoagent.agent.effector.stealth.tls_proxy import (
                TLSVirtualizerProxy,
                is_utls_available,
            )
            if is_utls_available():
                self._tls_virtualizer = TLSVirtualizerProxy(
                    profile=self._profile,
                    upstream_proxy=proxy.get("server"),
                )
                v_url = await self._tls_virtualizer.start()
                if v_url:
                    proxy = dict(proxy)
                    proxy["server"] = v_url
                    self.capabilities.tls_virtualizer = (
                        "mock" if os.environ.get("EFFECTOR_MOCK_UTLS") == "1" else "utls"
                    )
                else:
                    self.capabilities.degrade(
                        "uTLS virtualizer failed to start — wire fingerprint is stock Chromium",
                        requested=True,
                    )
            else:
                # The uTLS forwarder binary does not exist in this repo (R3 §2.5):
                # phase 5 shipped the lifecycle manager, not the engine. Traffic goes
                # through the proxy with a stock Chromium JA3/JA4 regardless of what
                # the device profile claims. Stated once per proxied session, at INFO,
                # because it is the known state rather than a fault.
                self.capabilities.degrade(
                    "no uTLS virtualizer available — JA3/JA4 is stock Chromium",
                    requested=False,
                )

            logger.debug(f"effector: routing {self._session_domain} through residential proxy")
            context_kwargs["proxy"] = proxy

        self._context = await self._browser.new_context(**context_kwargs)
        self.context = self._context  # public — TabManager and future callers need the context, not just the page
        # Context-level, not page-level: a download started from a popup or a
        # target=_blank tab belongs to this run just as much as one from the first page.
        self.downloads.attach(self._context)
        self.capabilities.proxy = bool(proxy)

        if self._stealth:
            await apply_stealth_to_context(
                self._context, profile=self._profile, languages=self._geo.languages,
            )

        # R4: pause every new target before its first script runs, patch it, release.
        #
        # The `page` event below fires only AFTER a popup exists and has begun
        # executing, so a detection script in its first inline <script> runs before any
        # handler attaches. Target.setAutoAttach(waitForDebuggerOnStart=True) is the
        # only thing that closes that race, and it has to be armed here — on the
        # browser-level CDP session, before the first page is opened — or the first
        # page slips through unpatched. OAuth consent windows and payment
        # confirmations are exactly the flows this matters for.
        if self._stealth:
            try:
                from nanoagent.agent.effector.lifecycle.cdp_target_interceptor import (
                    CDPTargetInterceptor,
                )
                # Built from the SAME profile and languages the context was given. A
                # popup patched with a different fingerprint than its opener is worse
                # than an unpatched one: a window.opener/child mismatch is a strong
                # automation signal, and it is one no single page could produce.
                self._browser_cdp = await self._browser.new_browser_cdp_session()
                self._target_interceptor = CDPTargetInterceptor(
                    init_script=build_stealth_init_script(
                        self._profile, languages=self._geo.languages if self._geo else None,
                    ),
                    user_agent_override=self._user_agent_override(),
                )
                armed = await self._target_interceptor.enable_auto_attach(self._browser_cdp)
                self.capabilities.lifecycle_interception = armed
                if not armed:
                    self.capabilities.degrade(
                        "target auto-attach could not be armed — popups are patched on "
                        "the 'page' event only, so the first-inline-script race remains",
                        requested=True,
                    )
            except Exception as err:
                self._target_interceptor = None
                self.capabilities.degrade(
                    f"target auto-attach unavailable ({err}) — popups are patched on "
                    f"the 'page' event only, so the first-inline-script race remains",
                    requested=True,
                )

        # A popup or target=_blank tab used to get no network shield at all — the
        # shield was bound to the first page only. Stealth was always context-wide.
        self._context.on("page", self._on_new_page)

        self.page = await self._context.new_page()
        self.page.on("dialog", self.dialogs.handle)
        bound = self.crash.attach(page=self.page, context=self._context, browser=self._browser)
        logger.debug(f"effector: crash watchdog bound {bound} event(s)")

        # One CDP session for the main page, shared by the client-hint override and
        # the screencast below — a second attach would be pure overhead, and both
        # features degrade to "off" together if this build has no CDP at all.
        try:
            self._cdp_session = await self._context.new_cdp_session(self.page)
        except Exception as err:
            logger.debug(f"effector: no CDP session for this page — {err}")
            self._cdp_session = None

        if self._cdp_session and self.page:
            from nanoagent.agent.effector.isolated_world import IsolatedWorldManager
            self.isolated_world = IsolatedWorldManager(self.page, self._cdp_session)
            self.page._isolated_world_manager = self.isolated_world
            self.capabilities.isolated_worlds = True
        elif self._stealth:
            self.capabilities.degrade(
                "no CDP session — DOM introspection runs in the page's own world, "
                "visible to page scripts",
                requested=True,
            )

        if self._stealth:
            await self._apply_client_hints(self.page, self._cdp_session)

        if self._network_shield:
            from nanoagent.agent.effector.security.network_policy import L7NetworkPolicy
            # enforce_allowlist=False: a session may follow links to any public site (the
            # per-task site lock was removed 2026-09-14 at the owner's request). What stays
            # is the SSRF block — localhost, private ranges and cloud metadata — which is
            # what stops a page steering the agent into the orchestrator API or LiteLLM.
            net_policy = (
                L7NetworkPolicy(primary_domain=self._session_domain, enforce_allowlist=False)
                if self._session_domain else None
            )
            await apply_network_shield(self.page, policy=net_policy)
            # The shield enforces this through page.route, which an APIRequestContext
            # does not pass through — so the download path has to apply the same policy
            # itself. See DownloadManager._check_egress.
            self.downloads.policy = net_policy

        await self._start_screencast()
        if not self._screencast_on:
            # No CDP, so no screencast — which is now the ORDINARY case, not an edge one.
            #
            # The native stealth engine is Gecko and CDP is Chromium-only, so the moment
            # camoufox started launching (2026-09-03) the live browser view went dark on
            # this lane: `last_frame_data_url` stayed None and the dashboard got nothing.
            # Watching the agent work is most of the point of the drawer, and takeover
            # without it means driving a page you cannot see.
            #
            # page.screenshot works on every engine, so the same pump the user-browser
            # lane already used becomes the general fallback. CDP stays the fast path
            # where it exists — it is pushed at ~2fps and costs the page nothing — and
            # this covers everywhere it does not.
            logger.info("effector: no CDP screencast — using screenshot frames for the live view")
            self._frame_pump = asyncio.create_task(
                self._screenshot_frame_pump(_LOCAL_FRAME_INTERVAL_S)
            )

        self.capabilities.log_summary()
        return self

    @property
    def engine(self) -> str:
        """Which browser engine this session actually launched."""
        return "camoufox-native" if self._native_engine else "chromium"

    @property
    def engine_reason(self) -> str:
        """Why that engine, in words — the honest answer for a run report."""
        return self._engine_reason

    async def evaluate_isolated(self, expression: str, arg: Any = None) -> Any:
        """Evaluates a JavaScript expression or function safely in the isolated execution world."""
        if self.isolated_world:
            return await self.isolated_world.evaluate(expression, arg)
        if self.page and hasattr(self.page, "evaluate"):
            if arg is not None:
                return await self.page.evaluate(expression, arg)
            return await self.page.evaluate(expression)
        return None

    async def _on_new_page(self, page) -> None:
        """Give a popup/new tab the same treatment the first page gets. Never fatal:
        a tab that misses the shield still works, it just costs more bandwidth."""
        try:
            page.on("dialog", self.dialogs.handle)
            new_cdp = await self._context.new_cdp_session(page)
            if new_cdp:
                from nanoagent.agent.effector.isolated_world import IsolatedWorldManager
                page._isolated_world_manager = IsolatedWorldManager(page, new_cdp)
            if self._stealth:
                await self._apply_client_hints(page, new_cdp)
            if self._network_shield:
                await apply_network_shield(page)
        except Exception as err:
            logger.debug(f"effector: could not harden a newly opened page — {err}")

    async def _apply_client_hints(self, page, cdp) -> None:
        """Make the Client Hints request headers agree with the JS fingerprint.

        Review finding, 2026-08-30: `new_context(user_agent=...)` rewrites the UA
        string and nothing else, so Chromium kept sending its own `sec-ch-ua` /
        `sec-ch-ua-platform` headers. The server saw the real Chromium version and
        platform in the headers while `navigator.userAgentData` claimed the profile's
        — a contradiction visible server-side with no JS at all, and the loudest
        single tell in the package. `Emulation.setUserAgentOverride` with
        `userAgentMetadata` is the only thing that moves both together.
        """
        if self._profile is None or cdp is None:
            return
        try:
            await cdp.send("Emulation.setUserAgentOverride", self._user_agent_override())
        except Exception as err:
            logger.debug(f"effector: client-hint override failed (headers may disagree with JS) — {err}")

    def _user_agent_override(self) -> dict[str, Any]:
        """The UA + client-hint payload for this session's profile.

        Extracted (R4) so the popup interceptor sends byte-identical metadata to what
        the main page gets. Two copies of this dict would drift, and a popup whose
        client hints disagree with its opener's is a louder tell than either alone.
        """
        profile = self._profile
        if profile is None:
            return {}
        major = profile.chrome_version.split(".")[0]
        brands = [
            {"brand": "Not_A Brand", "version": "8"},
            {"brand": "Chromium", "version": major},
            {"brand": "Google Chrome", "version": major},
        ]
        return {
            "userAgent": profile.user_agent,
            "acceptLanguage": self._geo.accept_language if self._geo else "en-US,en;q=0.9",
            "platform": profile.platform,
            "userAgentMetadata": {
                "brands": brands,
                "fullVersionList": brands,
                "fullVersion": profile.chrome_version,
                "platform": profile.ua_platform,
                "platformVersion": profile.platform_version,
                "architecture": profile.architecture,
                "model": "",
                "mobile": False,
                "bitness": profile.bitness,
                "wow64": False,
            },
        }

    async def _start_screencast(self) -> None:
        """stage44 doc 01, step 1 of 5: start CDP's live-frame stream. Per-session
        scope (not per-turn), started right after new_page() alongside the other
        cosmetic/observability setup above. No consumer yet — this only has to
        prove frames actually arrive on a real page (verified via the debug log
        below plus `last_frame_data_url` updating) before step 2 builds the
        throttle+POST on top of it.

        Same "degrade, never break the agent's real work" contract as every other
        non-essential layer in this session (dialog handling, stealth, network
        shield): a screencast failure is a lost live view, not a failed task."""
        if self._cdp_session is None:
            logger.debug("effector: no CDP session — falling back to screenshot frames")
            return
        try:
            self._cdp_session.on("Page.screencastFrame", self._on_screencast_frame)
            await self._cdp_session.send(
                "Page.startScreencast",
                {
                    "format": _SCREENCAST_FORMAT,
                    "quality": _SCREENCAST_QUALITY,
                    "maxWidth": _SCREENCAST_MAX_WIDTH,
                    "maxHeight": _SCREENCAST_MAX_HEIGHT,
                },
            )
            self._screencast_on = True
            logger.debug("effector: CDP screencast started")
        except Exception as err:
            logger.debug(f"effector: screencast start failed — {err}")
            self._cdp_session = None

    def _on_screencast_frame(self, event: dict) -> None:
        """CDP's frame-delivery callback — sync, per Playwright's CDPSession.on
        contract, so the required ACK (Page.screencastFrameAck, needed to keep
        frames flowing regardless of whether anything downstream consumes them
        yet) is scheduled on the running loop rather than awaited directly."""
        data = event.get("data")
        session_id = event.get("sessionId")
        self.last_frame_data_url = f"data:image/jpeg;base64,{data}" if data else None
        logger.debug(f"effector: screencast frame received ({len(data or '')} b64 chars)")

        if self._cdp_session is not None and session_id is not None:
            async def _ack() -> None:
                try:
                    await self._cdp_session.send("Page.screencastFrameAck", {"sessionId": session_id})
                except Exception as err:
                    logger.debug(f"effector: screencast frame ack failed — {err}")

            asyncio.ensure_future(_ack())

    async def _screenshot_frame_pump(self, interval_s: float) -> None:
        """Keep `last_frame_data_url` fresh by asking, where CDP cannot push.

        Two lanes need this and for the same reason — no CDP screencast. The user
        browser has none because the extension bridge is not CDP; the native stealth
        engine has none because it is Gecko and CDP is Chromium-only. `page.screenshot`
        works on both, so one pump serves both and the interval is the only difference:
        a local screenshot is cheap, one over the extension bridge is a round trip that
        competes with the agent for the single browser it is driving.

        Never raises and never ends the run. A refused screenshot is the *expected*
        case, not a fault: the extension checks its allowlist against the tab as it is
        NOW, so the moment the user opens a tab they have not allowed, this starts being
        told no — which is the allowlist working. Keep the last good frame, keep asking,
        say nothing louder than debug.
        """
        while True:
            try:
                await asyncio.sleep(interval_s)
                if self.page is None:
                    continue
                data = await self._pump_screenshot()
                if data:
                    self.last_frame_data_url = (
                        f"data:{_image_mime(data)};base64,"
                        + base64.b64encode(data).decode("ascii")
                    )
            except asyncio.CancelledError:
                raise
            except Exception as err:  # noqa: BLE001
                logger.debug(f"effector: remote frame pump skipped a frame — {err}")

    async def _stop_screencast(self) -> None:
        if self._cdp_session is None:
            return
        try:
            await self._cdp_session.send("Page.stopScreencast")
        except Exception as err:
            logger.debug(f"effector: screencast stop failed — {err}")

    # ── the live-view pump (stage45 item 3) ──────────────────────────────────

    def start_frame_pump(self, sink, interval_s: float = 0.5) -> bool:
        """Push the newest frame on a TIMER, not only when the loop remembers to.

        Stage 44 shipped the live view with two push points per turn and named the
        consequence in its own "known limits": a long LLM decision call shows a frozen
        frame. That is not cosmetic. The decision is often the longest part of a turn,
        and it is exactly when a page is still finishing what the last action started —
        so the one thing a human watching wants to see is the part they cannot.

        Owned by the session rather than by the loop for one reason: cleanup.
        `run_react_loop` has thirteen return sites, and a background task cancelled at
        only twelve of them is a task that outlives its run inside a warm daemon that
        gets reused. `__aexit__` runs on every one of those paths already.

        `sink(data_url, url, title)` is supplied by the caller — the session does not
        know how to reach an orchestrator and should not learn.
        """
        if self._frame_pump is not None or sink is None:
            return False
        self._frame_pump = asyncio.create_task(self._pump_frames(sink, interval_s))
        return True

    async def _pump_frames(self, sink, interval_s: float) -> None:
        """Never raises out; a live view must not be able to end a run."""
        last_sent: str | None = None
        last_url = ""
        title = ""
        try:
            while True:
                await asyncio.sleep(interval_s)
                try:
                    data_url = self.last_frame_data_url
                    if not data_url or data_url == last_sent:
                        # Deduplicated on purpose. A static page during a 20-second
                        # decision would otherwise POST the same bytes forty times, and
                        # the point of this pump is the page that IS changing while the
                        # loop is busy — not a heartbeat.
                        continue
                    url = ""
                    try:
                        url = self.page.url or ""
                    except Exception:
                        pass
                    if url != last_url:
                        # Only when the page actually moved: page.title() is a round
                        # trip and this runs twice a second.
                        try:
                            fetched = await asyncio.wait_for(self.page.title(), timeout=1)
                            title = "" if (not isinstance(fetched, str) or fetched.startswith("Loading ")) else fetched
                        except Exception:
                            title = ""
                        last_url = url
                    sink(data_url, url, title)
                    last_sent = data_url
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    logger.debug(f"effector: live frame pump skipped a tick — {err}")
        except asyncio.CancelledError:
            pass

    async def _restore_engine_session(self) -> None:
        """Put a saved session back on the native lane. Never raises.

        The Chromium path restores by handing `storage_state` to new_context(); that is
        a Playwright kwarg and not an engine launch option, so this lane has to do it
        after launch. A comment two hundred lines up has said "see
        _restore_engine_session below" since the engine was added — and the function was
        never written, so this lane has never restored a session at all. Nothing failed:
        every run simply started logged out, which looks exactly like having no session
        saved. Found 2026-09-03 by testing a cookie across two cycle tokens.

        Cookies only. localStorage in a storage_state is per-origin and Playwright
        applies it by visiting each origin, which is not something to do silently at
        launch — a login that depends on localStorage rather than cookies will still not
        survive here, and it says so out loud rather than appearing to work.
        """
        if not self._session_domain:
            return
        ctx = self._storage_context()
        if ctx is None or not hasattr(ctx, "add_cookies"):
            logger.debug("effector: this lane cannot restore cookies — starting fresh")
            return
        try:
            from nanoagent.agent.effector.security.session_vault import SessionVault

            state = SessionVault.load_session(self._workspace, self._session_domain)
            if not state:
                return
            cookies = state.get("cookies") or []
            if cookies:
                await ctx.add_cookies(cookies)
                logger.info(
                    f"effector: restored {len(cookies)} cookie(s) for {self._session_domain} "
                    f"on the native engine"
                )
            if state.get("origins"):
                self.capabilities.note(
                    "localStorage from a saved session is not restored on this engine — "
                    "cookies only"
                )
        except Exception as err:  # noqa: BLE001
            logger.warning(
                f"effector: could not restore the saved session for {self._session_domain} "
                f"— {err}. This run starts logged out."
            )

    async def _save_session_vault(self, crashed: bool) -> None:
        """Persist this session's cookies to the encrypted vault. Never raises.

        Shared by both lanes deliberately. The native-engine teardown used to write the
        LEGACY PLAINTEXT session file and return before ever reaching the vault, so on
        that lane phase 2's encryption did not happen at all — cookies for a logged-in
        site sat on disk in the clear, and the vault the design is built around was
        never written. Not a thing to leave to two code paths that must not drift.
        """
        if not (self._session_domain and not crashed):
            return
        try:
            from nanoagent.agent.effector.security.session_vault import SessionVault
            ctx = self._storage_context()
            if ctx is None:
                raise RuntimeError("this lane exposes no storage_state — cookies cannot be saved")
            state_dict = await ctx.storage_state()
            SessionVault.save_session(self._workspace, self._session_domain, state_dict)
        except Exception as err:
            # Warning, not debug (stage 49 phase 2). A failed save is why the NEXT run
            # starts logged out, and at debug level that cause was invisible at exactly
            # the moment someone would be looking for it.
            logger.warning(
                f"effector: could not persist the browser session for "
                f"{self._session_domain} — {err}. The next run will start logged out."
            )

    def _storage_context(self):
        """Whatever on this lane can actually read cookies, or None.

        `self._context` is not always a BrowserContext. On the native engine, when the
        browser reports no contexts, the launch path falls back to using the BROWSER as
        the context because it has `new_page` — and a Browser has no `storage_state`.
        The result was `AttributeError: 'Browser' object has no attribute
        'storage_state'` swallowed by the save path's except, so on that lane the vault
        was never written and every run started logged out. Phase 2's whole point,
        silently undone the day the engine started launching.

        A page always knows its own context, so ask the page when the stored one cannot
        answer. Returns None rather than guessing, and the caller says so out loud.
        """
        if self._context is not None and hasattr(self._context, "storage_state"):
            return self._context
        page = self.page
        ctx = getattr(page, "context", None) if page is not None else None
        if ctx is not None and hasattr(ctx, "storage_state"):
            return ctx
        return None

    async def _pump_screenshot(self) -> bytes | None:
        """One frame for the live view, as small as the lane will give it.

        JPEG where the engine takes the argument: Playwright defaults to PNG. Measured
        on example.com at 1280x720, same page and same moment (2026-09-03):

            png        118,015 bytes
            jpeg q60    75,601 bytes
            jpeg q40    63,288 bytes

        so JPEG saves about a third, and the size is dominated by resolution rather than
        quality — dropping to q40 buys little and looks worse. Quality 60 matches what
        the screencast path has always asked for.

        Worth knowing rather than hiding: the screencast ALSO downscales to 800x600
        (_SCREENCAST_MAX_WIDTH/HEIGHT), and this does not — Playwright's screenshot has
        no resize and doing it here would mean decoding and re-encoding every frame on
        the agent's own CPU. So a fallback frame is bigger than a screencast frame, at a
        lower rate. At one a second that is a live view, not a bandwidth problem, but it
        is not free either.

        RemotePage ignores the kwargs (the extension decides its own format), so the
        fallback is not a rare path — it is the normal one on the user-browser lane.
        """
        # Stage 50 phase 1 — capture the SCREEN, not the page, wherever we own one.
        #
        # `page.screenshot()` photographs one Playwright Page object, so anything
        # rendering outside it is invisible: a popup, an OAuth window, a native file
        # picker, a JS alert(). That blind spot cost a live bug on 2026-09-03 (a human
        # took over to sign in with Google, the flow opened a second tab, and the view
        # froze on the first). Pointing the camera at the active page fixed that one
        # instance; grabbing the whole display removes the class.
        #
        # Falls back rather than failing: a display grab that does not work leaves the
        # page screenshot exactly as it was, which is a worse picture, not no picture.
        #
        # `getattr` for the same reason `_resolve_active_page` uses it: sessions built
        # via `EffectorSession.__new__` in the tests set only what they need.
        if getattr(self, "_display", None):
            frame = await self._capture_display_jpeg()
            if frame:
                return frame

        target = self._resolve_active_page()
        try:
            return await target.screenshot(type="jpeg", quality=_SCREENCAST_QUALITY)
        except TypeError:
            # An engine or page shim whose screenshot takes no format arguments.
            return await target.screenshot()

    async def _browser_bbox(self) -> tuple[int, int, int, int] | None:
        """The rectangle every visible browser window fits inside, or None.

        Read from X11 via xdotool, never from the page. `window.screenX`/`outerWidth`
        would be one `page.evaluate()` and no subprocess, but they are JS values on a
        page this package deliberately lies to about its window and screen — a crop
        computed from a spoofed number would cut the picture somewhere arbitrary.
        xdotool reads the server's own geometry, which the stealth layer cannot reach.

        A UNION rather than the active window: a popup opens as a second X window
        (measured — `window.open` with width/height gave X=700 Y=300 608x485 beside the
        main 1288x805), and the whole point of grabbing the display is to see the thing
        that is not the page we were already watching.

        One process, not one per window: xdotool chains, so `search ... getwindowgeometry
        --shell %@` reports them all in a single call. `--name .` rather than
        `--class chromium` because this has to work on the Gecko engine too.
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "xdotool", "search", "--onlyvisible", "--name", ".",
                "getwindowgeometry", "--shell", "%@",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env={**os.environ, "DISPLAY": getattr(self, "_display", None) or ""},
            )
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=_DISPLAY_GRAB_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return None
        except Exception:  # noqa: BLE001 — no windows, no xdotool, no display
            return None

        # `--shell` emits X=/Y=/WIDTH=/HEIGHT= once per window, in order.
        fields: dict[str, list[int]] = {"X": [], "Y": [], "WIDTH": [], "HEIGHT": []}
        for line in (out or b"").decode("utf-8", "replace").splitlines():
            key, _, value = line.partition("=")
            if key in fields:
                try:
                    fields[key].append(int(value))
                except ValueError:
                    pass

        count = min(len(v) for v in fields.values())
        if count == 0:
            return None

        left = min(fields["X"][:count])
        top = min(fields["Y"][:count])
        right = max(fields["X"][i] + fields["WIDTH"][i] for i in range(count))
        bottom = max(fields["Y"][i] + fields["HEIGHT"][i] for i in range(count))

        # A window may sit partly off-screen; scrot refuses a region starting outside
        # the root. Clamping the origin is enough — an over-wide region is clipped by
        # scrot itself, and a failed grab falls back to the page screenshot anyway.
        left, top = max(0, left), max(0, top)
        if right - left <= 0 or bottom - top <= 0:
            return None
        return left, top, right - left, bottom - top

    async def _capture_display_jpeg(self) -> bytes | None:
        """The whole X display as JPEG bytes, or None if it could not be grabbed.

        `scrot` rather than Pillow's ImageGrab: it is already installed for desktop
        automation (container/Dockerfile), already used against this same display by
        desktop/desktop_driver.py, and does not depend on Pillow having been built with
        XCB support — which the wheels do not guarantee and which would fail at runtime,
        in the container, rather than here.

        JPEG rather than the desktop path's PNG, chosen by file extension plus `-q`:
        measured on this display, PNG is ~118KB against ~75KB for JPEG q60, and this
        runs once a second for the whole run where the desktop path runs rarely.

        Non-blocking, unlike desktop_driver.capture_desktop_screenshot, which calls
        subprocess.run inside an async def. At that path's frequency it is survivable;
        at one-per-second it would stall the very event loop carrying takeover input and
        frame acks.
        """
        import tempfile
        import uuid

        tmp = Path(tempfile.gettempdir()) / f"effector-frame-{uuid.uuid4().hex}.jpg"
        # Crop to the browser rather than shipping the whole root window. Measured in
        # the real image 2026-09-03: a 1288x805 browser on a 1920x1080 display leaves
        # ~49% of every frame as black desktop — paid for on every frame, for nothing.
        # A None bbox means "could not tell", and the full display is the safe answer.
        bbox = await self._browser_bbox()
        crop = ["-a", ",".join(str(n) for n in bbox)] if bbox else []
        try:
            proc = await asyncio.create_subprocess_exec(
                "scrot", "--overwrite", *crop, "-q", str(_SCREENCAST_QUALITY), str(tmp),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                env={**os.environ, "DISPLAY": getattr(self, "_display", None) or ""},
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=_DISPLAY_GRAB_TIMEOUT_S)
            except asyncio.TimeoutError:
                # A hung grab must not wedge the pump, and must not leave a process
                # behind on a warm daemon that outlives this cycle.
                proc.kill()
                await proc.wait()
                logger.debug("effector: display grab timed out — falling back to the page")
                return None

            if proc.returncode != 0 or not tmp.exists():
                logger.debug(f"effector: display grab failed (scrot exit {proc.returncode})")
                return None
            return tmp.read_bytes()
        except FileNotFoundError:
            # No scrot on this image. Say it once per session at debug and let the page
            # screenshot carry the view.
            logger.debug("effector: scrot not installed — live view stays page-scoped")
            return None
        except Exception as err:  # noqa: BLE001
            logger.debug(f"effector: display grab failed — {err}")
            return None
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def _resolve_active_page(self) -> Any:
        """The page actually on screen right now, not the one launch happened to open.

        Falls back to `self.page` whenever there is no resolver, or the resolver itself
        is unhappy (no pages left, a closed context) — a screenshot of the wrong-but-
        alive tab beats no screenshot at all.

        `getattr`, not a direct read: several tests build a session via
        `EffectorSession.__new__` and set only `page`, bypassing `__init__` entirely, so
        the attribute may not exist on them at all.
        """
        resolver = getattr(self, "active_page_resolver", None)
        if resolver is not None:
            try:
                resolved = resolver()
                if resolved is not None:
                    return resolved
            except Exception as err:
                logger.debug(f"effector: active-page resolver failed, using launch page — {err}")
        return self.page

    async def _stop_frame_pump(self) -> None:
        pump, self._frame_pump = self._frame_pump, None
        if pump is None:
            return
        pump.cancel()
        try:
            await asyncio.wait_for(pump, timeout=2)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception as err:
            logger.debug(f"effector: live frame pump did not stop cleanly — {err}")

    async def _bounded(self, coro, seconds: float, what: str) -> bool:
        """Await `coro`, but never forever.

        stage45 gap F, found by the live harness: every await in teardown talks to the
        browser, and a browser that has crashed answers none of them. The crash-part of
        the harness detected the crash correctly and then hung in `__aexit__` — which
        would have made the whole crash feature worse than useless, since the loop would
        return a clean resumable result and the cycle would then hang forever instead of
        ending. A timeout here is what turns "we noticed the crash" into "we survived
        it".
        """
        try:
            await asyncio.wait_for(coro, timeout=seconds)
            return True
        except asyncio.TimeoutError:
            logger.warning(
                f"effector: {what} did not finish within {seconds:.0f}s during teardown "
                f"(the browser is probably gone) — moving on"
            )
        except Exception as err:
            logger.debug(f"effector: {what} failed during teardown — {err}")
        return False

    async def __aexit__(self, exc_type, exc, tb) -> None:
        # The pump reads self.page every tick, so it stops before anything below closes
        # the page underneath it. Same reasoning as the interceptor disarm that follows:
        # daemons are long-lived and reuse browsers, so anything left running outlives
        # its own run.
        await self._stop_frame_pump()

        # R4: disarm before anything else closes. Daemons are long-lived and reuse
        # browsers, so a leaked auto-attach handler outlives this session.
        if self._target_interceptor is not None:
            try:
                await self._target_interceptor.detach_all(self._browser_cdp)
            except Exception as err:
                logger.debug(f"effector: target interceptor detach failed — {err}")
            self._target_interceptor = None
            # Dropping the reference is not the same as closing it. On a pooled browser
            # the session stays open on the other side, so it is detached here rather
            # than left to be garbage-collected out of a process that never exits.
            if self._browser_cdp is not None and self._pooled is not None:
                try:
                    await self._bounded(self._browser_cdp.detach(), 5, "detaching the browser CDP session")
                except Exception as err:
                    logger.debug(f"effector: browser CDP detach failed — {err}")
            self._browser_cdp = None

        if self._remote:
            # Nothing local was started, so there is nothing local to tear down — and the
            # browser is the user's, so closing it is not ours to do. Only the HTTP client
            # goes — after the frame pump, which holds a reference to it.
            await self._stop_frame_pump()
            if self.page is not None:
                await self.page.close()
            return

        # Last chance to save anything the browser downloaded after the final step —
        # a click on the last turn, or a download that was still writing when the loop
        # ended. Playwright deletes its temp files when the context closes, which is
        # the next thing that happens on both paths below, so a file not saved here is
        # a file the run silently threw away.
        # A dead browser has no downloads left to hand over and no cookies left to
        # read: both calls go to the same process that is not answering. Skipping them
        # is not a lost capability, it is declining to wait on a corpse.
        crashed = self.crash.crashed
        if crashed:
            logger.warning(
                f"effector: tearing down after a crash ({self.crash.reason}) — skipping "
                f"the download drain and session save, both of which need a live browser"
            )
        else:
            await self._bounded(self.downloads.drain(), 30, "the final download drain")

        if self._native_engine:
            # The vault, not the plaintext file this used to write. Same call the
            # Chromium teardown makes, so the two lanes cannot drift apart on where a
            # login is stored or whether it is encrypted.
            await self._stop_frame_pump()
            await self._save_session_vault(crashed)
            try:
                self.crash.detach()
            except Exception as err:  # noqa: BLE001
                logger.debug(f"effector: crash watchdog detach failed — {err}")
            # This run's context goes even though the browser may stay. On the native
            # lane `self._context` can BE the browser (a build with no contexts), and
            # closing that would close the thing the pool is about to take back — so
            # only a real, separate context is closed here.
            if self._context is not None and self._context is not self._browser:
                await self._bounded(self._context.close(), 10, "closing the native context")
            await self._bounded(
                browser_pool.release(
                    self._pooled, discard=crashed or self._native_unpoolable,
                ),
                25, "returning the native browser",
            )
            self._pooled = self._browser = None
            return

        # Whichever of the two was feeding the live view, stop it. The pump now runs on
        # this lane too whenever there is no CDP screencast, so stopping only the
        # screencast here would leave a task screenshotting a closing browser.
        await self._stop_frame_pump()
        await self._bounded(self._stop_screencast(), 5, "stopping the screencast")

        await self._save_session_vault(crashed)

        # Everything this run hung on the BROWSER comes off before the browser is
        # returned. Listeners and CDP sessions are per-run; the browser is not.
        if self._pooled is not None:
            try:
                self.crash.detach()
            except Exception as err:  # noqa: BLE001
                logger.debug(f"effector: crash watchdog detach failed — {err}")
            if self._browser_cdp is not None:
                try:
                    await self._bounded(self._browser_cdp.detach(), 5, "detaching the browser CDP session")
                except Exception as err:  # noqa: BLE001
                    logger.debug(f"effector: browser CDP detach failed — {err}")
                self._browser_cdp = None

        # The context always goes: it holds this run's cookies, storage and proxy, and
        # nothing about it may reach the next run. The browser may stay.
        if self._context:
            await self._bounded(self._context.close(), 10, "closing the context")
        if self._pooled is not None:
            # A crash is not a state the next run should inherit, so a crashed browser is
            # retired rather than returned. When the pool is off, release() closes it and
            # this is exactly the old teardown.
            await self._bounded(
                browser_pool.release(self._pooled, discard=crashed), 25, "returning the browser",
            )
            self._pooled = self._browser = self._playwright = None
        else:
            if self._browser:
                await self._bounded(self._browser.close(), 10, "closing the browser")
            if self._playwright:
                await self._bounded(self._playwright.stop(), 10, "stopping playwright")
        if self._tls_virtualizer is not None:
            await self._tls_virtualizer.stop()
            self._tls_virtualizer = None
