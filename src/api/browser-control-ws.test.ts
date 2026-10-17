/**
 * The extension transport, against a real HTTP server and a real WebSocket client
 * (stage 45 doc 05, phase 2).
 *
 * The browser half is covered by docs/research/stage45/spikes/probe_e2e.py, which needs a
 * real Chrome. This covers the half that does not: what the server does with a ticket, a
 * version, a result and a dropped socket.
 */
import http from 'http';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';

import {
  browserBroker,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  type ControllerScope,
} from '../agents/browser-broker.js';
import {
  installBrowserControlWs,
  BROWSER_CONTROL_WS_PATH,
} from './browser-control-ws.js';

let server: http.Server;
let port: number;

const scope = (over: Partial<ControllerScope> = {}): ControllerScope => ({
  principal: 'test-principal',
  browserProfileId: 'default',
  controllerId: 'ctl-1',
  ...over,
});

beforeEach(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  installBrowserControlWs(server);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const url = (ticket: string) =>
  `ws://127.0.0.1:${port}${BROWSER_CONTROL_WS_PATH}?ticket=${encodeURIComponent(ticket)}`;

/** Connect, complete the version handshake, and answer commands with `answer`. */
async function connectController(
  ticket: string,
  answer: (cmd: Record<string, unknown>) => unknown,
) {
  const ws = new WebSocket(url(ticket));
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    }),
  );
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t !== 'cmd') return;
    ws.send(
      JSON.stringify({
        t: 'result',
        id: msg.id,
        ok: true,
        result: answer(msg),
      }),
    );
  });
  // Let the hello land before anything is dispatched.
  await new Promise((r) => setTimeout(r, 50));
  return ws;
}

describe('browser-control websocket', () => {
  it('refuses an invalid ticket before the upgrade completes', async () => {
    const ws = new WebSocket(url('not-a-real-ticket'));
    const err = await new Promise<Error>((res) => ws.on('error', res));
    // A rejected upgrade, not a socket that opens and then closes — there is nothing
    // to probe and nothing to keep alive.
    expect(String(err.message)).toMatch(/401|Unexpected server response/);
  });

  it('burns a ticket on use, so a replayed one is refused', async () => {
    const s = scope({ controllerId: 'replay' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = await connectController(ticket, () => ({}));
    expect(browserBroker.isAttached(s)).toBe(true);

    const replay = new WebSocket(url(ticket));
    const err = await new Promise<Error>((res) => replay.on('error', res));
    expect(String(err.message)).toMatch(/401|Unexpected server response/);
    ws.close();
  });

  it('attaches on a good ticket and round-trips a command', async () => {
    const s = scope({ controllerId: 'roundtrip' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = await connectController(ticket, () => ({
      url: 'https://example.com',
    }));

    await expect(
      browserBroker.dispatch(s, 'page.info', {}, { timeoutMs: 3000 }),
    ).resolves.toEqual({ url: 'https://example.com' });
    ws.close();
  });

  it('closes on a protocol version mismatch instead of guessing', async () => {
    // A half-understood command reaching a logged-in browser is worse than a refused
    // connection, so the comparison is exact — no ranges, no coercion.
    const s = scope({ controllerId: 'badversion' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = new WebSocket(url(ticket));
    await new Promise<void>((r) => ws.on('open', () => r()));
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION + 1,
      }),
    );

    const code = await new Promise<number>((res) =>
      ws.on('close', (c) => res(c)),
    );
    expect(code).toBe(4002);
  });

  it('ignores a result that arrives before the version handshake', async () => {
    const s = scope({ controllerId: 'nohello' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = new WebSocket(url(ticket));
    await new Promise<void>((r) => ws.on('open', () => r()));

    // No hello. Answer the command anyway — an unverified peer must not be able to
    // settle a waiter.
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'cmd')
        ws.send(
          JSON.stringify({
            t: 'result',
            id: msg.id,
            ok: true,
            result: 'untrusted',
          }),
        );
    });
    await new Promise((r) => setTimeout(r, 50));

    await expect(
      browserBroker.dispatch(s, 'page.info', {}, { timeoutMs: 300 }),
    ).rejects.toThrow(/timed out/);
    ws.close();
  });

  it('survives an unparseable frame rather than dropping the controller', async () => {
    const s = scope({ controllerId: 'garbage' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = await connectController(ticket, () => 'still here');

    ws.send('this is not json');
    await new Promise((r) => setTimeout(r, 50));

    // A noisy client is not a hostile one.
    await expect(
      browserBroker.dispatch(s, 'page.info', {}, { timeoutMs: 3000 }),
    ).resolves.toBe('still here');
    ws.close();
  });

  it('a dropped socket disconnects rather than detaches', async () => {
    // The MV3 case: the worker dies, the browser is fine, the command may still be
    // running. Detaching here would cancel work that is about to succeed.
    const s = scope({ controllerId: 'dropped' });
    const ticket = browserBroker.mintTicket(s, ['page.info']);
    const ws = await connectController(ticket, () => ({}));

    ws.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(browserBroker.isAttached(s)).toBe(true); // still known...
    expect(browserBroker.isOnline(s)).toBe(false); // ...just not reachable
  });
});
