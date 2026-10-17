"""Stealth verification against a REAL browser.

Every other stealth test asserts on the text of the injected script. That is why two
genuine bugs sat in it undetected until 2026-08-30, both of which only fail at
runtime and both of which silently disabled a whole layer:

* `navigator.permissions.query()` threw "Illegal invocation" on every call, because
  the faked PermissionStatus was built with `Object.create(PermissionStatus.prototype)`
  and then assigned `onchange`, running a real setter against an object with none of
  its internal slots. Ordinary sites calling that API broke.
* The plugin section threw "Cannot redefine property: application/pdf" — all five
  fake plugins declare the same two mime types, so the second `defineProperty` for a
  duplicate type on a non-configurable key aborted the section. `navigator.plugins`
  was therefore never spoofed at all.

Both were swallowed by the script's own per-section `catch (e) {}`, which is the
right resilience posture and also perfectly hides this class of failure. The
`no_layer_silently_failed` test below is the generic guard: it re-runs the script
with the swallowing catches instrumented and asserts nothing threw.

Skips cleanly when no Chromium is installed (CI images without browsers, a dev box
that never ran `playwright install`).
"""

from __future__ import annotations

import pytest

from nanoagent.agent.effector.stealth.fingerprint_pool import DEVICE_PROFILES
from nanoagent.agent.effector.stealth.stealth import build_stealth_init_script

PROFILE = DEVICE_PROFILES[0]
LANGUAGES = ("en-US", "en")


@pytest.fixture(scope="module")
def stealth_browser():
    """One browser for the whole module — launching is the expensive part. Nesting a
    second sync_playwright() inside this one is an error, so every test that needs
    its own context takes the browser from here."""
    playwright = pytest.importorskip("playwright.sync_api")

    with playwright.sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as err:  # no browser binary on this machine
            pytest.skip(f"no Chromium available: {err}")
        yield browser
        browser.close()


@pytest.fixture(scope="module")
def stealth_page(stealth_browser):
    context = stealth_browser.new_context(
        user_agent=PROFILE.user_agent, locale="en-US", timezone_id="America/New_York",
    )
    context.add_init_script(build_stealth_init_script(PROFILE, LANGUAGES))
    page = context.new_page()
    page.goto("about:blank")
    yield page
    context.close()


def test_no_layer_silently_failed(stealth_browser):
    """The generic guard. Each section swallows its own exceptions, so a layer that
    throws is indistinguishable from one that worked — unless you go looking."""
    script = build_stealth_init_script(PROFILE, LANGUAGES).replace(
        "} catch (e) {}", "} catch (e) { (window.__errs=window.__errs||[]).push(String(e)); }",
    )
    context = stealth_browser.new_context()
    context.add_init_script(script)
    page = context.new_page()
    page.goto("about:blank")
    errors = page.evaluate("() => window.__errs || []")
    context.close()

    assert errors == [], f"stealth layers threw and were silently swallowed: {errors}"


def test_navigator_carries_no_own_properties(stealth_page):
    """Real Chrome keeps every one of these on Navigator.prototype."""
    assert stealth_page.evaluate("() => Object.getOwnPropertyNames(navigator)") == []


def test_webdriver_is_false_and_lives_on_the_prototype(stealth_page):
    assert stealth_page.evaluate("() => navigator.webdriver") is False
    assert stealth_page.evaluate(
        "() => Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver') !== undefined"
    )


def test_patched_getters_still_look_native(stealth_page):
    source = stealth_page.evaluate(
        "() => Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get.toString()"
    )
    assert "[native code]" in source


def test_hardware_and_platform_match_the_profile(stealth_page):
    assert stealth_page.evaluate("() => navigator.hardwareConcurrency") == PROFILE.hardware_concurrency
    assert stealth_page.evaluate("() => navigator.deviceMemory") == PROFILE.device_memory
    assert stealth_page.evaluate("() => navigator.platform") == PROFILE.platform
    assert stealth_page.evaluate("() => navigator.languages") == list(LANGUAGES)


def test_client_hints_are_per_profile(stealth_page):
    values = stealth_page.evaluate(
        "async () => await navigator.userAgentData.getHighEntropyValues(['platformVersion','architecture'])"
    )
    assert values["platformVersion"] == PROFILE.platform_version
    assert values["architecture"] == PROFILE.architecture


def test_plugins_are_actually_spoofed(stealth_page):
    """Regression: the whole section used to abort on a duplicate mime type, so this
    returned the real (empty, in headless) plugin list."""
    assert stealth_page.evaluate("() => navigator.plugins.length") == 5
    assert stealth_page.evaluate("() => navigator.plugins[0].name") == "PDF Viewer"
    assert stealth_page.evaluate("() => !!navigator.plugins['PDF Viewer']") is True
    assert stealth_page.evaluate("() => navigator.plugins instanceof PluginArray") is True
    # A real MimeTypeArray holds each type once, however many plugins declare it.
    types = stealth_page.evaluate(
        "() => Array.from({length: navigator.mimeTypes.length}, (_, i) => navigator.mimeTypes[i].type)"
    )
    assert types == ["application/pdf", "text/pdf"]


def test_permissions_query_does_not_throw(stealth_page):
    """Regression: this raised "Illegal invocation" on every call, breaking the API
    for ordinary sites as well as announcing that something had patched it."""
    assert stealth_page.evaluate(
        "async () => (await navigator.permissions.query({name: 'notifications'})).state"
    ) == "prompt"
    assert stealth_page.evaluate("() => Notification.permission") == "default"


def test_permission_status_is_a_working_event_target(stealth_page):
    """It has to behave like a PermissionStatus, not just report the right string."""
    assert stealth_page.evaluate(
        """async () => {
          const s = await navigator.permissions.query({name: 'geolocation'});
          s.addEventListener('change', () => {});
          return s instanceof PermissionStatus && s.onchange === null;
        }"""
    ) is True


def test_canvas_fingerprint_is_stable_across_reads(stealth_page):
    """Deterministic noise is the whole point: randomisation is itself detectable by
    reading the same canvas twice and comparing."""
    assert stealth_page.evaluate(
        """() => {
          const c = document.createElement('canvas');
          c.width = 200; c.height = 50;
          const ctx = c.getContext('2d');
          ctx.font = '14px Arial'; ctx.fillText('probe', 2, 15);
          const a = c.toDataURL(), b = c.toDataURL();
          const g1 = ctx.getImageData(0, 0, 200, 50).data;
          const g2 = ctx.getImageData(0, 0, 200, 50).data;
          let same = true;
          for (let i = 0; i < g1.length; i++) { if (g1[i] !== g2[i]) { same = false; break; } }
          return a === b && same;
        }"""
    ) is True


def test_measure_text_is_noised_but_stable(stealth_page):
    """Font fingerprinting reads measureText().width; we perturb it per (font+text)
    by a fixed sub-pixel fraction. It must stay deterministic (a read-twice probe
    would catch randomisation), stay a real TextMetrics, and keep every other metric
    untouched."""
    r = stealth_page.evaluate(
        """() => {
          const c = document.createElement('canvas').getContext('2d');
          c.font = '16px Arial';
          const t = 'mmmmmmmmmmlli fingerprint';
          const a = c.measureText(t).width, b = c.measureText(t).width;
          const m = c.measureText(t);
          return {
            stable: a === b,
            isTextMetrics: m instanceof TextMetrics,
            hasAscent: 'fontBoundingBoxAscent' in m,
            widthIsFractional: m.width % 1 !== 0,
          };
        }"""
    )
    assert r["stable"] is True
    assert r["isTextMetrics"] is True
    assert r["hasAscent"] is True
    assert r["widthIsFractional"] is True  # the perturbation left a fractional part


def test_bounding_client_rect_is_left_alone(stealth_page):
    """Deliberate scope limit: DOM layout rects drive real page behaviour, so they
    are NOT noised — the tool has to keep completing tasks. Guard the decision so a
    later 'harden everything' pass doesn't silently break automation."""
    r = stealth_page.evaluate(
        """() => {
          const d = document.createElement('div');
          d.style.width = '123px'; d.style.height = '45px';
          document.body.appendChild(d);
          const box = d.getBoundingClientRect();
          return {w: box.width, h: box.height};
        }"""
    )
    assert r["w"] == 123
    assert r["h"] == 45


def test_every_advertised_webgl_extension_actually_resolves(stealth_page):
    """The claimed list is intersected with reality, so getSupportedExtensions and
    getExtension can never contradict each other."""
    result = stealth_page.evaluate(
        """() => {
          const gl = document.createElement('canvas').getContext('webgl');
          if (!gl) return null;
          const exts = gl.getSupportedExtensions();
          return {
            allResolve: exts.every(n => gl.getExtension(n) !== null),
            fakeIsNull: gl.getExtension('WEBGL_totally_fake_ext') === null,
            count: exts.length,
          };
        }"""
    )
    if result is None:
        pytest.skip("no WebGL in this browser build")
    assert result["allResolve"] is True
    assert result["fakeIsNull"] is True
    assert result["count"] > 0


def test_worker_navigator_matches_the_page(stealth_page):
    """Measured 2026-08-30: a Web Worker reported the REAL host (4 cores / Win32)
    while the page claimed the profile (8 / Linux) — a page-vs-worker contradiction,
    because add_init_script never runs in a worker. Section 16 wraps classic
    blob:/data: workers so WorkerNavigator matches the page."""
    r = stealth_page.evaluate(
        """async () => {
          const src = "self.onmessage=()=>postMessage({hc:navigator.hardwareConcurrency,plat:navigator.platform,lang:navigator.language});";
          const w = new Worker(URL.createObjectURL(new Blob([src])));
          const worker = await new Promise(res => { w.onmessage = e => res(e.data); w.postMessage(1); });
          return {
            worker,
            page: {hc: navigator.hardwareConcurrency, plat: navigator.platform, lang: navigator.language},
          };
        }"""
    )
    assert r["worker"]["hc"] == PROFILE.hardware_concurrency
    assert r["worker"]["plat"] == PROFILE.platform
    # The point is parity: worker and page must not disagree.
    assert r["worker"]["hc"] == r["page"]["hc"]
    assert r["worker"]["plat"] == r["page"]["plat"]
    assert r["worker"]["lang"] == r["page"]["lang"]


def test_worker_wrapping_does_not_break_normal_workers(stealth_page):
    """The tool's job is completing tasks, so a site's real workers must keep
    working — a wrapping failure has to fall through to a plain worker."""
    assert stealth_page.evaluate(
        """async () => {
          const w = new Worker(URL.createObjectURL(new Blob(["self.onmessage=e=>postMessage(e.data*7)"])));
          return await new Promise(res => { w.onmessage = e => res(e.data); w.postMessage(6); });
        }"""
    ) == 42


def test_wrapped_worker_constructor_still_looks_native(stealth_page):
    assert stealth_page.evaluate(
        "() => Function.prototype.toString.call(Worker)"
    ) == "function Worker() { [native code] }"


def test_window_reports_browser_chrome_and_the_profile_screen(stealth_page):
    assert stealth_page.evaluate("() => screen.width") == PROFILE.screen_width
    assert stealth_page.evaluate("() => screen.availHeight") == PROFILE.screen_avail_height
    assert stealth_page.evaluate("() => window.outerHeight - window.innerHeight") > 0
