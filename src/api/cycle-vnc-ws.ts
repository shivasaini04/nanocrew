/**
 * The VNC bridge — a cycle's screen, joined to the person watching it (stage 50 phase 3).
 *
 * Two sockets meet here and this file is the only thing between them:
 *
 *   container relay  --wss-->  [ orchestrator ]  <--wss--  dashboard viewer (noVNC)
 *
 * Neither end can reach the other directly. The container has no inbound network path,
 * so it dials out (see the Python `vnc_relay.py`). The browser cannot reach inside a
 * container at all. So both dial here, and here forwards bytes.
 *
 * ## Why not the cycle channel
 *
 * That socket carries `release` and the interrupt that lets Stop reach a parked run.
 * A framebuffer stream on the same connection means those queue behind pixels — the
 * one message that must never be slow, delayed by the one stream allowed to be.
 *
 * ## Two ends, two ways of proving who you are
 *
 * - **The relay** is Python and can set headers, so it presents the per-cycle token in
 *   one — never the query string, which lands in access logs. Same rule and same
 *   `resolveCycleToken` as the cycle channel.
 * - **The viewer** is a browser, which cannot set headers on a WebSocket handshake. So
 *   it presents a single-use ticket, minted by a cookie-authenticated route that checks
 *   ownership first. That is the design `browser-control-ws.ts` already arrived at for
 *   exactly this constraint.
 *
 * Ownership is checked when the ticket is MINTED, not here, for the same reason
 * `mayDriveCycle` checks on every event: the thing on the far end of this is a real
 * browser that may be signed into things.
 *
 * ## One viewer at a time
 *
 * RFB is stateful and positional — a session is a conversation, not a series of
 * requests. Two viewers on one relay would interleave into gibberish. A second viewer
 * replaces the first rather than joining it, and the relay is told to start a fresh
 * session so the newcomer gets a clean handshake.
 */
import crypto from 'crypto';
import type http from 'http';

import { WebSocketServer, type WebSocket } from 'ws';

import { resolveCycleToken } from '../agents/cycle-token.js';
import { logger } from '../logger.js';

export const CYCLE_VNC_WS_PATH = '/api/cycle-vnc/ws';

/**
 * Long enough to survive a slow page load between minting and dialling, short enough
 * that one left in a log is worthless by the time anybody reads it.
 */
const TICKET_TTL_MS = 2 * 60 * 1000;

interface Ticket {
  cycleId: string;
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

export class VncTicketInvalid extends Error {}

/**
 * Mint a single-use ticket for a viewer.
 *
 * The caller has already proved who it is (a cookie-authenticated route) and that it
 * owns the agent. This is only the handoff to a socket that cannot carry that proof:
 * a browser cannot set headers on a WebSocket handshake, which is the same constraint
 * `browser-control-ws.ts` solved the same way.
 *
 * 32 bytes from randomBytes, not randomUUID — a v4 uuid leaks version bits and carries
 * 122 bits. This is the credential that turns an anonymous socket into someone's live
 * screen, so it gets full-strength randomness.
 */
export function mintVncTicket(cycleId: string, userId: string): string {
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    cycleId,
    userId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return ticket;
}

/** Redeem a ticket. Single-use: a second attempt fails, and so does an expired one. */
export function consumeVncTicket(ticket: string): {
  cycleId: string;
  userId: string;
} {
  const found = tickets.get(ticket);
  if (!found) throw new VncTicketInvalid('unknown or already-used ticket');
  // Deleted before the expiry check so an expired ticket is burned too, rather than
  // left behind for a second attempt to keep probing.
  tickets.delete(ticket);
  if (Date.now() > found.expiresAt)
    throw new VncTicketInvalid('expired ticket');
  return { cycleId: found.cycleId, userId: found.userId };
}

interface Relay {
  ws: WebSocket;
  agentId: string;
  cycleId: string;
}

/** cycleId -> the container's relay socket. */
const relays = new Map<string, Relay>();
/** cycleId -> the one attached viewer, if anybody is watching. */
const viewers = new Map<string, WebSocket>();

/** Is a cycle currently offering a screen to watch? */
export function hasVncRelay(cycleId: string): boolean {
  const relay = relays.get(cycleId);
  return !!relay && relay.ws.readyState === relay.ws.OPEN;
}

/** The agent a cycle's relay belongs to, or null. Never taken from the client. */
export function agentForVncRelay(cycleId: string): string | null {
  return relays.get(cycleId)?.agentId ?? null;
}

function tellRelay(cycleId: string, message: Record<string, unknown>): void {
  const relay = relays.get(cycleId);
  if (!relay || relay.ws.readyState !== relay.ws.OPEN) return;
  try {
    relay.ws.send(JSON.stringify(message));
  } catch (err) {
    logger.debug({ cycleId, err }, 'cycle vnc: could not signal the relay');
  }
}

/**
 * Attach a viewer to a cycle's screen. Replaces whoever was watching.
 *
 * Exported rather than handled inline because phase 4's ticket route is what decides a
 * viewer is allowed to be here; this only wires up an already-authorised socket.
 */
export function attachVncViewer(cycleId: string, ws: WebSocket): boolean {
  if (!hasVncRelay(cycleId)) return false;

  // Register the newcomer BEFORE closing whoever was here, so that when the old
  // socket's close handler runs it sees it has already been replaced and stays quiet.
  // The other order sends a spurious `detach`, and if that lands after the `attach`
  // below it tears down the session the new viewer just asked for. Not hypothetical —
  // a test with a synchronously-closing socket reproduced exactly that.
  const previous = viewers.get(cycleId);
  viewers.set(cycleId, ws);
  if (previous && previous !== ws) {
    try {
      previous.close(1000, 'replaced by another viewer');
    } catch {
      /* gone */
    }
  }
  // A fresh RFB session for the newcomer: the old one's handshake state means nothing
  // to them, and resuming mid-conversation is how a viewer gets a screen of garbage.
  tellRelay(cycleId, { t: 'attach' });

  let downFirst = true;
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    // Only bytes go down. A viewer must not be able to send control frames the relay
    // would act on — `attach`/`detach` are the orchestrator's to decide.
    if (!isBinary) {
      // Logged rather than silently dropped: a client whose bytes arrive as text
      // would stall the handshake with no error anywhere, and that is exactly the
      // kind of silence that costs an afternoon.
      logger.info(
        { cycleId, bytes: data.length },
        'cycle vnc: dropped a NON-BINARY frame from the viewer',
      );
      return;
    }
    const relay = relays.get(cycleId);
    if (!relay || relay.ws.readyState !== relay.ws.OPEN) {
      logger.info(
        { cycleId, hasRelay: !!relay },
        'cycle vnc: viewer bytes with no relay to take them',
      );
      return;
    }
    try {
      relay.ws.send(data, { binary: true });
      if (downFirst) {
        downFirst = false;
        logger.info(
          { cycleId, bytes: data.length },
          'cycle vnc: first bytes viewer -> container',
        );
      }
    } catch (err) {
      logger.debug(
        { cycleId, err },
        'cycle vnc: forwarding viewer input failed',
      );
    }
  });

  const drop = () => {
    if (viewers.get(cycleId) === ws) {
      viewers.delete(cycleId);
      // Let the container close its RFB session rather than holding one open for
      // a viewer that has gone. x11vnc keeps running; only the session ends.
      tellRelay(cycleId, { t: 'detach' });
      logger.info({ cycleId }, 'cycle vnc: viewer left');
    }
  };
  ws.on('close', drop);
  ws.on('error', drop);

  logger.info({ cycleId }, 'cycle vnc: viewer attached');
  return true;
}

export function installCycleVncWs(server: http.Server): void {
  // noServer, like every other socket sharing this http server: an upgrade handler
  // that does not own the path must return quietly rather than claim it.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://placeholder');
    } catch {
      return; // not ours
    }
    if (url.pathname !== CYCLE_VNC_WS_PATH) return;

    // Two ends dial the same path and prove themselves differently, because one is
    // Python and one is a browser. Which branch to take is decided by what was
    // presented, never by anything the caller gets to assert about itself.
    const header = req.headers['x-cycle-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (token) {
      const claim = resolveCycleToken(token);
      if (!claim) {
        // Refused before the upgrade completes, so an invalid token never
        // becomes a socket: nothing to probe, nothing to keep alive.
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        attachRelay(ws, claim.agentId, claim.cycleId),
      );
      return;
    }

    const ticket = url.searchParams.get('ticket') ?? '';
    let redeemed: { cycleId: string; userId: string };
    try {
      redeemed = consumeVncTicket(ticket);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // The cycle comes from the ticket, not the query string: a redeemed ticket names
    // exactly one screen, so there is no cycle id for a caller to swap.
    if (!hasVncRelay(redeemed.cycleId)) {
      // The run ended between minting and dialling. Say so rather than opening a
      // socket that will never carry a pixel.
      socket.write('HTTP/1.1 409 Conflict\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!attachVncViewer(redeemed.cycleId, ws)) {
        try {
          ws.close(1001, 'no screen to watch');
        } catch {
          /* gone */
        }
      }
    });
  });

  logger.info({ path: CYCLE_VNC_WS_PATH }, 'cycle vnc websocket installed');
}

function attachRelay(ws: WebSocket, agentId: string, cycleId: string): void {
  const previous = relays.get(cycleId);
  if (previous && previous.ws !== ws) {
    // A cycle that reconnected. Still the same run — the token is still valid — so
    // it replaces rather than being refused.
    try {
      previous.ws.close();
    } catch {
      /* already gone */
    }
  }
  relays.set(cycleId, { ws, agentId, cycleId });
  logger.info({ agentId, cycleId }, 'cycle vnc: relay open');

  let upFirst = true;
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary) return; // the relay speaks only pixels upward
    const viewer = viewers.get(cycleId);
    if (!viewer || viewer.readyState !== viewer.OPEN) {
      // The loudest possible symptom of "the screen never opens": pixels arriving
      // with nobody registered to receive them, or a viewer socket the bridge
      // thinks is not open. Silence here is what makes that invisible.
      logger.info(
        {
          cycleId,
          bytes: data.length,
          hasViewer: !!viewer,
          readyState: viewer?.readyState,
        },
        'cycle vnc: container bytes with no open viewer',
      );
      return;
    }
    try {
      viewer.send(data, { binary: true });
      if (upFirst) {
        upFirst = false;
        logger.info(
          { cycleId, bytes: data.length },
          'cycle vnc: first bytes container -> viewer',
        );
      }
    } catch (err) {
      logger.debug(
        { cycleId, err },
        'cycle vnc: forwarding to the viewer failed',
      );
    }
  });

  const drop = () => {
    if (relays.get(cycleId)?.ws === ws) {
      relays.delete(cycleId);
      const viewer = viewers.get(cycleId);
      if (viewer) {
        // The screen is gone; say so by closing rather than leaving a viewer
        // watching a frozen last frame with no way to know it is dead.
        try {
          viewer.close(1001, 'the cycle ended');
        } catch {
          /* gone */
        }
        viewers.delete(cycleId);
      }
      logger.info({ agentId, cycleId }, 'cycle vnc: relay closed');
    }
  };
  ws.on('close', drop);
  ws.on('error', (err) => {
    logger.debug({ cycleId, err }, 'cycle vnc: relay socket error');
    drop();
  });
}

/** Tear down a cycle's bridge — called when the cycle ends, beside token revocation. */
export function closeCycleVnc(cycleId: string): void {
  const viewer = viewers.get(cycleId);
  if (viewer) {
    viewers.delete(cycleId);
    try {
      viewer.close(1001, 'the cycle ended');
    } catch {
      /* gone */
    }
  }
  const relay = relays.get(cycleId);
  if (relay) {
    relays.delete(cycleId);
    try {
      relay.ws.close(1000, 'the cycle ended');
    } catch {
      /* gone */
    }
  }
}
