/**
 * Locators on the companion lane (stage 52 step 3).
 *
 * The claim being tested is specific, and it is the whole justification for this code
 * existing: a locator survives a page that MOVES between deciding to act and acting, and
 * a coordinate does not. Most of these tests therefore move the page on purpose.
 *
 * Everything runs against a real Chrome on a real page. A mocked Playwright would test
 * that this file calls Playwright, which is not in doubt; what is in doubt is whether the
 * actions behave the way the container will assume when it stops sending coordinates.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildLocator, locatorQuery, locatorAct } from './locator.mjs';

const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
];
const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
const describeWithChrome = chromePath ? describe : describe.skip;

/** A page with the shapes a real form has: labels, roles, a list, a moving banner. */
const FIXTURE = `data:text/html,${encodeURIComponent(`
<!doctype html><meta charset=utf-8><title>fixture</title>
<style>body{font:16px system-ui;margin:0;padding:20px}
  #banner{display:none;background:#fd0;padding:40px;text-align:center}
  button{display:block;margin:8px 0;padding:10px 18px}</style>
<div id=banner>a banner that appears late and pushes everything down</div>
<label for=email>Email</label><input id=email placeholder="you@example.com">
<button id=send>Send</button>
<button id=cancel>Cancel</button>
<ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
<div data-testid=marker>marked</div>
<p id=out></p>
<script>
  document.getElementById('send').onclick = () => { document.getElementById('out').textContent = 'sent'; };
  document.getElementById('cancel').onclick = () => { document.getElementById('out').textContent = 'cancelled'; };
</script>`)}`;

describe('buildLocator spec vocabulary', () => {
    // No browser needed: this is about the spec -> builder mapping, and a wrong mapping
    // would silently target the wrong thing rather than error.
    const fake = {
        locator: (s: string) => ({ kind: 'css', s }),
        getByRole: (r: string, o: unknown) => ({ kind: 'role', r, o }),
        getByText: (t: string, o: unknown) => ({ kind: 'text', t, o }),
        getByLabel: (t: string, o: unknown) => ({ kind: 'label', t, o }),
        getByPlaceholder: (t: string, o: unknown) => ({ kind: 'placeholder', t, o }),
        getByTestId: (t: string) => ({ kind: 'testId', t }),
    } as never;

    it('maps each spec form to its own builder', () => {
        expect(buildLocator(fake, { css: '#a' })).toMatchObject({ kind: 'css', s: '#a' });
        expect(buildLocator(fake, { role: 'button', name: 'Send' }))
            .toMatchObject({ kind: 'role', r: 'button', o: { name: 'Send' } });
        expect(buildLocator(fake, { text: 'hi' })).toMatchObject({ kind: 'text', t: 'hi' });
        expect(buildLocator(fake, { label: 'Email' })).toMatchObject({ kind: 'label', t: 'Email' });
        expect(buildLocator(fake, { testId: 'm' })).toMatchObject({ kind: 'testId', t: 'm' });
    });

    it('refuses a spec that names nothing, rather than guessing', () => {
        // A spec with a typo'd key would otherwise fall through to some default and act
        // on the wrong element. Naming the accepted keys makes the mistake obvious.
        expect(() => buildLocator(fake, { csss: '#a' } as never))
            .toThrow(/named nothing.*css/s);
        expect(() => buildLocator(fake, null as never)).toThrow(/must be an object/);
    });
});

describeWithChrome('locators against a real page', () => {
    const profileDir = join(tmpdir(), `nc-loc-test-${process.pid}`);
    let browser: import('playwright').Browser;
    let page: import('playwright').Page;
    let proc: { kill: () => void };

    beforeAll(async () => {
        const { launchChrome } = await import('./chrome.mjs');
        const { chromium } = await import('playwright');
        const cdpPort = 9700 + (process.pid % 60);

        const launched = await launchChrome({
            chromePath: chromePath!, profileDir, port: cdpPort, headless: true,
        });
        proc = launched.proc;
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
        const ctx = browser.contexts()[0];
        page = ctx.pages()[0] ?? await ctx.newPage();
    }, 60_000);

    afterAll(async () => {
        try { await browser?.close(); } catch { /* gone */ }
        try { proc?.kill(); } catch { /* gone */ }
        try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    beforeAll(async () => { await page.goto(FIXTURE); }, 30_000);

    it('query reports count, bounds and text', async () => {
        const res = await locatorQuery(page, { spec: { css: 'li' } });

        expect(res.count).toBe(3);
        expect(res.matches).toHaveLength(3);
        expect(res.matches[0].text).toBe('alpha');
        expect(res.matches[0].bounds?.width).toBeGreaterThan(0);
        expect(res.matches[0].visible).toBe(true);
    }, 30_000);

    it('query on nothing returns count 0 rather than throwing', async () => {
        // The container needs to be able to ASK without it being an error — checking
        // before acting is the entire advantage over clicking into the dark.
        const res = await locatorQuery(page, { spec: { css: '#nope' }, timeoutMs: 1000 });
        expect(res.count).toBe(0);
        expect(res.timedOut).toBe(true);
    }, 30_000);

    it('finds by role and accessible name, which a coordinate cannot express', async () => {
        const res = await locatorQuery(page, { spec: { role: 'button', name: 'Send' } });
        expect(res.count).toBe(1);
        expect(res.matches[0].text).toBe('Send');
    }, 30_000);

    it('act:click hits the named button', async () => {
        await page.goto(FIXTURE);
        await locatorAct(page, { spec: { role: 'button', name: 'Send' }, action: 'click' });
        expect(await page.locator('#out').innerText()).toBe('sent');
    }, 30_000);

    it('act:fill sets a value through the label, not a position', async () => {
        await page.goto(FIXTURE);
        await locatorAct(page, { spec: { label: 'Email' }, action: 'fill', value: 'a@b.co' });
        expect(await page.locator('#email').inputValue()).toBe('a@b.co');
    }, 30_000);

    it('THE POINT: a locator still hits the right button after the page moves', async () => {
        // This is the failure a coordinate cannot survive and the reason step 3 exists.
        // Snapshot the position of Cancel, then push it down by 100px, then act.
        await page.goto(FIXTURE);
        const before = await page.locator('#cancel').boundingBox();
        expect(before).toBeTruthy();

        // A late banner: exactly what a cookie bar or a slow image does on a real page.
        await page.evaluate(() => {
            (document.getElementById('banner') as HTMLElement).style.display = 'block';
        });
        await page.waitForTimeout(100);

        const after = await page.locator('#cancel').boundingBox();
        expect(after!.y).toBeGreaterThan(before!.y + 50);   // it really did move

        // The coordinate captured before the move now points at something else...
        const nowAtOldPoint = await page.evaluate(
            (pt: { x: number; y: number }) => document.elementFromPoint(pt.x, pt.y)?.id ?? '',
            { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 },
        );
        expect(nowAtOldPoint).not.toBe('cancel');

        // ...but the locator re-resolves and still gets Cancel.
        await locatorAct(page, { spec: { role: 'button', name: 'Cancel' }, action: 'click' });
        expect(await page.locator('#out').innerText()).toBe('cancelled');
    }, 30_000);

    it('act on a missing element fails loudly instead of succeeding silently', async () => {
        // The other half of the same argument: a coordinate click into empty space
        // "succeeds". This must not.
        await page.goto(FIXTURE);
        await expect(
            locatorAct(page, { spec: { css: '#nope' }, action: 'click', timeoutMs: 1500 }),
        ).rejects.toThrow();
    }, 30_000);

    it('act:text reads content back', async () => {
        await page.goto(FIXTURE);
        const res = await locatorAct(page, { spec: { testId: 'marker' }, action: 'text' });
        expect(res.text).toBe('marked');
    }, 30_000);

    it('nth selects within a set', async () => {
        await page.goto(FIXTURE);
        const res = await locatorAct(page, { spec: { css: 'li', nth: 1 }, action: 'text' });
        expect(res.text).toBe('beta');
    }, 30_000);

    it('an unknown action names the ones that exist', async () => {
        await expect(locatorAct(page, { spec: { css: 'li' }, action: 'explode' }))
            .rejects.toThrow(/unknown locator action.*click/s);
    }, 30_000);
});
