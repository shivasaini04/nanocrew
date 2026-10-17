/**
 * NanoCrew Browser Bridge — service worker (stage 45 doc 05, phase 2).
 *
 * Registers with the broker, holds one WebSocket, and executes the four primitives. The
 * action vocabulary is NOT here: this file knows how to read a page, move a mouse and
 * press a key, and nothing about forms, logins or checkouts. That stays in the container,
 * which is why adding an effector action needs no extension release.
 *
 * Everything it can do is one of:
 *   page.info        url / title / viewport of the target tab
 *   page.probe       a DOM-reading script, ISOLATED world, all frames
 *   page.screenshot  visible tab, as a data URL
 *   input.mouse      trusted click/move via chrome.debugger + CDP
 *   input.key        trusted typing via CDP insertText / dispatchKeyEvent
 */

import { snapshot, pageContent, INTERACTIVE_SELECTORS } from './probes.generated.js';

const PROTOCOL_VERSION = 1;
const RECONNECT_MS = 3000;

/** Capabilities this build can honour. Asking for more than you implement is a lie the
 *  broker will believe — it grants from this list and then dispatches against it. */
const CAPABILITIES = ['controller.noop', 'page.info', 'page.probe', 'page.screenshot', 'page.navigate', 'input.mouse', 'input.key', 'input.scroll'];

let socket = null;
/** Whether the user wants a connection. The reconnect timer honours it, so Disconnect
 *  stays disconnected and a dropped socket still comes back on its own. */
let wanted = false;
let state = { connected: false, server: '', capabilities: null, error: '' };

// ─── Identity ───────────────────────────────────────────────────────────────

/** Stable per-installation id, so re-registering is the SAME controller and the broker's
 *  re-attach path (rather than its detach path) is what runs after a worker restart. */
async function controllerId() {
    const got = await chrome.storage.local.get('controllerId');
    if (got.controllerId) return got.controllerId;
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ controllerId: id });
    return id;
}

// ─── The domain allowlist ───────────────────────────────────────────────────
//
// stage45 doc 05, a phase-4 mitigation pulled forward to land with the wiring: the only
// place this CAN be enforced is here. The container names a capability; the extension is
// what turns that into a command against a real tab, so a compromised container reaching
// for a bank tab has to be stopped on this side of the bridge.
//
// Default is deny — an empty list allows nothing. That leaves the lane inert until someone
// says which sites it may touch, which is the right way round for a browser signed into
// the user's life. The popup is where the list is edited.

const OPEN_CAPABILITIES = new Set(['controller.noop']);

async function accessSettings() {
    const got = await chrome.storage.local.get(['allowlist', 'allowAll']);
    return {
        allowlist: Array.isArray(got.allowlist) ? got.allowlist : [],
        allowAll: got.allowAll === true,
    };
}

/** Host suffix match: "example.com" covers example.com and any subdomain, nothing else. */
function hostAllowed(url, { allowlist, allowAll }) {
    let host;
    try {
        const u = new URL(url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        host = u.hostname.toLowerCase();
    } catch {
        return false;
    }
    if (allowAll) return true;
    return allowlist.some(raw => {
        const pattern = String(raw).trim().toLowerCase().replace(/^\*\./, '');
        if (!pattern) return false;
        return host === pattern || host.endsWith(`.${pattern}`);
    });
}

/**
 * Refuse anything aimed at a page the user has not allowed.
 *
 * Checked against the tab as it is NOW, on every command — not once at connect time — so
 * a user who browses to their bank mid-run takes the agent's access away with them. A
 * navigate is checked twice: where the tab is, and where it is being sent.
 */
async function guardCapability(capability, payload) {
    if (OPEN_CAPABILITIES.has(capability)) return;
    const settings = await accessSettings();
    const tab = await targetTab();
    const explain = where => `blocked: ${where} is not on this browser's allowlist — `
        + `open the NanoCrew Bridge popup to change what agents may touch`;
    if (!hostAllowed(tab.url ?? '', settings)) throw new Error(explain(tab.url || 'this tab'));
    if (capability === 'page.navigate') {
        const dest = String((payload ?? {}).url ?? '');
        if (!hostAllowed(dest, settings)) throw new Error(explain(dest || 'that url'));
    }
}

// ─── The primitives ─────────────────────────────────────────────────────────

async function targetTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) throw new Error('no active tab');
    return tab;
}

/**
 * The probes this build carries, by name.
 *
 * The container NAMES a probe; it cannot send one. MV3's extension CSP forbids building a
 * function from a string even in the isolated world — measured 2026-08-30: "Evaluating a
 * string as JavaScript violates ... 'unsafe-eval' is not an allowed source". Chrome's
 * executeScript({func}) serialises a real function instead, which involves no eval.
 *
 * That is a stronger position than the one doc 05 designed for, not a weaker one: there is
 * no path by which arbitrary code reaches a logged-in page through the base tier, and it is
 * Chrome enforcing that rather than our own discipline. The cost is that changing a probe
 * needs an extension release, which is why the tunable part (the selector list) travels as
 * an argument.
 *
 * `snapshot` is generated from dom_snapshot.py so there is one source, not a copy that
 * drifts. Every probe must be self-contained — a serialised function keeps no closure.
 */
const PROBES = {
    /** capture_dom_snapshot's element query. */
    snapshot: { func: snapshot, args: () => [INTERACTIVE_SELECTORS], allFrames: true },

    /** Where this frame sits on the page, as placed by its parent. */
    frameOrigin: { func: () => (window.__nc_origin ?? null), allFrames: true },

    /**
     * Install the placement bridge in every frame. Each frame measures its own iframes and
     * tells each child its page-absolute origin; the child stores it and recurses. Proven
     * against Playwright's frame_element() chain in phase 0, spike 1, including
     * cross-origin and nested cross-origin frames.
     */
    installFrameBridge: {
        allFrames: true,
        func: () => {
            if (window.__nc_seed) return true;         // already installed in this frame
            window.__nc_origin = (window === window.top) ? { x: 0, y: 0 } : null;
            const contentOrigin = el => {
                const r = el.getBoundingClientRect();
                const s = getComputedStyle(el);
                const n = v => parseFloat(v) || 0;
                return { x: r.left + n(s.borderLeftWidth) + n(s.paddingLeft),
                         y: r.top + n(s.borderTopWidth) + n(s.paddingTop) };
            };
            window.__nc_seed = () => {
                const mine = window.__nc_origin;
                if (!mine) return false;
                for (const el of document.querySelectorAll('iframe')) {
                    const off = contentOrigin(el);
                    try {
                        el.contentWindow.postMessage(
                            { __nc: 'origin', x: mine.x + off.x, y: mine.y + off.y }, '*');
                    } catch (e) { /* a child we cannot reach is a frame we will drop */ }
                }
                return true;
            };
            window.addEventListener('message', ev => {
                const d = ev.data;
                if (!d || d.__nc !== 'origin') return;
                if (ev.source !== window.parent) return;   // only our own parent may place us
                // Re-placement is required, not a hazard: origins are viewport-relative and
                // a scroll staleness them all, and a parent cannot reach across an origin
                // boundary to reset a child. Phase 0 measured a child 900px wrong after a
                // scroll when this was immutable.
                window.__nc_origin = { x: d.x, y: d.y };
                window.__nc_seed();
            }, false);
            return true;
        },
    },

    /**
     * Read text, because the remote lane has no Locator to read it with.
     *
     * Found live 2026-08-31, first real task on this lane: `extract` is the one effector
     * action that had no coordinate path. Its schema branch calls page.locator (refused
     * here) inside a bare except, and its target branch does nothing at all when the
     * target resolves to a coordinate — so extract always returned {} and the model
     * looped asking for text it was never going to get.
     *
     * Runs in every frame, which the local lane's schema branch still does not (see
     * 03-hard.md test 3.3). Selectors travel as an argument; the code does not.
     */
    extractText: {
        allFrames: true,
        func: (spec) => {
            const CAP = 6000;
            const clean = el => ((el && (el.innerText || el.textContent)) || '').replace(/\s+\n/g, '\n').trim().slice(0, CAP);

            if (spec && Array.isArray(spec.selectors) && spec.selectors.length) {
                const out = {};
                for (const sel of spec.selectors) {
                    try {
                        const el = document.querySelector(sel);
                        if (el) out[sel] = clean(el);
                    } catch (e) { /* a selector this frame cannot parse is not this frame's */ }
                }
                return out;
            }

            if (spec && spec.point) {
                // The point is page-absolute; every frame holds its own offset, so each
                // one asks about its own local coordinates and the caller keeps the
                // deepest answer. A frame with no origin cannot place the point at all
                // and says so rather than guessing.
                const origin = (window === window.top) ? { x: 0, y: 0 } : window.__nc_origin;
                if (!origin) return null;
                const el = document.elementFromPoint(spec.point.x - origin.x, spec.point.y - origin.y);
                return el ? { point: clean(el) } : null;
            }

            return { body: clean(document.body) };
        },
    },

    /** What the page SAYS — the other half of a snapshot. See dom_snapshot.py. */
    pageContent: { func: pageContent, allFrames: false },

    /** Re-place the whole tree from the top. Runs immediately before every snapshot. */
    seedFrames: { func: () => (window.__nc_seed ? window.__nc_seed() : false), allFrames: false },
};

async function pageProbe(payload) {
    const tab = await targetTab();
    const probe = PROBES[payload.probe];
    if (!probe) throw new Error(`unknown probe: ${payload.probe}`);

    const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: payload.allFrames ?? probe.allFrames ?? false },
        world: 'ISOLATED',
        func: probe.func,
        args: payload.args ?? (probe.args ? probe.args() : []),
    });
    return results.map(r => ({
        frameId: r.frameId,
        result: r.result,
        error: r.error ? String(r.error) : undefined,
    }));
}

async function pageInfo() {
    const tab = await targetTab();
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'ISOLATED',
        func: () => ({
            url: location.href,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            scroll: { x: scrollX, y: scrollY },
        }),
    });
    return result;
}

async function pageScreenshot() {
    const tab = await targetTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    return { dataUrl };
}

// ─── Input ──────────────────────────────────────────────────────────────────
//
// Through chrome.debugger + CDP, not synthetic events. Measured 2026-08-30
// (spikes/input_trust.py): a MouseEvent dispatched from the isolated world reaches page
// listeners but arrives with isTrusted=false, while CDP's Input.dispatchMouseEvent is
// indistinguishable from a human click. That difference is not cosmetic — native controls
// (a real <select>, a file picker) and anything that checks isTrusted only answer to the
// trusted one, and "works like a human" is the entire point of this lane.
//
// The cost is the "NanoCrew Bridge started debugging this browser" banner. That is a
// FEATURE here: doc 05 lists a visible indicator as a required mitigation, and Chrome
// provides one we cannot suppress even if we wanted to.
//
// Known limit: chrome.debugger is exclusive. It cannot attach while DevTools is open on
// the same tab, and the user opening DevTools mid-run will end the session.

const attached = new Set();

async function ensureDebugger(tabId) {
    if (attached.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, '1.3');
    attached.add(tabId);
}

/** Detach everything. Called when the socket drops so the banner does not outlive the run. */
async function releaseDebugger() {
    for (const tabId of [...attached]) {
        try { await chrome.debugger.detach({ tabId }); } catch { /* tab may be gone */ }
        attached.delete(tabId);
    }
}

async function inputMouse(payload) {
    const tab = await targetTab();
    await ensureDebugger(tab.id);
    const { x, y, type = 'click', button = 'left', clickCount = 1 } = payload;
    const send = (t, extra = {}) => chrome.debugger.sendCommand(
        { tabId: tab.id }, 'Input.dispatchMouseEvent', { x, y, button, ...extra, type: t });

    if (type === 'move') { await send('mouseMoved'); return { ok: true }; }
    // Move first: a click with no preceding move skips hover state, and menus that open
    // on hover simply are not open when the click lands.
    await send('mouseMoved');
    await send('mousePressed', { clickCount });
    await send('mouseReleased', { clickCount });
    return { ok: true };
}

async function inputKey(payload) {
    const tab = await targetTab();
    await ensureDebugger(tab.id);
    if (typeof payload.text === 'string') {
        // insertText handles IME, emoji and pasted-looking input in one call, which
        // per-character key events do not.
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.insertText', { text: payload.text });
        return { ok: true };
    }
    const key = String(payload.key ?? '');
    for (const type of ['keyDown', 'keyUp']) {
        await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchKeyEvent', { type, key, windowsVirtualKeyCode: payload.code ?? 0 });
    }
    return { ok: true };
}

async function inputScroll(payload) {
    // A real wheel event, not window.scrollBy. The difference matters on the pages this
    // is for: infinite scroll, lazy-loaded images and sticky headers listen for wheel,
    // and dispatching at a POINT is what lets an inner scroll container receive it —
    // scrollBy would always move the document instead. Keyboard PageDown covers the
    // simple case and is what this lane had before; it cannot do either of those.
    const tab = await targetTab();
    await ensureDebugger(tab.id);
    const { x = 0, y = 0, deltaX = 0, deltaY = 0 } = payload;
    await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y, deltaX, deltaY,
    });
    return { ok: true };
}

async function pageNavigate(payload) {
    const tab = await targetTab();
    const url = String(payload.url ?? '');
    // http/https only. A command that could open file:// or chrome-extension:// in the
    // user's own browser is a much larger hole than a bad click.
    if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) urls may be navigated to');
    await chrome.tabs.update(tab.id, { url });
    return { ok: true, url };
}

const HANDLERS = {
    'controller.noop': async () => ({ ok: true }),
    'page.info': pageInfo,
    'page.navigate': pageNavigate,
    'page.probe': pageProbe,
    'page.screenshot': pageScreenshot,
    'input.mouse': inputMouse,
    'input.key': inputKey,
    'input.scroll': inputScroll,
};

// ─── Transport ──────────────────────────────────────────────────────────────

async function connect(serverBase, opts = {}) {
    disconnect({ tellServer: false });
    const base = (serverBase || state.server || '').replace(/\/+$/, '');
    if (!base) throw new Error('no server configured');

    // Cookie-authenticated: the user is signed into the dashboard in this browser, and
    // that is what says who this controller is. The body never names a principal.
    const res = await fetch(`${base}/api/browser-control/register`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            browserProfileId: 'default',
            controllerId: await controllerId(),
            capabilities: CAPABILITIES,
            // Only a human clicking Connect lifts a stop. The reconnect timer below calls
            // this same function without it, so a dropped socket comes back and a stopped
            // one stays stopped.
            resume: opts.resume === true,
        }),
    });
    if (res.status === 423) {
        // Stopped by the user. Give up rather than retry — retrying is how a kill switch
        // becomes a three-second pause.
        wanted = false;
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'browser control is stopped — click Connect to allow it again');
    }
    if (!res.ok) throw new Error(`register failed: ${res.status} ${res.status === 401 ? '(sign in to the dashboard first)' : ''}`);
    const reg = await res.json();

    const wsUrl = `${base.replace(/^http/, 'ws')}${reg.wsPath}?ticket=${encodeURIComponent(reg.ticket)}`;
    socket = new WebSocket(wsUrl);
    wanted = true;

    // Resolved when the socket is actually open, rejected if it never gets there. connect()
    // waits on this before returning, because its return value IS what the popup renders:
    // measured 2026-08-31, returning the pre-open state made every successful connection
    // report "not connected" until the popup was reopened.
    const ws = socket;
    const opened = new Promise((resolve, reject) => {
        const done = fn => {
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('close', onClose);
            fn();
        };
        const onOpen = () => done(resolve);
        const onError = () => done(() => reject(new Error('could not reach the server')));
        // A close before open is the server refusing the upgrade — a burnt or expired
        // ticket (4001) or a protocol mismatch (4002). Both are worth showing verbatim.
        const onClose = ev => done(() => reject(new Error(
            ev.code === 4002 ? 'server speaks a different bridge protocol — update the extension'
                : ev.code === 4001 ? 'registration ticket rejected'
                : `connection closed before it opened (${ev.code})`)));
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        ws.addEventListener('close', onClose);
    });

    socket.onopen = () => {
        socket.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
        chrome.storage.local.set({ server: base });
    };

    socket.onmessage = async ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t !== 'cmd') return;

        const handler = HANDLERS[msg.capability];
        if (!handler) {
            // The broker should never dispatch a capability we did not advertise, so this
            // is a bug rather than a normal path — reported, not silently dropped.
            socket.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: `unimplemented: ${msg.capability}` }));
            return;
        }
        try {
            await guardCapability(msg.capability, msg.payload ?? {});
            const result = await handler(msg.payload ?? {});
            socket.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }));
        } catch (err) {
            socket.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: String(err && err.message || err) }));
        }
    };

    socket.onclose = () => {
        state = { ...state, connected: false };
        // The broker treats a drop as recoverable and keeps in-flight work for the same
        // identity, so reconnecting with the SAME controllerId is what lets a command that
        // was running survive a service-worker restart.
        setTimeout(() => { if (wanted && !state.connected && state.server) connect(state.server, { resume: false }).catch(() => {}); }, RECONNECT_MS);
    };

    socket.onerror = () => { state = { ...state, error: 'socket error' }; };

    await opened;
    // Set the state HERE rather than in onopen. A promise resolved from one listener
    // continues at the next microtask checkpoint, which happens between listeners — so a
    // `return state` after this await ran before onopen had touched it, and the popup
    // rendered the pre-connection state on every successful connect (measured 2026-08-31).
    state = { connected: true, server: base, capabilities: reg.capabilities, error: '' };
    return state;
}

function disconnect(opts = {}) {
    // Deliberate teardown: clear the intent BEFORE closing, so the onclose reconnect timer
    // does not bring the socket straight back up. Measured 2026-08-31: it did, three
    // seconds after every click of Stop.
    wanted = false;
    // Tell the server too. Closing this socket stops THIS worker talking; halting the
    // broker cancels whatever was in flight, refuses anything else still holding a route
    // to this browser, and survives the extension reconnecting. That is what makes Stop
    // work while the agent is hung.
    if (opts.tellServer !== false) {
        const base = state.server || '';
        if (base) {
            fetch(`${base}/api/browser-control/stop`, { method: 'POST', credentials: 'include' })
                .catch(() => { /* the socket close below still stands on its own */ });
        }
    }
    if (socket) { try { socket.close(); } catch { /* already gone */ } socket = null; }
    // Drop the debugger with the socket, so the banner never outlives the connection that
    // justified it.
    releaseDebugger().catch(() => {});
    state = { ...state, connected: false };
}

// ─── Popup wiring ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.nc === 'status') {
        Promise.all([chrome.storage.local.get('server'), accessSettings()])
            .then(([g, access]) => reply({ ...state, server: state.server || g.server || '', ...access }));
        return true;
    }
    if (msg?.nc === 'connect') {
        // A click IS the human action that lifts a stop.
        connect(msg.server, { resume: true })
            .then(reply)
            .catch(e => reply({ ...state, connected: false, error: String(e.message || e) }));
        return true;
    }
    if (msg?.nc === 'disconnect') { disconnect(); reply(state); return true; }
    // Both of these reply with the WHOLE state, not just the settings they touched: the
    // popup renders whatever comes back, so a reply missing `connected` reads to the user
    // as "saving your allowlist disconnected the bridge".
    if (msg?.nc === 'access') { accessSettings().then(a => reply({ ...state, ...a })); return true; }
    if (msg?.nc === 'setAccess') {
        chrome.storage.local
            .set({ allowlist: msg.allowlist ?? [], allowAll: msg.allowAll === true })
            .then(() => accessSettings().then(a => reply({ ...state, ...a })));
        return true;
    }
    return false;
});

// ─── Test seam ──────────────────────────────────────────────────────────────
//
// A service worker declared as a module has no global scope, so a harness cannot reach
// its functions. The phase-2 spike in docs/research/stage45/spikes/probe_e2e.py drives
// these directly to prove the probe path without needing a running server. Nothing in the
// extension's own code paths reads this.
globalThis.__nc_bridge = { hostAllowed, guardCapability, accessSettings, pageInfo, pageNavigate, pageProbe, pageScreenshot, inputMouse, inputKey, inputScroll, releaseDebugger, connect, disconnect, HANDLERS, CAPABILITIES, PROBES };
