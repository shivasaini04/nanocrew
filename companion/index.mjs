/**
 * The NanoCrew companion — entry point.
 *
 * Registers with the browser broker as a controller, opens the control socket, and serves
 * commands by driving a dedicated Chrome over CDP. See companion/README.md.
 *
 * ## The two-step auth, and why it is two steps
 *
 * `POST /api/browser-control/register` is cookie-authenticated and hands back a
 * single-use ticket; the WebSocket presents the ticket, not the cookie. The extension does
 * this because a browser may or may not attach cookies to an extension-initiated upgrade.
 * We have no such problem — but we follow the same path anyway, because the ticket is what
 * the server's upgrade handler accepts, and because a controller that needed a special
 * server-side case would be a second auth path to get wrong.
 *
 * The principal is derived server-side from the session and never read from our request.
 * We say which profile and which controller id we are; the server decides who we are.
 *
 * ## Reconnect
 *
 * A dropped socket is not a detach. The broker distinguishes them deliberately
 * (browser-broker.ts, disconnect vs detach): a dropped connection marks the controller
 * offline and leaves in-flight work for a re-attach of the SAME identity to deliver. So we
 * keep our controllerId stable across reconnects — a fresh id on every retry would orphan
 * exactly the work the broker was holding for us.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { chromium } from 'playwright';

import { findChrome, launchChrome, makeHandlers } from './chrome.mjs';
import { LiveView } from './view.mjs';
import { CAPABILITIES, PROTOCOL_VERSION, serveOnce } from './transport.mjs';

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { console.log(HELP); return; }

    const log = (...m) => console.log(`[companion] ${m.join(' ')}`);

    if (!opts.session) {
        console.error('--session is required (or set NANOCREW_SESSION). See --help.');
        process.exit(2);
    }

    // Stable for this companion's life: the broker holds in-flight work for a re-attach
    // of the same identity, so a new id per retry would orphan it.
    const controllerId = randomUUID();

    const chromePath = findChrome(opts.chrome);
    log(`chrome: ${chromePath}`);
    log(`profile: ${opts.profile}`);

    const { proc, version } = await launchChrome({
        chromePath,
        profileDir: opts.profile,
        port: opts.port,
        headless: opts.headless,
    });
    log(`launched ${version} on port ${opts.port}`);

    // A reconnecting CDP link, not a one-shot connection. See makeHandlers: the object
    // connectOverCDP returns dies with its connection, and this process is meant to run
    // for days next to a browser the user may quit at any moment.
    let browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`);
    const getBrowser = async () => {
        if (browser?.isConnected()) return browser;
        log('browser link dropped — reconnecting to Chrome');
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port}`);
        // The screencast belonged to the old connection and cannot outlive it.
        if (view) await view.detachScreencast();
        return browser;
    };

    // The live view (step 5). Local pixels: the browser and the person watching are on
    // the same machine, so frames never cross the internet. This is the half of Codex's
    // panel a container could never have — see view.mjs.
    // The dashboard the user is signed into is, by definition, the one allowed to show
    // their own browser — so whichever orchestrator this companion was pointed at gets to
    // embed the stream. Without this a hosted dashboard is refused and the panel is blank.
    const view = opts.noView ? null : new LiveView({
        port: opts.viewPort,
        allowedOrigins: [opts.host.replace(/\/$/, '')],
    });
    if (view && await view.start()) {
        log(`live view: ${view.url}  (open it in any browser)`);
    } else if (view) {
        log(`live view could not bind port ${opts.viewPort} — continuing without it`);
    }

    const handlers = makeHandlers(getBrowser, {
        // Follow the agent across tabs. A screencast is bound to one page, so without
        // this the panel would keep showing whichever tab was open first.
        onPage: view ? (pg => view.attach(pg)) : null,
    });

    // Keep the viewer's caption honest. page.info is the one command whose result already
    // says where the browser is, so it costs nothing to reuse it.
    if (view) {
        const originalInfo = handlers['page.info'];
        handlers['page.info'] = async payload => {
            const info = await originalInfo(payload);
            view.noteMeta({ url: info.url, title: info.title });
            return info;
        };
        const originalNav = handlers['page.navigate'];
        handlers['page.navigate'] = async payload => {
            const out = await originalNav(payload);
            view.noteMeta({ url: out.url });
            return out;
        };
    }

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        log('shutting down');
        try { await view?.stop(); } catch { /* already gone */ }
        try { await browser?.close(); } catch { /* already gone */ }
        try { proc.kill(); } catch { /* already gone */ }
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Reconnect with backoff. The orchestrator restarting, or a laptop's wifi dropping,
    // must not mean the user has to run this again by hand — an unattended lane that
    // needs babysitting is not a lane.
    let backoffMs = 1000;
    while (!stopping) {
        try {
            await serveOnce({ ...opts, controllerId, handlers, log, client: 'nanocrew-companion-cli' });
            backoffMs = 1000; // a clean session resets the ladder
        } catch (err) {
            log(`session failed: ${err.message}`);
            if (/protocol version/.test(err.message)) break; // retrying cannot fix this
        }
        if (stopping) break;
        log(`reconnecting in ${Math.round(backoffMs / 1000)}s`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
    }

    await shutdown();
}

main().catch(err => {
    console.error('[companion] fatal:', err.message);
    process.exit(1);
});
