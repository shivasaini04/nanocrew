/**
 * The companion's transport — registration, the control socket, and serving commands.
 *
 * Extracted from index.mjs in stage 52 Phase 2, because there are now TWO hosts for this
 * logic and they must not drift:
 *
 *   companion/index.mjs   the standalone CLI — launches its own Chrome
 *   desktop/agent-lane.js the Electron app — drives its embedded panel
 *
 * Everything host-specific (which browser, where the session cookie comes from, how it
 * logs) is passed in. Nothing in here knows which host it is serving, which is what keeps
 * one implementation honest rather than two that agree today.
 */

import WebSocket from 'ws';

export const PROTOCOL_VERSION = 1;

/** What we ask for. The server filters this — asking is not receiving. */
export const CAPABILITIES = [
    'controller.noop',
    'page.info',
    'page.navigate',
    'page.probe',
    'page.screenshot',
    'input.mouse',
    'input.key',
    'input.scroll',
    // The CDP-only pair. An extension cannot serve these; asking for them is how this
    // controller announces it is a companion (browser-broker.ts, CDP_CAPABILITIES).
    'locator.query',
    'locator.act',
];

function parseArgs(argv) {
    const out = {
        host: process.env.NANOCREW_HOST ?? 'http://localhost:3000',
        session: process.env.NANOCREW_SESSION ?? '',
        profile: join(tmpdir(), 'nanocrew-companion-profile'),
        port: 9222,
        chrome: '',
        profileId: 'default',
        headless: false,
        viewPort: 9223,
        noView: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const val = () => argv[++i];
        if (a === '--host') out.host = val();
        else if (a === '--session') out.session = val();
        else if (a === '--profile') out.profile = val();
        else if (a === '--port') out.port = Number(val());
        else if (a === '--chrome') out.chrome = val();
        else if (a === '--profile-id') out.profileId = val();
        else if (a === '--headless') out.headless = true;
        else if (a === '--view-port') out.viewPort = Number(val());
        else if (a === '--no-view') out.noView = true;
        else if (a === '--help' || a === '-h') out.help = true;
    }
    return out;
}

const HELP = `
NanoCrew companion — lends an agent your browser.

  node index.mjs --host <url> --session <cookie>

  --host <url>         orchestrator base url        (env NANOCREW_HOST)
  --session <cookie>   dashboard session cookie     (env NANOCREW_SESSION)
  --profile <dir>      Chrome profile directory     (default: temp/nanocrew-companion-profile)
  --profile-id <id>    which profile this is, to the broker   (default: "default")
  --port <n>           CDP port                     (default: 9222)
  --chrome <path>      Chrome binary                (default: auto-detect)
  --headless           run Chrome headless          (you cannot log in this way)
  --view-port <n>      local live-view port         (default: 9223)
  --no-view            do not serve the live view

The profile is dedicated to the agent: your everyday Chrome keeps running, and no
admin prompt appears. Sign into the sites you want the agent to use, in ITS window,
once. Check a session is durable with:

  node ../scripts/spikes/profile_session_check.mjs <profile-dir> linkedin
`;

/** Register, and come back with a ticket. Throws with a readable reason. */
export async function register(host, session, { profileId, controllerId, client, sites, extraCapabilities = [] }) {
    const res = await fetch(`${host.replace(/\/$/, '')}/api/browser-control/register`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            // The dashboard's session cookie. This is the ONLY place it is used; the
            // socket authenticates with the ticket instead.
            cookie: session.includes('=') ? session : `session=${session}`,
            // Who is connecting, for support. "Which version are you on?" is otherwise
            // unanswerable once an app is on someone else's machine, and it is the first
            // question every desktop support conversation needs.
            ...(client ? { 'x-nanocrew-client': client } : {}),
        },
        body: JSON.stringify({
            browserProfileId: profileId,
            controllerId,
            // A host can serve more than the browser: the desktop app adds local files,
            // the terminal and desktop apps (stage 60). Asked for here, filtered by the
            // server, and permission-checked by the app itself on every call.
            capabilities: [...CAPABILITIES, ...extraCapabilities],
            // Which sites this browser is signed into. The agent has no other way to
            // know, and without it, asked to open a LinkedIn feed it will offer to take
            // your password rather than simply navigating.
            ...(sites?.length ? { sites } : {}),
        }),
    });

    if (res.status === 401) {
        throw new Error(
            'orchestrator rejected the session cookie (401). Sign into the dashboard and ' +
            'pass its session cookie with --session.',
        );
    }
    if (!res.ok) {
        throw new Error(`register failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return await res.json();
}

export function wsUrlFor(host, wsPath, ticket) {
    const base = host.replace(/\/$/, '');
    const scheme = base.startsWith('https://') ? 'wss://' : 'ws://';
    const authority = base.replace(/^https?:\/\//, '');
    return `${scheme}${authority}${wsPath}?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * One connected session: register, open the socket, serve commands until it closes.
 * Resolves when the socket closes, so the caller can decide whether to retry.
 */
export async function serveOnce({ host, session, profileId, controllerId, handlers, log, client, sites, extraCapabilities = [], signal, heartbeatMs = 15_000 }) {
    const reg = await register(host, session, { profileId, controllerId, client, sites, extraCapabilities });

    const asked = [...CAPABILITIES, ...extraCapabilities];
    const granted = reg.capabilities ?? [];
    const refused = asked.filter(c => !granted.includes(c));
    if (refused.length) {
        // Not fatal — the server filters by design — but silence here would turn a policy
        // decision into a mystery failure later, mid-command.
        log(`server granted ${granted.length}/${asked.length} capabilities; ` +
            `refused: ${refused.join(', ')}`);
    }
    if (reg.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
            `protocol mismatch: server speaks ${reg.protocolVersion}, this companion ` +
            `speaks ${PROTOCOL_VERSION}. Update the companion.`,
        );
    }

    const ws = new WebSocket(wsUrlFor(host, reg.wsPath, reg.ticket));

    return await new Promise((resolve, reject) => {
        let settled = false;
        let heartbeat = null;
        const finish = v => {
            if (heartbeat) clearInterval(heartbeat);
            if (!settled) { settled = true; resolve(v); }
        };

        // The host can end this session (the desktop app does on wake/unlock). Before
        // this, "stop" left the socket open and a second loop opened another beside it;
        // on 2026-09-18 that piled up four connections, and one closing took the live
        // one offline on the server.
        if (signal) {
            if (signal.aborted) { ws.terminate(); finish('stopped'); return; }
            signal.addEventListener('abort', () => { try { ws.close(1000, 'stopped by host'); } catch { /* already gone */ } finish('stopped'); }, { once: true });
        }

        // Heartbeat. A laptop that sleeps can come back with a socket that is dead but
        // never closed — nothing arrives, no 'close' fires, and the lane waits for ever
        // while the server has long since marked it offline. A pong proves the path.
        let alive = true;
        ws.on('pong', () => { alive = true; });
        heartbeat = setInterval(() => {
            if (!alive) {
                log(`no pong from the server in ${Math.round((2 * heartbeatMs) / 1000)}s — reconnecting`);
                try { ws.terminate(); } catch { /* already gone */ }
                finish('dead');
                return;
            }
            alive = false;
            try { ws.ping(); } catch { /* close will follow */ }
        }, heartbeatMs);

        ws.on('open', () => {
            // The server closes on a version mismatch, and refuses results from a client
            // that never said hello. So this goes first, before anything else.
            ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION }));
            log(`attached as ${controllerId.slice(0, 8)} — waiting for work`);
        });

        ws.on('message', async raw => {
            let msg;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                return; // a noisy server is not a hostile one
            }
            if (msg.t !== 'cmd' || typeof msg.id !== 'string') return;

            const handler = handlers[msg.capability];
            if (!handler) {
                ws.send(JSON.stringify({
                    t: 'result', id: msg.id, ok: false,
                    error: `capability not implemented by this controller: ${msg.capability}`,
                }));
                return;
            }

            try {
                const result = await handler(msg.payload ?? {});
                ws.send(JSON.stringify({ t: 'result', id: msg.id, ok: true, result }));
            } catch (err) {
                // Every failure must come back as a result. A command that never answers
                // parks a waiter in the broker until its timeout, which turns one bad
                // click into a stalled cycle.
                ws.send(JSON.stringify({
                    t: 'result', id: msg.id, ok: false,
                    error: String(err?.message ?? err),
                }));
            }
        });

        ws.on('close', (code, reason) => {
            log(`socket closed (${code}${reason?.length ? `: ${reason}` : ''})`);
            // 4002 is the server's protocol-version close. Retrying cannot help.
            if (code === 4002) reject(new Error('protocol version rejected by server'));
            else finish('closed');
        });

        ws.on('error', err => {
            log(`socket error: ${err.message}`);
            finish('error');
        });
    });
}
