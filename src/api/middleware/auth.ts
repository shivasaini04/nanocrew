/**
 * Stage 28 — authentication middleware (Topic 03, Phase 2).
 *
 * Session model: on login the server stores a random opaque id in `auth_sessions`
 * and hands the browser a signed, httpOnly cookie holding that id. Every request
 * runs `attachUser` to resolve the cookie → `req.user`. Route guards (`requireAuth`,
 * `requireAdmin`) gate access from there. The cookie carries NO user data — it's just
 * the lookup key — so it can't be tampered into impersonation.
 */
import { randomBytes } from 'crypto';
import cookieParser from 'cookie-parser';
import type { Request, Response, NextFunction } from 'express';

import { APP_URL, SESSION_SECRET, SESSION_TTL_MS } from '../../config.js';
import {
  createAuthSession,
  deleteAuthSession,
  getUserBySession,
  getSessionContext,
  getUserById,
} from '../../db.js';
import type { User } from '../../types.js';

export const SESSION_COOKIE = 'nanocrew_sid';

/** A user safe to send to the client — never includes the password hash. */
export type SafeUser = Omit<User, 'password_hash'>;

// Augment Express's Request so `req.user` / `req.sessionId` are typed everywhere.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Effective user for data access — the impersonated client when an admin is "viewing as". */
      user?: SafeUser;
      /** The real logged-in user. Differs from `user` only while an admin impersonates a client. */
      realUser?: SafeUser;
      sessionId?: string;
    }
  }
}

export function toSafeUser(u: User): SafeUser {
  const { password_hash: _omit, ...rest } = u;
  return rest;
}

// HTTPS-only cookies in prod (behind Caddy); plain http in local dev.
const isProd = APP_URL.startsWith('https');

/** Create a session row + set the signed session cookie on the response. */
export function startSession(res: Response, userId: string): void {
  const id = randomBytes(32).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  createAuthSession({
    id,
    user_id: userId,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  });
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_TTL_MS,
    path: '/',
    signed: true,
  });
}

/** Delete the current session (server + cookie). Safe to call when not logged in. */
export function endSession(req: Request, res: Response): void {
  const id = req.signedCookies?.[SESSION_COOKIE];
  if (id) deleteAuthSession(String(id));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/**
 * Resolve the session cookie → req.user. Never rejects — downstream guards decide
 * whether a missing user is an error. Runs globally so even public routes know who's
 * calling.
 */
export function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const id = req.signedCookies?.[SESSION_COOKIE];
  if (id) {
    const ctx = getSessionContext(String(id));
    if (ctx) {
      req.sessionId = String(id);
      // Admin "view as client": effective user becomes the client; realUser stays the admin.
      if (ctx.impersonating && ctx.user.role === 'admin') {
        const target = getUserById(ctx.impersonating);
        if (target) {
          req.user = toSafeUser(target);
          req.realUser = toSafeUser(ctx.user);
        } else {
          req.user = toSafeUser(ctx.user);
        }
      } else {
        req.user = toSafeUser(ctx.user);
      }
    }
  }
  next();
}

/**
 * Resolve the logged-in user from a raw Cookie header (used by the Socket.IO
 * handshake, which has no Express req). Mirrors attachUser but works off the raw
 * header + signed-cookie verification.
 */
export function resolveUserFromCookieHeader(
  cookieHeader: string | undefined,
): SafeUser | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const rawValue = decodeURIComponent(part.slice(eq + 1).trim());
    // cookie-parser writes signed cookies as 's:<value>.<sig>'; verify + strip it.
    const sessionId = cookieParser.signedCookie(rawValue, SESSION_SECRET);
    if (sessionId === false) return null; // tampered
    const ctx = getSessionContext(sessionId);
    if (!ctx) return null;
    // Honor impersonation so the socket joins the client's room during a support view.
    if (ctx.impersonating && ctx.user.role === 'admin') {
      const target = getUserById(ctx.impersonating);
      if (target) return toSafeUser(target);
    }
    return toSafeUser(ctx.user);
  }
  return null;
}

/** Block the request with 401 unless a valid session is attached. */
export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  next();
}

/** Block the request unless the session belongs to an admin (401 / 403). */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
