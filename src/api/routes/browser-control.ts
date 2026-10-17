/**
 * Registration for the browser extension (stage 45 doc 05, phase 2).
 *
 * One cookie-authenticated endpoint that hands back a single-use ticket. Everything after
 * this is the WebSocket in ../browser-control-ws.ts.
 */
import { Router } from 'express';

import { logger } from '../../logger.js';

import {
  browserBroker,
  derivePrincipal,
  filterCapabilities,
  BROWSER_CONTROL_PROTOCOL_VERSION,
  BASE_CAPABILITIES,
  ARTIFACT_CAPABILITIES,
  DEVELOPER_CAPABILITIES,
} from '../../agents/browser-broker.js';
import { BROWSER_CONTROL_WS_PATH } from '../browser-control-ws.js';

export const browserControlRouter = Router();

/** Developer mode is off unless the deployment turns it on. Fail closed, globally. */
function developerMode(): boolean {
  return process.env.BROWSER_CONTROL_DEVELOPER_MODE === 'on';
}

/**
 * What the server is willing to grant, so an extension can show the user what it is about
 * to ask for instead of discovering it at negotiation time.
 */
browserControlRouter.get('/browser-control/capabilities', (_req, res) => {
  res.json({
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    base: BASE_CAPABILITIES,
    artifact: ARTIFACT_CAPABILITIES,
    developer: developerMode() ? DEVELOPER_CAPABILITIES : [],
  });
});

/**
 * POST /api/browser-control/register
 *
 * Body: { browserProfileId, controllerId, capabilities[] }
 * Returns: { ticket, wsPath, protocolVersion, capabilities }
 *
 * The principal is derived from the authenticated session and never read from the body.
 * A client that sends one is describing itself, not choosing who it is — the same rule
 * Hermes enforces server-side, and the reason a stolen ticket cannot be re-scoped.
 */
browserControlRouter.post('/browser-control/register', (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { browserProfileId, controllerId, capabilities, resume, sites } =
    (req.body ?? {}) as {
      sites?: unknown;
      browserProfileId?: unknown;
      controllerId?: unknown;
      capabilities?: unknown;
      resume?: unknown;
    };

  if (typeof browserProfileId !== 'string' || !browserProfileId.trim()) {
    res.status(400).json({ error: 'browserProfileId is required' });
    return;
  }
  if (typeof controllerId !== 'string' || !controllerId.trim()) {
    res.status(400).json({ error: 'controllerId is required' });
    return;
  }
  const requested = Array.isArray(capabilities)
    ? capabilities.filter((c) => typeof c === 'string')
    : [];

  const principal = derivePrincipal(user.id);

  // The kill switch, honoured at the one door back in. `resume` is only ever sent when a
  // human clicked Connect; the extension's own three-second reconnect never sets it, so
  // Stop stays stopped instead of meaning "pause for three seconds".
  if (browserBroker.isHalted(principal)) {
    if (resume === true) {
      browserBroker.resume(principal);
    } else {
      res.status(423).json({
        error:
          'Browser control is stopped. Open the NanoCrew Bridge popup and click Connect to allow it again.',
        halted: true,
      });
      return;
    }
  }

  const scope = {
    principal,
    browserProfileId: browserProfileId.trim(),
    controllerId: controllerId.trim(),
  };
  const granted = filterCapabilities(requested, developerMode());
  // Who connected. A desktop app sends its version here; the extension sends nothing.
  // Recorded so a support conversation can start from a fact rather than a question —
  // you cannot SSH into a customer's laptop to find out.
  const client = String(req.headers['x-nanocrew-client'] ?? '').slice(0, 120);
  if (client) {
    logger.info(
      { principal: principal.slice(0, 8), client },
      'browser controller registering',
    );
  }

  // Which sites this browser is actually signed into.
  //
  // Without it an agent has no idea, and reasons accordingly: asked to open a LinkedIn
  // feed it replied "would you like to provide credentials?" rather than simply
  // navigating to a browser that was already logged in. Observed 2026-09-06. The app
  // knows — it reads its own cookie store — but that knowledge stopped at the client.
  if (Array.isArray(sites)) {
    browserBroker.noteSites(
      scope,
      sites.filter((x) => typeof x === 'string').slice(0, 20),
    );
  }

  const ticket = browserBroker.mintTicket(scope, requested, developerMode());

  res.json({
    ticket,
    wsPath: BROWSER_CONTROL_WS_PATH,
    protocolVersion: BROWSER_CONTROL_PROTOCOL_VERSION,
    capabilities: granted,
  });
});

/**
 * POST /api/browser-control/stop — the kill switch.
 *
 * Cancels every command in flight for this user, drops their controllers, and refuses new
 * ones until a human clicks Connect again. It works when the agent is hung, mid-tool-call
 * or ignoring its own timeouts, because the container can only reach a browser through the
 * broker and this is enforced in the broker.
 *
 * Cookie-authenticated: stopping is the user's decision about the user's own browser.
 */
browserControlRouter.post('/browser-control/stop', (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const cancelled = browserBroker.halt(derivePrincipal(user.id));
  res.json({ stopped: true, cancelledCommands: cancelled });
});

/** GET /api/browser-control/status — what this user's own browser lane is doing. */
browserControlRouter.get('/browser-control/status', (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const principal = derivePrincipal(user.id);
  res.json({
    halted: browserBroker.isHalted(principal),
    controllers: browserBroker.onlineControllersFor(principal).map((s) => ({
      controllerId: s.controllerId,
      browserProfileId: s.browserProfileId,
    })),
  });
});
