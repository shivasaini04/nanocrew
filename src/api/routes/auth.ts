/**
 * Stage 28 — auth routes (Topic 03, Phase 2): login / logout / me.
 * Mounted PUBLICLY (before the requireAuth gate) so the login form can reach them.
 */
import { randomUUID, randomBytes } from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';

import {
  SIGNUP_OPEN,
  APP_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
} from '../../config.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
  touchUserLastActive,
  setSessionImpersonation,
  issueOtp,
  verifyOtp,
  setUserPassword,
  upsertPendingSignup,
  getPendingSignup,
  deletePendingSignup,
  markUserOnboarded,
} from '../../db.js';
import { sendMail, otpEmailHtml } from '../../auth/mailer.js';
import { agentService } from '../../agents/agent-registry.js';
import { logger } from '../../logger.js';
import { startSession, endSession, toSafeUser } from '../middleware/auth.js';

export const authRouter = Router();

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LEN = 8;

// ── Login brute-force guard: 5 failed attempts / IP / 15 min (Topic 03 security) ──
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const fails = new Map<string, { count: number; first: number }>();

function isLockedOut(ip: string): boolean {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    fails.delete(ip);
    return false;
  }
  return rec.count >= MAX_FAILS;
}

function recordFail(ip: string): void {
  const rec = fails.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    fails.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}

authRouter.post('/auth/login', async (req: Request, res: Response) => {
  const ip = req.ip ?? 'unknown';
  if (isLockedOut(ip)) {
    res
      .status(429)
      .json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
    return;
  }

  const { email, password } = (req.body ?? {}) as {
    email?: string;
    password?: string;
  };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }

  const user = getUserByEmail(String(email));
  // Constant message for every failure mode so we don't leak which emails exist.
  const ok =
    !!user &&
    user.status !== 'suspended' &&
    (await verifyPassword(String(password), user.password_hash));
  if (!user || !ok) {
    recordFail(ip);
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  fails.delete(ip);
  startSession(res, user.id);
  touchUserLastActive(user.id);
  logger.info({ userId: user.id, role: user.role }, 'User logged in');
  res.json({ user: toSafeUser(user) });
});

// ── Passwordless login via emailed OTP ────────────────────────────────────────
authRouter.post('/auth/login/request', async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '')
    .trim()
    .toLowerCase();
  // Always ok — never reveal whether the email is registered.
  if (EMAIL_RE.test(email)) {
    const user = getUserByEmail(email);
    if (user && user.status !== 'suspended') {
      const code = issueOtp(email, 'login');
      await sendMail(
        email,
        'Your nanocrew sign-in code',
        otpEmailHtml(code, 'login'),
      );
      logger.info({ email }, 'Login code issued');
    }
  }
  res.json({ ok: true });
});

authRouter.post('/auth/login/verify', (req: Request, res: Response) => {
  const { email: rawEmail, code } = (req.body ?? {}) as {
    email?: string;
    code?: string;
  };
  const email = String(rawEmail ?? '')
    .trim()
    .toLowerCase();
  if (!email || !code) {
    res.status(400).json({ error: 'Email and code are required.' });
    return;
  }
  const user = getUserByEmail(email);
  if (
    !user ||
    user.status === 'suspended' ||
    !verifyOtp(email, 'login', String(code))
  ) {
    res.status(401).json({ error: 'Invalid or expired code.' });
    return;
  }
  startSession(res, user.id);
  touchUserLastActive(user.id);
  logger.info({ userId: user.id }, 'User logged in via code');
  res.json({ user: toSafeUser(user) });
});

// Public, unauthenticated: lets the login/signup UI know whether self-serve signup
// is enabled (SIGNUP_OPEN) so it can show/hide the "Create account" link + route.
authRouter.get('/auth/config', (_req: Request, res: Response) => {
  res.json({ signupOpen: SIGNUP_OPEN });
});

// Step 1 of signup — validate, stash the hashed password, email a verification code.
// No account is created until the code is verified.
authRouter.post('/auth/signup/request', async (req: Request, res: Response) => {
  if (!SIGNUP_OPEN) {
    res.status(403).json({ error: 'Signups are currently invite-only.' });
    return;
  }
  const { email, password } = (req.body ?? {}) as {
    email?: string;
    password?: string;
  };
  const normEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normEmail || !password) {
    res.status(400).json({ error: 'Email and password are required.' });
    return;
  }
  if (!EMAIL_RE.test(normEmail)) {
    res.status(400).json({ error: 'Enter a valid email address.' });
    return;
  }
  if (String(password).length < MIN_PASSWORD_LEN) {
    res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
    });
    return;
  }
  if (getUserByEmail(normEmail)) {
    res
      .status(409)
      .json({ error: 'An account with that email already exists.' });
    return;
  }
  upsertPendingSignup(normEmail, await hashPassword(String(password)));
  const code = issueOtp(normEmail, 'signup');
  await sendMail(
    normEmail,
    'Verify your nanocrew email',
    otpEmailHtml(code, 'signup'),
  );
  logger.info({ email: normEmail }, 'Signup verification code issued');
  res.json({ ok: true });
});

// Step 2 of signup — verify the code, create the account, auto-login.
authRouter.post('/auth/signup/verify', async (req: Request, res: Response) => {
  if (!SIGNUP_OPEN) {
    res.status(403).json({ error: 'Signups are currently invite-only.' });
    return;
  }
  const { email, code } = (req.body ?? {}) as { email?: string; code?: string };
  const normEmail = String(email ?? '')
    .trim()
    .toLowerCase();
  if (!normEmail || !code) {
    res.status(400).json({ error: 'Email and code are required.' });
    return;
  }
  const pending = getPendingSignup(normEmail);
  if (!pending || !verifyOtp(normEmail, 'signup', String(code))) {
    res.status(400).json({ error: 'Invalid or expired code.' });
    return;
  }
  if (getUserByEmail(normEmail)) {
    deletePendingSignup(normEmail);
    res
      .status(409)
      .json({ error: 'An account with that email already exists.' });
    return;
  }
  const id = randomUUID();
  createUser({
    id,
    email: normEmail,
    password_hash: pending.password_hash,
    role: 'user',
    created_at: new Date().toISOString(),
  });
  deletePendingSignup(normEmail);
  startSession(res, id);
  touchUserLastActive(id);
  try {
    await agentService.ensureRecruiterAgent(id);
  } catch (err) {
    logger.warn(
      { err, userId: id },
      'Recruiter provisioning on signup failed (will backfill on boot)',
    );
  }
  logger.info({ userId: id }, 'New user signed up (email verified)');
  const created = getUserById(id);
  res.status(201).json({ user: created ? toSafeUser(created) : null });
});

// ── Password reset via emailed OTP ────────────────────────────────────────────
authRouter.post(
  '/auth/forgot-password',
  async (req: Request, res: Response) => {
    const email = String(req.body?.email ?? '')
      .trim()
      .toLowerCase();
    // Always return ok so we never reveal whether an email is registered.
    if (EMAIL_RE.test(email)) {
      const user = getUserByEmail(email);
      if (user) {
        const code = issueOtp(email, 'reset');
        await sendMail(
          email,
          'Reset your nanocrew password',
          otpEmailHtml(code, 'reset'),
        );
        logger.info({ email }, 'Password reset code issued');
      }
    }
    res.json({ ok: true });
  },
);

authRouter.post('/auth/reset-password', async (req: Request, res: Response) => {
  const {
    email: rawEmail,
    code,
    password,
  } = (req.body ?? {}) as { email?: string; code?: string; password?: string };
  const email = String(rawEmail ?? '')
    .trim()
    .toLowerCase();
  if (!email || !code || !password) {
    res
      .status(400)
      .json({ error: 'Email, code and new password are required.' });
    return;
  }
  if (String(password).length < MIN_PASSWORD_LEN) {
    res.status(400).json({
      error: `Password must be at least ${MIN_PASSWORD_LEN} characters.`,
    });
    return;
  }
  const user = getUserByEmail(email);
  if (!user || !verifyOtp(email, 'reset', String(code))) {
    res.status(400).json({ error: 'Invalid or expired code.' });
    return;
  }
  setUserPassword(user.id, await hashPassword(String(password)));
  logger.info({ userId: user.id }, 'Password reset');
  res.json({ ok: true });
});

// ── Google OAuth ──────────────────────────────────────────────────────────────
const oauthIsProd = APP_URL.startsWith('https');

// GET /api/auth/google — kick off the consent flow.
authRouter.get('/auth/google', (_req: Request, res: Response) => {
  if (!GOOGLE_CLIENT_ID) {
    res.status(503).send('Google sign-in is not configured.');
    return;
  }
  const state = randomBytes(16).toString('hex');
  // CSRF: stash state in a signed cookie, verify it on callback.
  res.cookie('g_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: oauthIsProd,
    maxAge: 10 * 60 * 1000,
    path: '/',
    signed: true,
  });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  );
});

// GET /api/auth/google/callback — exchange code, find-or-create user, set session.
authRouter.get('/auth/google/callback', async (req: Request, res: Response) => {
  const fail = (reason: string) => res.redirect(`${APP_URL}/?error=${reason}`);
  try {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const cookieState = req.signedCookies?.['g_oauth_state'];
    res.clearCookie('g_oauth_state', { path: '/' });
    if (!code || !state || state !== cookieState) return fail('oauth_state');

    // Exchange the code for tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokenRes.ok) return fail('oauth_token');
    const tokens = (await tokenRes.json()) as { access_token?: string };
    if (!tokens.access_token) return fail('oauth_token');

    // Fetch the verified email.
    const uiRes = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );
    if (!uiRes.ok) return fail('oauth_userinfo');
    const ui = (await uiRes.json()) as {
      email?: string;
      email_verified?: boolean;
    };
    const email = ui.email?.toLowerCase();
    if (!email || ui.email_verified === false) return fail('oauth_email');

    let user = getUserByEmail(email);
    if (!user) {
      if (!SIGNUP_OPEN) return fail('signup_closed');
      const id = randomUUID();
      // OAuth-only account: random unusable password (they can set one via reset later).
      createUser({
        id,
        email,
        password_hash: await hashPassword(randomBytes(24).toString('hex')),
        role: 'user',
        created_at: new Date().toISOString(),
      });
      try {
        await agentService.ensureRecruiterAgent(id);
      } catch {
        /* boot backfill retries */
      }
      user = getUserById(id);
      logger.info({ userId: id, email }, 'New user via Google');
    }
    if (!user || user.status === 'suspended') return fail('suspended');

    startSession(res, user.id);
    touchUserLastActive(user.id);
    logger.info({ userId: user.id }, 'User logged in via Google');
    res.redirect(`${APP_URL}/`);
  } catch (err) {
    logger.error({ err }, 'Google OAuth callback failed');
    fail('oauth');
  }
});

authRouter.post('/auth/logout', (req: Request, res: Response) => {
  endSession(req, res);
  res.json({ ok: true });
});

authRouter.get('/auth/me', (req: Request, res: Response) => {
  // req.user is populated by the global attachUser middleware.
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  // When an admin is "viewing as" a client, surface it so the UI can show a banner.
  res.json({
    user: req.user,
    impersonating: !!req.realUser,
    realEmail: req.realUser?.email ?? null,
  });
});

// Mark the current user as having finished the first-run onboarding overview.
authRouter.post('/auth/onboarded', (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  markUserOnboarded(req.user.id);
  const fresh = getUserById(req.user.id);
  res.json({ user: fresh ? toSafeUser(fresh) : req.user });
});

// Stop "view as client" — clears impersonation on the current session. Not behind
// requireAdmin because during impersonation req.user is the client (role 'user'),
// but req.sessionId is still the admin's session, which is what we clear.
authRouter.post('/auth/stop-impersonating', (req: Request, res: Response) => {
  if (req.sessionId) setSessionImpersonation(req.sessionId, null);
  res.json({ ok: true });
});
