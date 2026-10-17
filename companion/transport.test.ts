/**
 * The companion transport's session lifecycle (2026-09-18, "computer selected but not
 * connected"): a host must be able to END a session, and a socket that silently died must
 * be noticed. Real HTTP + WebSocket servers on loopback, no mocks of `ws`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';

import { serveOnce, PROTOCOL_VERSION } from './transport.mjs';

let server: http.Server | null = null;
let wss: WebSocketServer | null = null;

async function start({ autoPong }: { autoPong: boolean }) {
    wss = new WebSocketServer({ noServer: true, autoPong });
    const sockets: unknown[] = [];
    wss.on('connection', s => sockets.push(s));
    server = http.createServer((req, res) => {
        if (req.url === '/api/browser-control/register') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ticket: 't', wsPath: '/ws', capabilities: [], protocolVersion: PROTOCOL_VERSION }));
            return;
        }
        res.statusCode = 404;
        res.end();
    });
    server.on('upgrade', (req, socket, head) => wss!.handleUpgrade(req, socket, head, ws => wss!.emit('connection', ws)));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    return { host: `http://127.0.0.1:${port}`, sockets };
}

afterEach(async () => {
    wss?.close();
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
    server = null;
    wss = null;
});

const base = { session: 'nanocrew_sid=x', profileId: 'default', controllerId: 'c1', handlers: {}, log: () => {} };

describe('serveOnce', () => {
    it('ends the session and closes the socket when the host aborts', async () => {
        const { host, sockets } = await start({ autoPong: true });
        const abort = new AbortController();
        const done = serveOnce({ ...base, host, signal: abort.signal });
        await new Promise(r => setTimeout(r, 300));
        expect(sockets).toHaveLength(1);
        abort.abort();
        await expect(done).resolves.toBe('stopped');
    });

    it('gives up on a socket whose server stopped answering pings', async () => {
        const { host } = await start({ autoPong: false });
        const t0 = Date.now();
        const result = await serveOnce({ ...base, host, heartbeatMs: 150 });
        expect(result).toBe('dead');
        expect(Date.now() - t0).toBeLessThan(3000);
    });

    it('keeps a healthy session open', async () => {
        const { host } = await start({ autoPong: true });
        const abort = new AbortController();
        const done = serveOnce({ ...base, host, heartbeatMs: 100 });
        const raced = await Promise.race([done.then(() => 'ended'), new Promise(r => setTimeout(() => r('open'), 700))]);
        expect(raced).toBe('open');
        abort.abort();
        wss?.clients.forEach(c => c.close());
        await done;
    });
});
