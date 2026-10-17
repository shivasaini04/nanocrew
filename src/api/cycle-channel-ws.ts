/**
 * The cycle channel — one bidirectional socket between a running cycle and the
 * orchestrator (stage 49 phase 5.2).
 *
 * ## Why this exists
 *
 * The agent container has no inbound network path: no published ports, nothing
 * listening. Everything it receives today it went and asked for — `/self/steer` is
 * polled once per turn, the approval gate polls every three seconds. That shape is fine
 * for a note or a yes/no. It is wrong for a human moving a mouse: input is per-*event*,
 * not per-turn, and a poll loop fast enough to feel live is a poll loop hammering the
 * orchestrator for nothing the rest of the time.
 *
 * So the container dials out, once, and keeps the socket. Frames go up it and input
 * comes down it.
 *
 * ## Why it is not a new design
 *
 * `browser-control-ws.ts` already does exactly this for the extension: `noServer`,
 * an upgrade handler that ignores paths it does not own, a JSON command/result protocol,
 * and a registry of live sockets. This is that pattern pointed the other way — there,
 * the orchestrator commands a browser; here, it commands a cycle.
 *
 * ## Auth
 *
 * The per-cycle token, in a header. It is already minted per cycle, already travels in
 * the spawn payload, and is revoked the moment the cycle returns
 * (`agents/cycle-token.ts`), so a socket cannot outlive the run it belongs to.
 *
 * In a HEADER and never the query string, which is `extractCycleToken`'s own stated
 * rule: query strings land in access logs and proxy logs. The extension's socket uses a
 * query ticket because a browser cannot set headers on a handshake — this client is
 * Python and can, so it does.
 *
 * The token names the agent AND the cycle (`resolveCycleToken`), so the socket presents
 * one secret and claims nothing beside it. There is no cycleId parameter to spoof.
 */
import type http from 'http';

import { WebSocketServer, type WebSocket } from 'ws';

import { resolveCycleToken } from '../agents/cycle-token.js';
import {
  streamCycleFrame,
  streamCycleTakeover,
} from '../cycle-activity-stream.js';
import { logger } from '../logger.js';

export const CYCLE_CHANNEL_WS_PATH = '/api/cycle-channel/ws';

/** What the orchestrator may send down the channel. Grows with phase 5.3. */
export type CycleChannelOutbound =
  | { t: 'input'; kind: 'mouse' | 'key' | 'scroll'; [k: string]: unknown }
  | { t: 'release' };

interface LiveChannel {
  ws: WebSocket;
  agentId: string;
  cycleId: string;
  /** What the run asked a human for, while it is waiting. Cleared on release. */
  takeoverWaiting?: string;
}

/**
 * cycleId → its socket. Process-local, like the token store it authenticates against:
 * a restart invalidates both together, and a cycle whose orchestrator restarted has
 * already lost its result channel.
 */
const channels = new Map<string, LiveChannel>();

/** Is a cycle currently holding the channel open? */
export function isCycleChannelOpen(cycleId: string): boolean {
  const live = channels.get(cycleId);
  return !!live && live.ws.readyState === live.ws.OPEN;
}

/**
 * Send to one running cycle. False when nothing is listening — the caller decides
 * whether that is worth reporting; for input it means "the run ended under you".
 */
export function sendToCycle(
  cycleId: string,
  message: CycleChannelOutbound,
): boolean {
  const live = channels.get(cycleId);
  if (!live || live.ws.readyState !== live.ws.OPEN) return false;
  // The human is handing back, so nothing is waiting on them any more. Cleared here
  // rather than when the agent's next frame arrives, so a dashboard that reconnects
  // in between is not told to go and do something already done.
  if (message.t === 'release') live.takeoverWaiting = undefined;
  try {
    live.ws.send(JSON.stringify(message));
    return true;
  } catch (err) {
    logger.debug({ cycleId, err }, 'cycle channel send failed');
    return false;
  }
}

/**
 * What a cycle is waiting for a human to do, or null.
 *
 * Read by a dashboard that connected after the ask: the run can sit waiting for fifteen
 * minutes, and the person who needs to act was probably not watching at the moment it
 * asked.
 */
export function takeoverWaitingFor(cycleId: string): string | null {
  return channels.get(cycleId)?.takeoverWaiting ?? null;
}

/** Every cycle currently waiting on a person, for one agent. */
export function waitingCyclesForAgent(
  agentId: string,
): Array<{ cycleId: string; reason: string }> {
  const waiting: Array<{ cycleId: string; reason: string }> = [];
  for (const live of channels.values()) {
    if (live.agentId === agentId && live.takeoverWaiting) {
      waiting.push({ cycleId: live.cycleId, reason: live.takeoverWaiting });
    }
  }
  return waiting;
}

/** Which agent a live cycle belongs to — the ownership check for anything inbound. */
export function agentForCycleChannel(cycleId: string): string | null {
  return channels.get(cycleId)?.agentId ?? null;
}

export function installCycleChannelWs(server: http.Server): void {
  // noServer for the same reason browser-control-ws does it: socket.io, that socket and
  // this one all share the http server, and whoever handles an upgrade must return
  // quietly when the path is not theirs rather than claiming it.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://placeholder');
    } catch {
      return; // not ours
    }
    if (url.pathname !== CYCLE_CHANNEL_WS_PATH) return;

    const header = req.headers['x-cycle-token'];
    const token = Array.isArray(header) ? header[0] : header;
    const claim = resolveCycleToken(token);
    if (!claim) {
      // Refused before the upgrade completes, so an invalid token never becomes a
      // socket — nothing to probe, nothing to keep alive.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) =>
      attach(ws, claim.agentId, claim.cycleId),
    );
  });

  logger.info(
    { path: CYCLE_CHANNEL_WS_PATH },
    'cycle channel websocket installed',
  );
}

function attach(ws: WebSocket, agentId: string, cycleId: string): void {
  // A cycle reconnecting (its socket dropped and it dialled again) replaces the old
  // entry rather than being refused: the token is still valid, so it is still the same
  // run, and refusing would leave it with no channel for the rest of its life.
  const previous = channels.get(cycleId);
  if (previous && previous.ws !== ws) {
    try {
      previous.ws.close();
    } catch {
      /* already gone */
    }
  }
  channels.set(cycleId, { ws, agentId, cycleId });
  logger.info({ agentId, cycleId }, 'cycle channel open');

  ws.on('message', (raw) => {
    let msg: {
      t?: string;
      dataUrl?: string;
      url?: string;
      title?: string;
      reason?: string;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      // A cycle is not a browser and should never send us garbage, but a malformed
      // frame must not take down the channel carrying the rest of the run.
      logger.debug({ cycleId }, 'cycle channel: unparseable message');
      return;
    }

    if (msg.t === 'takeover') {
      // Phase 5.4 — the run has stopped and is waiting for a person.
      //
      // Emitted to the owner's room like a frame, and for the same reason: this
      // names what the agent is stuck on and shows a picture of a browser someone
      // is about to be given the wheel of. `takeoverWaiting` is remembered so a
      // dashboard opened AFTER the ask still learns about it — the run may sit
      // here for fifteen minutes, and the person who needs to act is unlikely to
      // have been watching at the exact moment it asked.
      const reason =
        typeof msg.reason === 'string' ? msg.reason : 'The agent needs a hand.';
      const live = channels.get(cycleId);
      if (live) live.takeoverWaiting = reason;
      streamCycleTakeover(agentId, cycleId, reason);
      return;
    }

    if (msg.t === 'frame' && typeof msg.dataUrl === 'string' && msg.dataUrl) {
      // Straight to the same relay the HTTP frame route uses, so the dashboard sees
      // no difference between a frame that came up this socket and one that did
      // not, and the owner-scoping stays in exactly one place.
      streamCycleFrame(
        agentId,
        cycleId,
        msg.dataUrl,
        msg.url ?? '',
        msg.title ?? '',
      );
      return;
    }
  });

  const drop = () => {
    // Only clear the entry if it is still ours: a reconnect may already have replaced
    // it, and the late close of the old socket must not unregister the new one.
    if (channels.get(cycleId)?.ws === ws) {
      channels.delete(cycleId);
      logger.info({ agentId, cycleId }, 'cycle channel closed');
    }
  };
  ws.on('close', drop);
  ws.on('error', (err) => {
    logger.debug({ cycleId, err }, 'cycle channel socket error');
    drop();
  });
}

/** Close a cycle's channel — called when the cycle ends, alongside token revocation. */
export function closeCycleChannel(cycleId: string): void {
  const live = channels.get(cycleId);
  if (!live) return;
  channels.delete(cycleId);
  try {
    live.ws.close(1000, 'cycle ended');
  } catch {
    /* already gone */
  }
}
