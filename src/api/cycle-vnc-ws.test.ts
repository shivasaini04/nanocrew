/**
 * Stage 50 phases 3 and 4 — the VNC bridge.
 *
 * This file is a pipe between two sockets that cannot reach each other, so the tests are
 * about what may cross it, in which direction, and what happens when one end vanishes.
 *
 * Both ends are dialled through the REAL upgrade handler, because the authentication
 * decision lives there and a mock would test nothing: the relay presents a cycle token
 * in a header, and the viewer a single-use ticket in the query string, because a browser
 * cannot set headers on a handshake.
 *
 * `FakeViewer` still exists for the piping tests, where the point is byte direction
 * rather than admission, and where driving a socket's close ordering by hand is what
 * makes the replacement case reproducible.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';

import { issueCycleToken, revokeCycleToken } from '../agents/cycle-token.js';
import {
  installCycleVncWs,
  attachVncViewer,
  hasVncRelay,
  agentForVncRelay,
  closeCycleVnc,
  mintVncTicket,
  consumeVncTicket,
  VncTicketInvalid,
} from './cycle-vnc-ws.js';

/** Just the surface `attachVncViewer` touches. */
class FakeViewer {
  readonly OPEN = 1;
  readyState = 1;
  sent: Buffer[] = [];
  closedWith: number | null = null;
  private handlers: Record<string, Function[]> = {};

  on(event: string, fn: Function) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }
  send(data: Buffer) {
    this.sent.push(data);
  }
  close(code?: number) {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
    this.fire('close');
  }
  /** Pretend the person at this end did something. */
  fire(event: string, ...args: unknown[]) {
    (this.handlers[event] ?? []).forEach((fn) => fn(...args));
  }
}

let server: http.Server;
let port: number;
const opened: WebSocket[] = [];

function wsUrl(): string {
  return `ws://127.0.0.1:${port}/api/cycle-vnc/ws`;
}

/** Dial the relay end, as the container's Python does: token in a header. */
function dialRelay(token: string): Promise<WebSocket> {
  const ws = new WebSocket(wsUrl(), { headers: { 'x-cycle-token': token } });
  opened.push(ws);
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) =>
      reject(new Error(`http ${res.statusCode}`)),
    );
  });
}

function nextMessage(
  ws: WebSocket,
): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) =>
    ws.once('message', (data: Buffer, isBinary: boolean) =>
      resolve({ data, isBinary }),
    ),
  );
}

/** Let queued socket events drain. */
const settle = () => new Promise((r) => setTimeout(r, 40));

beforeEach(async () => {
  server = http.createServer();
  installCycleVncWs(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }
  await new Promise<void>((r) => server.close(() => r()));
});

// ─── who may open a relay ─────────────────────────────────────────────────────

describe('the relay end authenticates with the cycle token', () => {
  it('accepts a live token and registers the cycle', async () => {
    const token = issueCycleToken('agent-1', 'cycle-1');
    await dialRelay(token);
    await settle();

    expect(hasVncRelay('cycle-1')).toBe(true);
    expect(agentForVncRelay('cycle-1')).toBe('agent-1');
    revokeCycleToken(token);
  });

  it('refuses a revoked token, so a screen cannot outlive its run', async () => {
    const token = issueCycleToken('agent-1', 'cycle-dead');
    revokeCycleToken(token);

    await expect(dialRelay(token)).rejects.toThrow(/401/);
    expect(hasVncRelay('cycle-dead')).toBe(false);
  });

  it('refuses a token that is not one', async () => {
    await expect(dialRelay('not-a-token')).rejects.toThrow(/401/);
  });

  it('takes the agent from the token, never from the client', async () => {
    // There is no cycleId or agentId parameter to spoof: one secret names both.
    const token = issueCycleToken('agent-owner', 'cycle-2');
    await dialRelay(token);
    await settle();

    expect(agentForVncRelay('cycle-2')).toBe('agent-owner');
    expect(agentForVncRelay('some-other-cycle')).toBeNull();
    revokeCycleToken(token);
  });
});

// ─── the pipe ─────────────────────────────────────────────────────────────────

describe('bytes cross, control does not', () => {
  let token: string;
  let relay: WebSocket;
  let viewer: FakeViewer;

  beforeEach(async () => {
    token = issueCycleToken('agent-1', 'cycle-pipe');
    relay = await dialRelay(token);
    await settle();
    viewer = new FakeViewer();
  });

  afterEach(() => revokeCycleToken(token));

  it('tells the relay to open a fresh RFB session when a viewer attaches', async () => {
    const told = nextMessage(relay);
    expect(attachVncViewer('cycle-pipe', viewer as never)).toBe(true);

    const { data, isBinary } = await told;
    expect(isBinary).toBe(false);
    expect(JSON.parse(data.toString())).toEqual({ t: 'attach' });
  });

  it('forwards framebuffer bytes from the container to the viewer', async () => {
    attachVncViewer('cycle-pipe', viewer as never);
    await settle();

    relay.send(Buffer.from('RFB 003.008\n'), { binary: true });
    await settle();

    expect(Buffer.concat(viewer.sent).toString()).toBe('RFB 003.008\n');
  });

  it('forwards the viewer’s input back down to the container', async () => {
    attachVncViewer('cycle-pipe', viewer as never);
    await settle();

    const arrived = nextMessage(relay);
    viewer.fire('message', Buffer.from([1, 2, 3]), true);

    const { data, isBinary } = await arrived;
    expect(isBinary).toBe(true);
    expect([...data]).toEqual([1, 2, 3]);
  });

  it('drops a text frame from the viewer, so it cannot forge attach/detach', async () => {
    // The relay acts on control frames. A viewer that could send them could make a
    // container open RFB sessions on command.
    attachVncViewer('cycle-pipe', viewer as never);
    await settle();

    let got: Buffer | null = null;
    relay.on('message', (d: Buffer) => {
      got = d;
    });
    viewer.fire('message', Buffer.from(JSON.stringify({ t: 'detach' })), false);
    await settle();

    expect(got).toBeNull();
  });

  it('says detach when the viewer leaves, so no session is held for nobody', async () => {
    attachVncViewer('cycle-pipe', viewer as never);
    await settle();

    const told = nextMessage(relay);
    viewer.fire('close');

    expect(JSON.parse((await told).data.toString())).toEqual({ t: 'detach' });
  });
});

// ─── one viewer at a time, because RFB is a conversation ──────────────────────

describe('a second viewer replaces the first', () => {
  it('closes the old socket and restarts the session for the newcomer', async () => {
    const token = issueCycleToken('agent-1', 'cycle-two-viewers');
    const relay = await dialRelay(token);
    await settle();

    const first = new FakeViewer();
    attachVncViewer('cycle-two-viewers', first as never);
    await settle();

    const restarted = nextMessage(relay);
    const second = new FakeViewer();
    attachVncViewer('cycle-two-viewers', second as never);

    expect(first.closedWith).toBe(1000);
    // Interleaving two RFB streams is gibberish; the newcomer gets a clean handshake.
    expect(JSON.parse((await restarted).data.toString())).toEqual({
      t: 'attach',
    });

    relay.send(Buffer.from('x'), { binary: true });
    await settle();
    expect(Buffer.concat(second.sent).toString()).toBe('x');
    revokeCycleToken(token);
  });
});

// ─── when an end goes away ────────────────────────────────────────────────────

describe('teardown', () => {
  it('refuses a viewer for a cycle with no relay', () => {
    const viewer = new FakeViewer();
    expect(attachVncViewer('cycle-with-no-relay', viewer as never)).toBe(false);
  });

  it('closes the viewer when the relay drops, rather than freezing its last frame', async () => {
    const token = issueCycleToken('agent-1', 'cycle-drop');
    const relay = await dialRelay(token);
    await settle();
    const viewer = new FakeViewer();
    attachVncViewer('cycle-drop', viewer as never);
    await settle();

    relay.close();
    await settle();

    expect(viewer.closedWith).toBe(1001);
    expect(hasVncRelay('cycle-drop')).toBe(false);
    revokeCycleToken(token);
  });

  it('closeCycleVnc ends both halves', async () => {
    const token = issueCycleToken('agent-1', 'cycle-end');
    await dialRelay(token);
    await settle();
    const viewer = new FakeViewer();
    attachVncViewer('cycle-end', viewer as never);
    await settle();

    closeCycleVnc('cycle-end');

    expect(viewer.closedWith).toBe(1001);
    expect(hasVncRelay('cycle-end')).toBe(false);
    revokeCycleToken(token);
  });

  it('closeCycleVnc on a cycle that never had one is a no-op', () => {
    expect(() => closeCycleVnc('never-existed')).not.toThrow();
  });

  it('reports no relay for an unknown cycle, so an ownership check cannot pass by accident', () => {
    expect(hasVncRelay('unknown')).toBe(false);
    expect(agentForVncRelay('unknown')).toBeNull();
  });
});

// ─── the viewer's way in: a single-use ticket ─────────────────────────────────
//
// A browser cannot set headers on a WebSocket handshake, so the socket cannot carry
// proof of who opened it. The ticket is that proof, minted by a route that has already
// checked ownership — which makes it the only thing between a live view of someone's
// browser and whoever asks. It gets tested like a credential, not a lookup key.

describe('vnc tickets', () => {
  it('is single-use — a replay after redemption fails', () => {
    const ticket = mintVncTicket('cycle-t', 'user-1');
    expect(consumeVncTicket(ticket)).toEqual({
      cycleId: 'cycle-t',
      userId: 'user-1',
    });
    expect(() => consumeVncTicket(ticket)).toThrow(VncTicketInvalid);
  });

  it('refuses one that was never minted', () => {
    expect(() => consumeVncTicket('made-up')).toThrow(VncTicketInvalid);
    expect(() => consumeVncTicket('')).toThrow(VncTicketInvalid);
  });

  it('burns an expired ticket rather than leaving it to be probed', () => {
    vi.useFakeTimers();
    try {
      const ticket = mintVncTicket('cycle-t', 'user-1');
      vi.advanceTimersByTime(3 * 60 * 1000); // TTL is two minutes
      expect(() => consumeVncTicket(ticket)).toThrow(VncTicketInvalid);
      // Deleted on the first attempt, so a second is "unknown", not "expired" —
      // an expired ticket must not linger as something to keep trying.
      expect(() => consumeVncTicket(ticket)).toThrow(/unknown/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('names exactly one cycle, so a redeemed ticket cannot be pointed elsewhere', () => {
    const a = mintVncTicket('cycle-A', 'user-1');
    const b = mintVncTicket('cycle-B', 'user-2');
    expect(consumeVncTicket(a).cycleId).toBe('cycle-A');
    expect(consumeVncTicket(b).userId).toBe('user-2');
  });

  it('is long and unguessable, not a counter', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(mintVncTicket('cycle-t', 'user-1'));
    expect(seen.size).toBe(50);
    for (const t of seen) expect(t.length).toBeGreaterThanOrEqual(40);
  });
});

describe('the viewer socket', () => {
  it('refuses a dial with no ticket and no token at all', async () => {
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl());
        opened.push(ws);
        ws.on('open', () => resolve('opened'));
        ws.on('error', reject);
        ws.on('unexpected-response', (_q, res) =>
          reject(new Error(`http ${res.statusCode}`)),
        );
      }),
    ).rejects.toThrow(/401/);
  });

  it('refuses a ticket for a cycle whose screen has gone', async () => {
    // Minted while the run was alive, dialled after it ended: the window between
    // those is exactly when a stale ticket would otherwise open a dead socket.
    const ticket = mintVncTicket('cycle-that-ended', 'user-1');
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`${wsUrl()}?ticket=${ticket}`);
        opened.push(ws);
        ws.on('open', () => resolve('opened'));
        ws.on('error', reject);
        ws.on('unexpected-response', (_q, res) =>
          reject(new Error(`http ${res.statusCode}`)),
        );
      }),
    ).rejects.toThrow(/409/);
  });

  it('lets a valid ticket through to a live screen, and pipes it', async () => {
    const token = issueCycleToken('agent-1', 'cycle-live');
    const relay = await dialRelay(token);
    await settle();

    const ticket = mintVncTicket('cycle-live', 'user-1');
    const viewer = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${wsUrl()}?ticket=${ticket}`);
      opened.push(ws);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
      ws.on('unexpected-response', (_q, res) =>
        reject(new Error(`http ${res.statusCode}`)),
      );
    });
    await settle();

    const arrived = nextMessage(viewer);
    relay.send(Buffer.from('RFB 003.008\n'), { binary: true });
    expect((await arrived).data.toString()).toBe('RFB 003.008\n');

    revokeCycleToken(token);
  });
});
