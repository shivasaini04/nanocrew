/**
 * Signing into the desktop app, without the app ever seeing a password.
 *
 * ## Why the app cannot just show a login form
 *
 * It can, for email and password — that works today. It cannot for Google, and the reason
 * is policy rather than plumbing: Google refuses OAuth from embedded browsers
 * (`disallowed_useragent`), and Electron's User-Agent carries the exact marker they look
 * for. Measured 2026-09-06: the sign-in page loads in the app, which makes this worse
 * rather than better — it looks like it works until it does not, and enforcement can
 * tighten at any time.
 *
 * The tempting fix is to strip `Electron/` from the User-Agent. That is deliberately
 * circumventing a security check, it breaks whenever detection improves, and it is not
 * something to be doing in a product sold to businesses.
 *
 * ## The flow this implements
 *
 *     app                     system browser                 server
 *      │  open login?desktop=1  →                              │
 *      │                        │  user signs in (ANY method)  │
 *      │                        │  ──────────────────────────→ │  session cookie set
 *      │                        │  ← redirect nanocrew://auth?ticket
 *      │  ← deep link ──────────┘                              │
 *      │  POST /desktop/redeem  ──────────────────────────────→│  ticket → session
 *      │  ← its own session cookie                             │
 *
 * The credentials only ever touch the user's real browser. The app receives a single-use
 * ticket and trades it for a session of its own.
 *
 * ## Why this is not Google-specific
 *
 * It works for every sign-in method the dashboard offers — Google, email and password, or
 * anything added later — because the app is not involved in authentication at all. It
 * asks the browser to do it and waits for the result. A Google-only path would have to be
 * rebuilt the first time another provider is added.
 *
 * ## Why the ticket is short-lived and single-use
 *
 * It travels through a URL, which means it can land in shell history, a browser's
 * autocomplete, or a screen recording. Sixty seconds and one redemption keeps that
 * exposure meaningless. It is bound to the user it was minted for and to nothing else —
 * possession is the whole proof, exactly like the browser broker's controller ticket, and
 * for the same reason.
 */

import crypto from 'crypto';

import { Router } from 'express';

import { logger } from '../../logger.js';
import { startSession } from '../middleware/auth.js';

export const desktopAuthRouter = Router();

/** A minted ticket, waiting to be redeemed. */
interface Ticket {
  userId: string;
  expiresAt: number;
}

/**
 * In memory on purpose.
 *
 * A ticket is valid for a minute and is consumed once. Persisting it would mean a
 * restart could resurrect a credential the user has long since finished using, for no
 * gain — if the orchestrator restarts mid-sign-in, the user clicks the button again.
 */
const tickets = new Map<string, Ticket>();

const TICKET_TTL_MS = 60_000;

/** Drop expired tickets whenever the map is touched, so it cannot grow without bound. */
function sweep(): void {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(id);
  }
}

/**
 * POST /api/auth/desktop/ticket
 *
 * Called by the DASHBOARD, in the system browser, straight after a successful sign-in
 * when it was opened with `?desktop=1`. Cookie-authenticated: the caller is already the
 * user, and this hands them something the app can present as proof.
 */
desktopAuthRouter.post('/auth/desktop/ticket', (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  sweep();
  // 32 bytes from randomBytes, not randomUUID: this is the one credential that turns an
  // anonymous app into a signed-in one, so it gets full-strength randomness rather than
  // a v4 UUID's 122 bits with version bits leaked.
  const ticket = crypto.randomBytes(32).toString('base64url');
  tickets.set(ticket, {
    userId: user.id,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });

  logger.info({ userId: user.id }, 'desktop auth ticket minted');
  res.json({
    ticket,
    redirect: `nanocrew://auth?ticket=${encodeURIComponent(ticket)}`,
  });
});

/**
 * POST /api/auth/desktop/redeem
 *
 * Called by the APP. Trades the ticket for a session cookie in the app's own cookie jar.
 * Single-use, and burned even when expired so a stale ticket cannot be probed repeatedly.
 */
desktopAuthRouter.post('/auth/desktop/redeem', (req, res) => {
  const ticket = String(
    (req.body as { ticket?: unknown } | undefined)?.ticket ?? '',
  );
  if (!ticket) {
    res.status(400).json({ error: 'ticket is required' });
    return;
  }

  sweep();
  const found = tickets.get(ticket);
  // Delete before checking expiry, so an expired ticket is burned rather than left for
  // a second attempt to keep testing.
  tickets.delete(ticket);

  if (!found || found.expiresAt <= Date.now()) {
    res.status(401).json({ error: 'unknown or expired ticket' });
    return;
  }

  startSession(res, found.userId);
  logger.info({ userId: found.userId }, 'desktop app signed in via ticket');
  res.json({ ok: true });
});
