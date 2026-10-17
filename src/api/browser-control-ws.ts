/**
 * The extension's transport (stage 45 doc 05, phase 2).
 *
 * A raw WebSocket rather than socket.io, deliberately: the client here is an MV3 service
 * worker, and a plain `new WebSocket(url)` needs no bundled client library inside the
 * extension. socket.io stays what the dashboard uses.
 *
 * Auth is the ticket, not the cookie. `POST /api/browser-control/register` is
 * cookie-authenticated because the user is signed into the dashboard, and it hands back a
 * single-use ticket the socket presents. That keeps the socket independent of whether a
 * browser chooses to attach cookies to an extension-initiated upgrade, and it is the
 * design Hermes arrived at for the same reason.
 *
 * Wire protocol (JSON, both directions):
 *
 *   S -> C   { t: 'cmd',    id, capability, payload }
 *   C -> S   { t: 'result', id, ok: true,  result }
 *            { t: 'result', id, ok: false, error }
 *   C -> S   { t: 'hello',  protocolVersion }
 *
 * The protocol version is compared exactly — no ranges, no coercion — because a
 * half-understood command reaching a logged-in browser is worse than a refused connection.
 */
import type http from 'http';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  browserBroker,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  ControllerTicketInvalid,
  type Command,
  type ControllerScope,
} from '../agents/browser-broker.js';
import { deferredForBrowser } from '../agents/local-lane-routing.js';
import { logger } from '../logger.js';
import {
  runFollowupsOnAttach,
  triggerAgentOnBrowserAttach,
} from './browser-attach-wake.js';

export const BROWSER_CONTROL_WS_PATH = '/api/browser-control/ws';

/** Close codes. 4xxx is the application-defined range. */
const CLOSE_BAD_TICKET = 4001;
const CLOSE_BAD_VERSION = 4002;

export function installBrowserControlWs(server: http.Server): void {
  // noServer: we do the upgrade ourselves so socket.io keeps its own upgrades. Attaching
  // two servers to the same http.Server without this makes them fight over every upgrade.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '', 'http://placeholder');
    } catch {
      return; // not ours; leave it for another handler
    }
    if (url.pathname !== BROWSER_CONTROL_WS_PATH) return;

    const ticket = url.searchParams.get('ticket') ?? '';
    let redeemed: { scope: ControllerScope; capabilities: readonly string[] };
    try {
      redeemed = browserBroker.consumeTicket(ticket);
    } catch (err) {
      // Refuse before the upgrade completes. An invalid ticket never becomes a
      // socket, so there is nothing to probe for and nothing to keep alive.
      if (err instanceof ControllerTicketInvalid) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      } else {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      }
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attachController(ws, redeemed.scope, redeemed.capabilities as never);
    });
  });

  logger.info(
    { path: BROWSER_CONTROL_WS_PATH },
    'browser-control websocket installed',
  );
}

function attachController(
  ws: WebSocket,
  scope: ControllerScope,
  capabilities: never,
): void {
  let helloSeen = false;

  const send: (c: Command) => void = (command) => {
    // Throwing here is meaningful: dispatch() treats a failed send as a failed command
    // rather than parking a waiter that can never be answered.
    if (ws.readyState !== ws.OPEN)
      throw new Error('controller socket is not open');
    ws.send(JSON.stringify({ t: 'cmd', ...command }));
  };

  browserBroker.attach(scope, capabilities, send);

  // stage 52 step 4: a companion arriving is the event a deferred cycle was waiting
  // for. Waking here rather than polling means the gap between plugging in and working
  // is a socket handshake, not a scheduler tick.
  // Stage 60 phase 6: and so is any work queued for this person's computer.
  runFollowupsOnAttach(scope.principal);

  const woken = deferredForBrowser.takeFor(scope.principal);
  if (woken.length) {
    logger.info(
      { principal: scope.principal.slice(0, 8), agents: woken.length },
      'browser attached — waking agents that were waiting for it',
    );
    for (const agentId of woken) {
      // Fire and forget: a wake that fails must not take down the socket that just
      // arrived, and the ordinary schedule will retry anyway.
      void triggerAgentOnBrowserAttach(agentId).catch((err) => {
        logger.warn(
          { agentId, err: String(err) },
          'could not wake a deferred agent',
        );
      });
    }
  }

  ws.on('message', (raw) => {
    let msg: {
      t?: string;
      id?: string;
      ok?: boolean;
      result?: unknown;
      error?: string;
      protocolVersion?: unknown;
    };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return; // unparseable frames are ignored, not fatal — a noisy client is not a hostile one
    }

    if (msg.t === 'hello') {
      // Exact equality, and `typeof` checked, so "1" or 1.0-from-a-float does not pass.
      if (
        typeof msg.protocolVersion !== 'number' ||
        msg.protocolVersion !== BROWSER_CONTROL_PROTOCOL_VERSION
      ) {
        ws.close(CLOSE_BAD_VERSION, 'protocol version mismatch');
        return;
      }
      helloSeen = true;
      return;
    }

    if (msg.t === 'result' && typeof msg.id === 'string') {
      if (!helloSeen) return; // results before a version handshake are not trusted
      if (msg.ok) browserBroker.complete(msg.id, msg.result);
      else
        browserBroker.fail(
          msg.id,
          String(msg.error ?? 'controller reported failure'),
        );
    }
  });

  // An unexpected drop is NOT a detach. The command may still be running in a browser
  // that is fine — an MV3 service worker being killed looks exactly like this — so the
  // controller is marked offline and its in-flight work is left for a re-attach of the
  // same identity to deliver. See browser-broker.ts, disconnect vs detach.
  ws.on('close', () => {
    browserBroker.disconnect(scope, send);
    logger.info(
      { principal: scope.principal.slice(0, 8) },
      'browser controller disconnected',
    );
  });

  ws.on('error', (err) => {
    logger.warn(
      { err: String(err), principal: scope.principal.slice(0, 8) },
      'browser controller socket error',
    );
  });
}

export { CLOSE_BAD_TICKET, CLOSE_BAD_VERSION };
