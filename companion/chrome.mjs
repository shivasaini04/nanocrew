/**
 * The browser half of the companion: a dedicated Chrome, driven over CDP.
 *
 * This implements the same eight capabilities `extension/background.js` implements, with
 * the same payloads and the same return shapes, because the container must not be able to
 * tell the two apart (see companion/README.md). Where a handler looks odd, it is usually
 * because it is matching the extension rather than doing the obvious CDP thing.
 *
 * ## Why a dedicated profile and not the user's own
 *
 * Chrome only opens `--remote-debugging-port` at startup and holds a one-process lock per
 * `--user-data-dir`. Attaching to the user's everyday browser therefore means killing it
 * first — which is exactly what Codex does, and why it demands you close every window.
 * A separate profile costs one manual login per site and avoids that entirely. Measured
 * 2026-09-05 (stage 52 spike, Q1/Q4): a second profile runs alongside the user's Chrome
 * with no admin prompt, and its logins survive a restart.
 *
 * ## Why input goes through CDP's Input domain
 *
 * Same reason the extension uses chrome.debugger: a synthetic MouseEvent arrives with
 * isTrusted=false, and native controls (a real <select>, a file picker) ignore it.
 * Input.dispatchMouseEvent is indistinguishable from a human click. We are already
 * speaking CDP, so this is direct rather than via a debugger shim — but the events on the
 * wire are identical.
 */

import { spawn } from 'node:child_process';

import { locatorQuery, locatorAct } from './locator.mjs';
import { NAMED_PROBES } from './probes.mjs';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where Chrome usually is, per platform. First hit wins. */
const CHROME_CANDIDATES = {
    win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
};

export function findChrome(explicit) {
    if (explicit) {
        if (!existsSync(explicit)) throw new Error(`no Chrome at ${explicit}`);
        return explicit;
    }
    for (const p of CHROME_CANDIDATES[process.platform] ?? []) {
        if (existsSync(p)) return p;
    }
    throw new Error(
        `could not find Chrome for platform ${process.platform} — pass --chrome <path>`,
    );
}

/**
 * Start Chrome on its own profile with a debug port, and wait until it answers.
 *
 * Returns { proc, wsUrl, profileDir }. The caller owns stopping it.
 */
export async function launchChrome({ chromePath, profileDir, port, headless = false }) {
    mkdirSync(profileDir, { recursive: true });

    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        // Chrome's own "restore pages?" bubble after an unclean exit steals focus and
        // covers the page the agent is about to act on.
        '--hide-crash-restore-bubble',
    ];
    if (headless) args.push('--headless=new');

    const proc = spawn(chromePath, args, { stdio: 'ignore' });

    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/json/version`);
            if (r.ok) {
                const v = await r.json();
                return { proc, wsUrl: v.webSocketDebuggerUrl, version: v.Browser, profileDir };
            }
        } catch {
            /* not up yet */
        }
        await new Promise(r => setTimeout(r, 250));
    }

    proc.kill();
    throw new Error(
        `Chrome did not open a debug port on ${port} within 25s. If a Chrome is already ` +
        `running on this profile directory, close it — Chrome allows one process per profile.`,
    );
}

/**
 * The capability handlers, closed over a Playwright browser.
 *
 * `page()` resolves the tab a command applies to. The extension calls this `targetTab()`
 * and picks the active tab of the last-focused window; the nearest equivalent here is the
 * most recently used page in the default context. Both mean "whatever the user is looking
 * at", which is the contract the container relies on.
 */
export function makeHandlers(browserOrGetter, {
    navigationTimeoutMs = 30_000,
    onPage = null,
    resolvePage = null,
} = {}) {
    // Accept either a Browser or a function that returns a live one.
    //
    // connectOverCDP hands back an object bound to ONE CDP connection: if that drops —
    // the user quits Chrome, the machine sleeps, Chrome restarts itself after an update —
    // the object is dead for good, and every later command fails with a confusing "no
    // browser context". The orchestrator socket already reconnects; the browser link has
    // to as well, or a companion that has been running all day is a companion that
    // silently stopped working hours ago. Found by a live cycle, 2026-09-06.
    const getBrowser = typeof browserOrGetter === 'function'
        ? browserOrGetter
        : async () => browserOrGetter;

    /** The page commands apply to. Created on demand so a fresh profile still works. */
    async function page() {
        // A host that knows which page is the agent's says so.
        //
        // The CLI drives a dedicated Chrome where "the last page" is the right answer.
        // The desktop app cannot use that rule: Electron exposes the dashboard, the
        // toolbar and the divider as CDP page targets too, so picking by position would
        // drive whichever happened to load last — quite possibly the dashboard the user
        // is reading. See desktop/agent-lane.js.
        if (resolvePage) {
            const chosen = await resolvePage();
            if (!chosen) throw new Error('the agent browser panel is not available');
            if (onPage) {
                try { await onPage(chosen); } catch { /* watching is never load-bearing */ }
            }
            return chosen;
        }

        const browser = await getBrowser();
        let ctx = browser.contexts()[0];
        if (!ctx) {
            // A live browser with no context is a real state — every window closed, or a
            // reconnect that landed before Chrome had rebuilt one. Making one is correct
            // and cheap; failing here would strand a cycle for no reason.
            ctx = await browser.newContext();
        }
        const pages = ctx.pages().filter(p => !p.isClosed());
        // Last is the most recently opened, which matches the extension's "active tab"
        // closely enough for every use effector makes of it.
        const target = pages.length === 0 ? await ctx.newPage() : pages[pages.length - 1];
        // Tell whoever is watching which page commands are going to. The live view uses
        // this to follow the agent across tabs — a screencast is bound to one page, so
        // without it the panel would keep showing a tab nothing is happening in.
        if (onPage) {
            try { await onPage(target); } catch { /* watching is never load-bearing */ }
        }
        return target;
    }

    /**
     * Run a probe. The container names a probe and supplies args; unlike the extension we
     * can also accept the SCRIPT itself, because no CSP forbids it here.
     *
     * Result shape matches the extension exactly: one entry per frame, with frameId,
     * result and an optional error. RemotePage.capture_dom_snapshot walks that shape.
     */
    async function pageProbe(payload) {
        const p = await page();
        const { probe, script, args, allFrames } = payload;

        // Two ways in, and the NAMED one is what the container actually uses.
        //
        // The container names a probe because the extension lane cannot receive a script
        // (MV3 CSP), so the vocabulary is a fixed registry on the controller side. The
        // companion has no such limit and `script` remains the richer path, but assuming
        // the container would use it is what made the first live cycle fail with
        // "unknown probe: installFrameBridge". See probes.mjs.
        const known = probe ? NAMED_PROBES[probe] : null;
        const source = script ?? known?.source;
        if (!source) {
            throw new Error(
                `unknown probe: ${probe}. This controller serves ` +
                `${Object.keys(NAMED_PROBES).join(', ')}, or send { script } instead.`,
            );
        }

        // Playwright's evaluate takes exactly ONE argument, which it serialises and hands
        // to the function — it is not a spread. The extension's chrome.scripting takes an
        // `args` ARRAY and spreads it, so the two differ here and the container follows
        // Playwright: dom_snapshot.py calls evaluate_isolated(frame, JS, selectors) with a
        // single value. Spreading here made a two-parameter probe receive only its first
        // argument and return undefined -> null. Caught by the arg-passing test.
        const supplied = args ?? [];
        const arg = Array.isArray(supplied) && supplied.length <= 1
            ? (supplied.length === 1 ? supplied[0] : known?.args?.())
            : supplied;

        // A named probe carries its own frame scope, matching the extension's registry:
        // `snapshot` and the frame bridge are meaningless in the main frame alone.
        const everyFrame = allFrames ?? known?.allFrames ?? false;
        const frames = everyFrame ? p.frames() : [p.mainFrame()];
        const out = [];
        for (const [i, frame] of frames.entries()) {
            try {
                // Isolated world, like the extension: reads the DOM, cannot be seen by or
                // tamper with page JavaScript.
                const result = await frame.evaluate(
                    new Function(`return (${source})`)(),
                    arg,
                );
                out.push({ frameId: i, result });
            } catch (err) {
                // One broken frame must not fail the snapshot — a cross-origin frame we
                // cannot reach is a frame we drop, exactly as the extension does.
                out.push({ frameId: i, result: null, error: String(err?.message ?? err) });
            }
        }
        return out;
    }

    async function pageInfo() {
        const p = await page();
        return await p.evaluate(() => ({
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            scroll: { x: scrollX, y: scrollY },
        }));
    }

    async function pageNavigate(payload) {
        const url = String(payload.url ?? '');
        // Same rule as the extension, and for the same reason: file:// or
        // chrome-extension:// in the user's own browser is a much larger hole than a bad
        // click. This is a security boundary, not a convenience check.
        if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) urls may be navigated to');
        const p = await page();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs });
        return { ok: true, url: p.url() };
    }

    async function pageScreenshot() {
        const p = await page();
        const buf = await p.screenshot({ type: 'jpeg', quality: 70 });
        // The extension returns a data URL and RemotePage.screenshot() parses one, so
        // this must too — a raw buffer would be silently wrong.
        return { dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` };
    }

    async function inputMouse(payload) {
        const p = await page();
        const { x, y, type = 'click', button = 'left', clickCount = 1 } = payload;
        if (type === 'move') {
            await p.mouse.move(x, y);
            return { ok: true };
        }
        // Move before pressing: a click with no preceding move skips hover state, and
        // menus that open on hover are simply not open when the click lands. The
        // extension has the same two-step for the same reason.
        await p.mouse.move(x, y);
        await p.mouse.click(x, y, { button, clickCount });
        return { ok: true };
    }

    async function inputKey(payload) {
        const p = await page();
        if (typeof payload.text === 'string') {
            // insertText, not per-character keys: handles IME, emoji and pasted-looking
            // input in one call.
            await p.keyboard.insertText(payload.text);
            return { ok: true };
        }
        await p.keyboard.press(String(payload.key ?? ''));
        return { ok: true };
    }

    async function inputScroll(payload) {
        const p = await page();
        const { x = 0, y = 0, deltaX = 0, deltaY = 0 } = payload;
        // A real wheel event at a POINT, not window.scrollBy: infinite scroll and inner
        // scroll containers listen for wheel, and scrollBy would always move the document.
        await p.mouse.move(x, y);
        await p.mouse.wheel(deltaX, deltaY);
        return { ok: true };
    }

    return {
        'controller.noop': async () => ({ ok: true }),
        // stage 52 step 3: the two the extension lane cannot have. See locator.mjs —
        // these are the same power as input.mouse, aimed properly.
        'locator.query': async payload => locatorQuery(await page(), payload),
        'locator.act': async payload => locatorAct(await page(), payload),
        'page.info': pageInfo,
        'page.navigate': pageNavigate,
        'page.probe': pageProbe,
        'page.screenshot': pageScreenshot,
        'input.mouse': inputMouse,
        'input.key': inputKey,
        'input.scroll': inputScroll,
    };
}

export { NAMED_PROBES };
