/**
 * The companion, end to end against the real broker.
 *
 * This is deliberately not a unit test with a mocked socket. The thing most likely to be
 * wrong about a new controller is the WIRE — a payload shaped almost-right, a result the
 * container cannot parse, a hello that arrives too late. Only a real broker, a real
 * upgrade handler and a real Chrome catch that, so this drives all three.
 *
 * Chrome is required. Where it is absent (CI without a browser), the browser-driving
 * tests skip rather than fail: a machine with no Chrome cannot answer the question these
 * tests ask, and a red suite that means "no browser here" trains people to ignore red.
 */
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import {
    browserBroker,
    derivePrincipal,
    BROWSER_CONTROL_PROTOCOL_VERSION,
    type ControllerScope,
} from '../src/agents/browser-broker.js';
import { installBrowserControlWs, BROWSER_CONTROL_WS_PATH } from '../src/api/browser-control-ws.js';

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
];
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
// Also skipped on CI: these tests load the live example.com, so they depend on the runner's network.
// Set RUN_BROWSER_TESTS=1 to run them anyway.
const describeWithChrome = chromePath && (!process.env.CI || process.env.RUN_BROWSER_TESTS) ? describe : describe.skip;

let server: Server;
let port: number;

beforeAll(async () => {
    server = createServer((_req, res) => res.end('ok'));
    installBrowserControlWs(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
});

afterAll(async () => {
    await new Promise<void>(r => { server.close(() => r()); });
});

function scopeFor(controllerId: string): ControllerScope {
    return {
        principal: derivePrincipal('test-owner'),
        browserProfileId: 'default',
        controllerId,
    };
}

/** Connect a socket the way the companion does, and resolve once it is attached. */
async function attachAs(scope: ControllerScope, caps: string[]) {
    const ticket = browserBroker.mintTicket(scope, caps);
    const ws = new WebSocket(
        `ws://127.0.0.1:${port}${BROWSER_CONTROL_WS_PATH}?ticket=${encodeURIComponent(ticket)}`,
    );
    await new Promise<void>((res, rej) => {
        ws.on('open', () => res());
        ws.on('error', rej);
    });
    return ws;
}

describe('companion wire protocol', () => {
    it('a hello with the right version keeps the socket open', async () => {
        const scope = scopeFor('ctl-hello');
        const ws = await attachAs(scope, ['controller.noop']);

        ws.send(JSON.stringify({ t: 'hello', protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }));
        await new Promise(r => setTimeout(r, 100));

        expect(ws.readyState).toBe(WebSocket.OPEN);
        expect(browserBroker.isOnline(scope)).toBe(true);
        ws.close();
    });

    it('the wrong protocol version is closed with 4002, not left half-working', async () => {
        const scope = scopeFor('ctl-badver');
        const ws = await attachAs(scope, ['controller.noop']);

        const closed = new Promise<number>(r => ws.on('close', code => r(code)));
        ws.send(JSON.stringify({ t: 'hello', protocolVersion: 999 }));

        expect(await closed).toBe(4002);
    });

    it('a command gets a result back with the same id', async () => {
        const scope = scopeFor('ctl-dispatch');
        const ws = await attachAs(scope, ['controller.noop']);
        ws.send(JSON.stringify({ t: 'hello', protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }));

        // Answer exactly as index.mjs does.
        ws.on('message', raw => {
            const msg = JSON.parse(String(raw));
            if (msg.t !== 'cmd') return;
            ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result: { ok: true } }));
        });

        await new Promise(r => setTimeout(r, 50));
        const result = await browserBroker.dispatch(scope, 'controller.noop', {}, { timeoutMs: 3000 });
        expect(result).toEqual({ ok: true });
        ws.close();
    });

    it('a handler failure comes back as a failed result, not a hang', async () => {
        // This is the one that matters most: a command that never answers parks a waiter
        // in the broker until timeout, turning one bad click into a stalled cycle.
        const scope = scopeFor('ctl-fail');
        const ws = await attachAs(scope, ['controller.noop']);
        ws.send(JSON.stringify({ t: 'hello', protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION }));

        ws.on('message', raw => {
            const msg = JSON.parse(String(raw));
            if (msg.t !== 'cmd') return;
            ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: false, error: 'element not found' }));
        });

        await new Promise(r => setTimeout(r, 50));
        await expect(
            browserBroker.dispatch(scope, 'controller.noop', {}, { timeoutMs: 3000 }),
        ).rejects.toThrow(/element not found/);
        ws.close();
    });
});

describeWithChrome('companion handlers against a real Chrome', () => {
    const profileDir = join(tmpdir(), `nc-companion-test-${process.pid}`);
    let browser: Awaited<ReturnType<typeof import('playwright').chromium.connectOverCDP>>;
    let proc: { kill: () => void };
    let handlers: Record<string, (p: unknown) => Promise<unknown>>;

    beforeAll(async () => {
        const { launchChrome, makeHandlers } = await import('./chrome.mjs');
        const { chromium } = await import('playwright');
        const cdpPort = 9400 + (process.pid % 100);

        const launched = await launchChrome({
            chromePath: chromePath!,
            profileDir,
            port: cdpPort,
            headless: true,
        });
        proc = launched.proc;
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        handlers = makeHandlers(browser) as never;
    }, 60_000);

    afterAll(async () => {
        try { await browser?.close(); } catch { /* already gone */ }
        try { proc?.kill(); } catch { /* already gone */ }
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('page.navigate then page.info reports the url it actually landed on', async () => {
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const info = await handlers['page.info']({}) as { url: string; title: string; viewport: unknown };

        expect(info.url).toContain('example.com');
        expect(info.title).toBeTruthy();
        expect(info.viewport).toBeTruthy();
    }, 45_000);

    it('page.navigate refuses non-http schemes', async () => {
        // Security boundary, not a convenience check: file:// in the user's own browser is
        // a much larger hole than a bad click.
        await expect(handlers['page.navigate']({ url: 'file:///etc/passwd' }))
            .rejects.toThrow(/only http/i);
        await expect(handlers['page.navigate']({ url: 'chrome-extension://abc/x.html' }))
            .rejects.toThrow(/only http/i);
    });

    it('page.screenshot returns a data URL, which is what RemotePage parses', async () => {
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const shot = await handlers['page.screenshot']({}) as { dataUrl: string };

        // A raw buffer here would be silently wrong — it would parse as nothing.
        expect(shot.dataUrl).toMatch(/^data:image\/jpeg;base64,/);
        expect(shot.dataUrl.length).toBeGreaterThan(1000);
    }, 45_000);

    it('page.probe evaluates a script the container sent, per frame', async () => {
        // The whole point of the CDP lane: MV3's CSP forbids this, so the extension needs
        // a generated copy of every probe. We evaluate what we are sent.
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const out = await handlers['page.probe']({
            script: '() => ({ host: location.host, tag: document.body.tagName })',
        }) as Array<{ frameId: number; result: { host: string; tag: string } }>;

        expect(out).toHaveLength(1);
        expect(out[0].result.host).toBe('example.com');
        expect(out[0].result.tag).toBe('BODY');
    }, 45_000);

    it('page.probe passes the container\'s single argument through', async () => {
        // The shape that actually matters: dom_snapshot.py calls
        // evaluate_isolated(frame, _SNAPSHOT_JS, _INTERACTIVE_SELECTORS) — ONE argument,
        // an array of selectors. Playwright's evaluate takes one arg and does not spread,
        // unlike the extension's chrome.scripting `args`. Getting this wrong made every
        // real snapshot silently return nothing.
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const out = await handlers['page.probe']({
            script: '(sel) => ({ got: sel, count: sel.length })',
            args: [['a', 'button', 'input']],
        }) as Array<{ result: { got: string[]; count: number } }>;

        expect(out[0].result.got).toEqual(['a', 'button', 'input']);
        expect(out[0].result.count).toBe(3);
    }, 45_000);

    it('a probe that throws in one frame reports the error without failing the whole call', async () => {
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const out = await handlers['page.probe']({
            script: '() => { throw new Error("boom"); }',
        }) as Array<{ result: unknown; error?: string }>;

        expect(out[0].result).toBeNull();
        expect(out[0].error).toMatch(/boom/);
    }, 45_000);

    it('input.key types text into a real field', async () => {
        await handlers['page.navigate']({ url: 'https://example.com/' });
        // Build a field to type into, then check the value landed.
        await handlers['page.probe']({
            script: `() => {
                const i = document.createElement('input');
                i.id = 'nc-test-input';
                document.body.appendChild(i);
                i.focus();
                return true;
            }`,
        });
        await handlers['input.key']({ text: 'hello companion' });
        const out = await handlers['page.probe']({
            script: `() => document.getElementById('nc-test-input')?.value ?? null`,
        }) as Array<{ result: string }>;

        expect(out[0].result).toBe('hello companion');
    }, 45_000);

    it('serves the probes the container asks for BY NAME', async () => {
        // The path the first live cycle broke on (2026-09-06). The container never sends
        // a script — the extension lane cannot receive one, so the vocabulary is a fixed
        // registry of names. The original tests only exercised `script:`, agreed with a
        // wrong assumption, and passed while the real thing failed with
        // "unknown probe: installFrameBridge".
        await handlers['page.navigate']({ url: 'https://example.com/' });

        for (const name of ['installFrameBridge', 'seedFrames', 'snapshot', 'frameOrigin']) {
            const out = await handlers['page.probe']({ probe: name }) as Array<{ error?: string }>;
            expect(out.length, `${name} returned nothing`).toBeGreaterThan(0);
            expect(out[0].error, `${name} errored`).toBeUndefined();
        }
    }, 45_000);

    it('the named snapshot probe returns real elements, not an empty list', async () => {
        // "It ran" is not the same as "it worked": a snapshot that returns [] would let a
        // cycle proceed and see a blank page. The fixture has a link, so expect one.
        await handlers['page.navigate']({ url: 'https://example.com/' });
        await handlers['page.probe']({ probe: 'installFrameBridge' });
        await handlers['page.probe']({ probe: 'seedFrames' });

        const out = await handlers['page.probe']({ probe: 'snapshot' }) as
            Array<{ result: Array<{ tag: string }> | null; error?: string }>;

        expect(out[0].error).toBeUndefined();
        expect(Array.isArray(out[0].result)).toBe(true);
        // example.com has exactly one interactive element: the "More information" link.
        expect(out[0].result!.length).toBeGreaterThan(0);
        expect(out[0].result!.some(e => e.tag === 'a')).toBe(true);
    }, 45_000);

    it('a named probe uses its own default argument', async () => {
        // `snapshot` needs the selector list. The container sends the NAME only and
        // expects the controller to supply it, exactly as the extension's registry does
        // with args: () => [INTERACTIVE_SELECTORS]. Without that the query selects
        // nothing and the page looks empty.
        await handlers['page.navigate']({ url: 'https://example.com/' });
        const out = await handlers['page.probe']({ probe: 'snapshot' }) as
            Array<{ result: unknown[] | null }>;
        expect(out[0].result).not.toBeNull();
        expect((out[0].result as unknown[]).length).toBeGreaterThan(0);
    }, 45_000);

    it('an unknown probe name lists the ones that exist', async () => {
        await expect(handlers['page.probe']({ probe: 'nonsense' }))
            .rejects.toThrow(/unknown probe: nonsense.*snapshot/s);
    }, 30_000);

    it('input.mouse clicks where it is told', async () => {
        await handlers['page.navigate']({ url: 'https://example.com/' });
        await handlers['page.probe']({
            script: `() => {
                const b = document.createElement('button');
                b.id = 'nc-test-btn';
                b.textContent = 'click me';
                b.style.cssText = 'position:fixed;left:50px;top:50px;width:120px;height:40px';
                b.onclick = () => { window.__nc_clicked = true; };
                document.body.appendChild(b);
                return true;
            }`,
        });
        await handlers['input.mouse']({ x: 110, y: 70, type: 'click' });
        const out = await handlers['page.probe']({
            script: '() => window.__nc_clicked === true',
        }) as Array<{ result: boolean }>;

        expect(out[0].result).toBe(true);
    }, 45_000);
});
