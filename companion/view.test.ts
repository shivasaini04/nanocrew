/**
 * The local live view.
 *
 * Two things are worth pinning here and they are not equally interesting.
 *
 * The streaming itself is ordinary: CDP sends frames, we write them to whoever is
 * listening. The tests for it exist mostly to catch a silent freeze — a missed
 * screencast ACK stops the stream with no error anywhere, which is exactly the kind of
 * failure that gets discovered by a person staring at a stale picture.
 *
 * The ACCESS RULES are the part that matters. This server hands out a live picture of a
 * browser signed into the user's accounts and asks for no authentication at all. Its
 * entire security model is "bound to loopback, and refuses an Origin it does not know".
 * If either of those regressed, the failure would be silent and the consequence would be
 * someone's LinkedIn on a co-worker's screen. So they are tested first and hardest.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LiveView } from './view.mjs';

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
];
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
const describeWithChrome = chromePath ? describe : describe.skip;

// A port unlikely to collide with a companion the developer is running by hand.
const PORT = 9530 + (process.pid % 60);

describe('live view access rules', () => {
    let view: LiveView;

    beforeAll(async () => {
        view = new LiveView({ port: PORT });
        const ok = await view.start();
        expect(ok).toBe(true);
    });

    afterAll(async () => { await view?.stop(); });

    it('binds loopback only — the security model, not a preference', async () => {
        // Nothing authenticates this server. It is safe because no other machine can
        // route to 127.0.0.1; binding 0.0.0.0 would publish a logged-in browser to the
        // whole network. Assert the actual bound address rather than trusting the call.
        const addr = (view as unknown as { _server: { address(): { address: string } } })
            ._server.address();
        expect(addr.address).toBe('127.0.0.1');
    });

    it('serves status to a known dashboard origin', async () => {
        const res = await fetch(`http://127.0.0.1:${PORT}/status`, {
            headers: { origin: 'http://localhost:3000' },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');

        const body = await res.json();
        expect(body.companion).toBe(true);
        expect(body.streamUrl).toContain('/stream');
    });

    it('refuses frames to an unknown origin', async () => {
        // A page on evil.example cannot READ these pixels (CORS and canvas taint see to
        // that) but it could DISPLAY them. Refusing is cheap; allowing is a live feed of
        // someone's logged-in session embedded in a page they did not write.
        const res = await fetch(`http://127.0.0.1:${PORT}/stream`, {
            headers: { origin: 'https://evil.example' },
        });
        expect(res.status).toBe(403);
        await res.text();
    });

    it('allows a request with no Origin at all', async () => {
        // Direct navigation: the user typing the URL, or the <img> inside the viewer page.
        // This is the ordinary case and must not be treated as hostile.
        const res = await fetch(`http://127.0.0.1:${PORT}/frame`);
        // 503 (no frame yet) rather than 403 — the request was allowed, there is just
        // nothing to send without a browser attached.
        expect(res.status).toBe(503);
        await res.text();
    });

    it('serves a standalone viewer page, so watching needs no dashboard', async () => {
        const res = await fetch(`http://127.0.0.1:${PORT}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');

        const html = await res.text();
        expect(html).toContain('/stream');
    });
});

describeWithChrome('live view against a real browser', () => {
    const profileDir = join(tmpdir(), `nc-view-test-${process.pid}`);
    let view: LiveView;
    let browser: import('playwright').Browser;
    let proc: { kill: () => void };

    beforeAll(async () => {
        const { launchChrome } = await import('./chrome.mjs');
        const { chromium } = await import('playwright');
        const cdpPort = 9600 + (process.pid % 60);

        const launched = await launchChrome({
            chromePath: chromePath!,
            profileDir,
            port: cdpPort,
            headless: true,
        });
        proc = launched.proc;
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);

        view = new LiveView({ port: PORT + 1 });
        await view.start();
    }, 60_000);

    afterAll(async () => {
        try { await view?.stop(); } catch { /* already stopped */ }
        try { await browser?.close(); } catch { /* already gone */ }
        try { proc?.kill(); } catch { /* already gone */ }
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    it('produces frames once attached to a page', async () => {
        const ctx = browser.contexts()[0];
        const page = ctx.pages()[0] ?? await ctx.newPage();
        await page.goto('https://example.com/', { waitUntil: 'domcontentloaded' });

        await view.attach(page);
        expect(view.streaming).toBe(true);

        // Frames arrive on paint. Scrolling guarantees one rather than waiting on luck.
        const before = view.frameCount;
        for (let i = 0; i < 20 && view.frameCount === before; i++) {
            await page.mouse.wheel(0, 40);
            await new Promise(r => setTimeout(r, 150));
        }

        // A missed Page.screencastFrameAck freezes the stream with no error anywhere, so
        // "more than zero frames" is the assertion that catches it.
        expect(view.frameCount).toBeGreaterThan(before);
    }, 60_000);

    it('serves a real JPEG at /frame once frames exist', async () => {
        const res = await fetch(`http://127.0.0.1:${PORT + 1}/frame`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/jpeg');

        const buf = Buffer.from(await res.arrayBuffer());
        expect(buf.length).toBeGreaterThan(500);
        // JPEG's magic number. A truthy body is not proof we sent an image.
        expect(buf[0]).toBe(0xff);
        expect(buf[1]).toBe(0xd8);
    }, 30_000);

    it('reports where the browser is, for the viewer caption', async () => {
        view.noteMeta({ url: 'https://example.com/', title: 'Example Domain' });
        const res = await fetch(`http://127.0.0.1:${PORT + 1}/status`);
        const body = await res.json();

        expect(body.streaming).toBe(true);
        expect(body.url).toBe('https://example.com/');
        expect(body.title).toBe('Example Domain');
        expect(body.frames).toBeGreaterThan(0);
    });

    it('stops cleanly and releases the port', async () => {
        // NANOBOT_PERSISTENT keeps containers warm and xvfb_session.py records being
        // bitten twice by things left running. A companion restarted by hand hits the
        // same shape: a stale listener means the next start silently has no view.
        await view.stop();
        await expect(fetch(`http://127.0.0.1:${PORT + 1}/status`)).rejects.toThrow();
    }, 15_000);
});
