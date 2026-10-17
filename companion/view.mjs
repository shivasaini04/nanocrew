/**
 * The live view, served from the user's own machine (stage 52 step 5).
 *
 * ## Why this is not the existing live view
 *
 * NanoCrew already streams a browser: CDP screencast -> the container -> a websocket to
 * the orchestrator -> `chat:frame` -> the dashboard. That path is why watching an agent
 * feels like watching a slideshow of somewhere far away, and `live_screen.py` says as
 * much — it keeps VNC off except during takeover because it "costs CPU in the container
 * and bandwidth all the way to the dashboard."
 *
 * Every one of those costs came from DISTANCE. The browser was in Frankfurt and the eye
 * was in Bengaluru. With the companion it is not: the browser is on the same machine as
 * the person watching, and the dashboard runs in a tab on that same machine. So the
 * frames should never cross the internet at all.
 *
 *     dashboard tab  --http://127.0.0.1--  this  --CDP--  Chrome
 *
 * That is the whole idea. No relay, no orchestrator hop, no egress. It is the reason a
 * local companion can feel like Codex's panel while a container never could.
 *
 * ## Why MJPEG rather than a websocket of data URLs
 *
 * `multipart/x-mixed-replace` is rendered natively by an <img> tag: no client code, no
 * base64 inflation (a data URL costs 33% more bytes), no per-frame React state, and the
 * browser's own image pipeline does the decoding off the main thread. The existing
 * dashboard path uses data URLs because it arrives over an existing socket.io channel and
 * must; here we own the transport and can pick the cheaper one.
 *
 * ## Why binding to loopback is the security model
 *
 * This server shows a live picture of a browser signed into the user's accounts, and takes
 * no authentication. It is safe only because it is bound to 127.0.0.1, which no other
 * machine can route to. That is load-bearing: binding 0.0.0.0 here would publish the
 * user's logged-in session to their whole network. The bind address is therefore not
 * configurable.
 *
 * A page on some other origin still cannot READ these pixels — canvas taint and CORS see
 * to that — but it could display them. The frame endpoints therefore refuse an unknown
 * Origin rather than sending a permissive CORS header.
 */

import { createServer } from 'node:http';

/** Only these origins may embed the stream. A dashboard is served from one of them. */
const DEFAULT_ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',   // vite dev
    'http://127.0.0.1:5173',
];

const BOUNDARY = 'ncframe';

/**
 * Runs the screencast and hands out frames.
 *
 * One screencast feeds every viewer: CDP is asked for frames once, and each connected
 * client is written the most recent one. A second viewer therefore costs bandwidth on a
 * loopback interface and nothing else.
 */
export class LiveView {
    constructor({ port = 9223, allowedOrigins = [], quality = 60, maxWidth = 1280 } = {}) {
        this._port = port;
        this._origins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...allowedOrigins]);
        this._quality = quality;
        this._maxWidth = maxWidth;

        this._server = null;
        this._clients = new Set();
        this._cdp = null;
        this._page = null;
        /** The most recent frame, as a Buffer. New viewers get it immediately. */
        this._latest = null;
        this._meta = { url: '', title: '' };
        this._frameCount = 0;
    }

    get url() {
        return `http://127.0.0.1:${this._port}`;
    }

    get frameCount() {
        return this._frameCount;
    }

    get streaming() {
        return this._cdp !== null;
    }

    /** Start the HTTP server. Never throws — a live view is never load-bearing. */
    async start() {
        if (this._server) return true;

        this._server = createServer((req, res) => this._route(req, res));

        return await new Promise(resolve => {
            this._server.on('error', () => {
                // Almost always EADDRINUSE from a previous companion. Watching is a
                // nice-to-have; the agent must still be able to work.
                this._server = null;
                resolve(false);
            });
            // Loopback only. See the module docstring — this is the security model.
            this._server.listen(this._port, '127.0.0.1', () => resolve(true));
        });
    }

    /**
     * Point the screencast at a page. Safe to call repeatedly; the last call wins.
     *
     * The screencast is attached to a PAGE, so it follows that tab and stops if the tab
     * closes. Re-attaching when the target page changes is the caller's job (index.mjs
     * does it), because only the caller knows which page commands are going to.
     */
    async attach(page) {
        if (this._page === page && this._cdp) return;
        await this.detachScreencast();
        this._page = page;

        try {
            this._cdp = await page.context().newCDPSession(page);
            this._cdp.on('Page.screencastFrame', async frame => {
                try {
                    this._latest = Buffer.from(frame.data, 'base64');
                    this._frameCount++;
                    this._broadcast(this._latest);
                    // The ACK is not optional: CDP stops sending frames until the last
                    // one is acknowledged, so a missed ack freezes the stream silently.
                    await this._cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
                } catch {
                    /* a frame we could not handle is one dropped frame, not a failure */
                }
            });
            await this._cdp.send('Page.startScreencast', {
                format: 'jpeg',
                quality: this._quality,
                maxWidth: this._maxWidth,
                // Every frame, not every nth: this is a loopback connection and the
                // smoothness IS the feature.
                everyNthFrame: 1,
            });
        } catch {
            this._cdp = null;   // no screencast; the stream simply stays blank
        }
    }

    async detachScreencast() {
        const cdp = this._cdp;
        this._cdp = null;
        if (!cdp) return;
        try { await cdp.send('Page.stopScreencast'); } catch { /* page may be gone */ }
        try { await cdp.detach(); } catch { /* already detached */ }
    }

    /** Called by the command loop so the viewer can show where the browser is. */
    noteMeta(meta) {
        this._meta = { ...this._meta, ...meta };
    }

    async stop() {
        await this.detachScreencast();
        for (const res of this._clients) {
            try { res.end(); } catch { /* client already gone */ }
        }
        this._clients.clear();
        const server = this._server;
        this._server = null;
        if (server) await new Promise(r => server.close(() => r()));
    }

    // -- HTTP ---------------------------------------------------------------

    _route(req, res) {
        const path = (req.url ?? '/').split('?')[0];

        if (path === '/status') return this._status(req, res);
        if (path === '/stream') return this._stream(req, res);
        if (path === '/frame') return this._frame(req, res);
        if (path === '/') return this._viewer(res);

        res.writeHead(404).end('not found');
    }

    /**
     * Whether a companion is here at all, plus what it is looking at.
     *
     * This one IS readable cross-origin, so a dashboard can discover a running companion
     * without the user configuring anything. It deliberately carries no pixels and no
     * session data — only that a browser exists and which page it is on.
     */
    _status(req, res) {
        const origin = req.headers.origin;
        if (origin && this._origins.has(origin)) {
            res.setHeader('access-control-allow-origin', origin);
            res.setHeader('access-control-allow-private-network', 'true');
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
            companion: true,
            streaming: this.streaming,
            frames: this._frameCount,
            url: this._meta.url,
            title: this._meta.title,
            streamUrl: `${this.url}/stream`,
        }));
    }

    /** One JPEG, for a caller that would rather poll than hold a connection open. */
    _frame(req, res) {
        if (!this._okOrigin(req, res)) return;
        if (!this._latest) return res.writeHead(503).end('no frame yet');
        res.writeHead(200, {
            'content-type': 'image/jpeg',
            'cache-control': 'no-store',
        });
        res.end(this._latest);
    }

    /** The live stream. An <img> pointed at this and nothing else. */
    _stream(req, res) {
        if (!this._okOrigin(req, res)) return;

        res.writeHead(200, {
            'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
            'cache-control': 'no-store, no-cache, must-revalidate',
            connection: 'close',
            pragma: 'no-cache',
        });

        this._clients.add(res);
        // Start from the last frame rather than a blank panel: a browser that is idle
        // sends no frames, and a viewer opening then would otherwise see nothing at all
        // until something moved.
        if (this._latest) this._write(res, this._latest);

        const drop = () => this._clients.delete(res);
        req.on('close', drop);
        req.on('error', drop);
        res.on('error', drop);
    }

    _okOrigin(req, res) {
        const origin = req.headers.origin;
        // No Origin at all is a direct navigation — the user typing the URL, or the <img>
        // in the viewer page below. That is the ordinary case and is allowed.
        if (!origin) return true;
        if (this._origins.has(origin)) {
            res.setHeader('access-control-allow-origin', origin);
            // Chrome's Private Network Access: a page on a public origin reaching
            // 127.0.0.1 is exactly the shape PNA gates, and without this the dashboard's
            // probe is refused before it is ever sent. Loopback is still what makes this
            // safe — this header only stops the browser refusing a request the user's own
            // dashboard is making to the user's own machine.
            res.setHeader('access-control-allow-private-network', 'true');
            return true;
        }
        res.writeHead(403).end('origin not allowed');
        return false;
    }

    _broadcast(jpeg) {
        for (const res of this._clients) {
            try {
                this._write(res, jpeg);
            } catch {
                this._clients.delete(res);
            }
        }
    }

    _write(res, jpeg) {
        res.write(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
        res.write(jpeg);
        res.write('\r\n');
    }

    /**
     * A standalone viewer, so watching needs nothing but a browser.
     *
     * This is what makes the companion testable on its own: open the URL and see what the
     * agent sees, without a dashboard, a login or a running cycle.
     */
    _viewer(res) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(VIEWER_HTML);
    }
}

const VIEWER_HTML = `<!doctype html>
<meta charset="utf-8">
<title>NanoCrew companion - live</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; background:#111; color:#eee; font:14px system-ui, sans-serif;
         display:flex; flex-direction:column; height:100vh; }
  header { padding:10px 14px; background:#1c1c1c; border-bottom:1px solid #333;
           display:flex; gap:12px; align-items:center; }
  .dot { width:9px; height:9px; border-radius:50%; background:#3fb950; flex:none; }
  .dot.idle { background:#8b949e; }
  #where { color:#8b949e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  main { flex:1; display:grid; place-items:center; overflow:auto; padding:10px; }
  img { max-width:100%; max-height:100%; box-shadow:0 4px 24px #0008; background:#fff; }
</style>
<header>
  <span class="dot" id="dot"></span>
  <strong>companion</strong>
  <span id="where">connecting...</span>
</header>
<main><img id="v" src="/stream" alt="the agent's browser"></main>
<script>
  // Poll status only for the caption. The picture itself is the MJPEG stream, which the
  // browser keeps open on its own.
  async function tick() {
    try {
      const s = await (await fetch('/status')).json();
      document.getElementById('where').textContent =
        s.url ? (s.title ? s.title + ' - ' + s.url : s.url) : 'no page yet';
      document.getElementById('dot').className = 'dot' + (s.streaming ? '' : ' idle');
    } catch { document.getElementById('where').textContent = 'companion stopped'; }
  }
  tick(); setInterval(tick, 2000);
</script>`;
