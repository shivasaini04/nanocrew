/**
 * Client Account routes (Stage 28). Mounted behind requireAuth (NOT admin) so every
 * logged-in user manages their own: profile, password, plan/usage, and BYOK key.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';

import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  getUserById,
  setUserPassword,
  setUserByok,
  clearUserByok,
  getUserByok,
  countUserCyclesThisMonth,
  countUserAgents,
  countUserProjects,
  getUserSecurityPosture,
  setUserSecurityPosture,
  SELECTABLE_SECURITY_POSTURES,
  getPendingToolApprovalsByOwner,
  getUserBusinessContext,
  setUserBusinessContext,
  BUSINESS_CONTEXT_MAX,
  getUserDefaultModel,
  setUserDefaultModel,
  getUserNotifyPrefs,
  setUserNotifyPrefs,
  type SecurityPosture,
  type NotifyPrefs,
} from '../../db.js';
import {
  senderUserId,
  digitsOf,
} from '../../owner-notify/whatsapp-delivery.js';
import {
  resolveTarget,
  ownerTransport,
  getTelegramBot,
} from '../../owner-notify/transport.js';
import { issueLinkCode } from '../../owner-notify/telegram.js';
import { isValidHhmm } from '../../owner-notify/format.js';
import {
  planCycleLimit,
  planAgentLimit,
  planProjectLimit,
  planAllowsByok,
  BYOK_PROVIDER_ENV,
  ADMIN_EMAIL,
} from '../../config.js';
import { sendMail } from '../../auth/mailer.js';
import { encryptByok } from '../../byok-crypto.js';
import { whatsAppSessions } from '../../channels/whatsapp-session.js';
import { logger } from '../../logger.js';

export const accountRouter = Router();

const MIN_PW = 8;

// GET /api/account — the logged-in user's profile, usage, and BYOK status
accountRouter.get('/account', (req: Request, res: Response) => {
  const full = getUserById(req.user!.id);
  if (!full) return res.status(404).json({ error: 'Not found' });
  const byok = getUserByok(full.id);
  res.json({
    user: {
      id: full.id,
      email: full.email,
      role: full.role,
      plan: full.plan ?? null,
      created_at: full.created_at,
    },
    usage: {
      cyclesThisMonth: countUserCyclesThisMonth(full.id),
      cycleLimit: planCycleLimit(full.plan),
      agentCount: countUserAgents(full.id),
      agentLimit: planAgentLimit(full.plan), // Infinity → null over JSON = unlimited
      projectCount: countUserProjects(full.id),
      projectLimit: planProjectLimit(full.plan), // Infinity → null over JSON = unlimited
    },
    byok: { provider: byok.provider, hasKey: !!byok.keyEnc, model: byok.model },
    byokProviders: Object.keys(BYOK_PROVIDER_ENV),
    byokAllowed: planAllowsByok(full.plan), // Pro/Business only — gate the UI to match the server
    hasBilling: !!full.dodo_customer_id, // has a Dodo customer → can open the billing portal
    defaultModel: getUserDefaultModel(full.id), // this owner's default for agents without their own override
  });
});

// POST /api/account/mobile-interest — visitor hit the mobile gate and wants to be notified
// when a mobile experience ships. Fire-and-forget notice to the operator; user is already
// authenticated here (this only fires from inside the dashboard shell), so no input needed.
accountRouter.post(
  '/account/mobile-interest',
  async (req: Request, res: Response) => {
    const full = getUserById(req.user!.id);
    if (ADMIN_EMAIL && full) {
      sendMail(
        ADMIN_EMAIL,
        'Mobile interest',
        `<p>${full.email} hit the mobile gate and asked to be notified when nanocrew's mobile experience ships.</p>`,
      ).catch((err) =>
        logger.warn({ err, userId: full.id }, 'mobile-interest notify failed'),
      );
    }
    res.json({ ok: true });
  },
);

// POST /api/account/password — change password (verify the current one first)
accountRouter.post('/account/password', async (req: Request, res: Response) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as {
    currentPassword?: string;
    newPassword?: string;
  };
  if (!currentPassword || !newPassword)
    return res
      .status(400)
      .json({ error: 'Current and new password are required.' });
  if (String(newPassword).length < MIN_PW)
    return res
      .status(400)
      .json({ error: `New password must be at least ${MIN_PW} characters.` });
  const full = getUserById(req.user!.id);
  if (
    !full ||
    !full.password_hash ||
    !(await verifyPassword(String(currentPassword), full.password_hash))
  ) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  setUserPassword(full.id, await hashPassword(String(newPassword)));
  logger.info({ userId: full.id }, 'User changed their password');
  res.json({ ok: true });
});

// PUT /api/account/byok — store the user's own provider key (encrypted at rest)
accountRouter.put('/account/byok', (req: Request, res: Response) => {
  // BYOK is a Pro/Business perk — gate it, else a Standard user gets unlimited cycles for $15.
  const me = getUserById(req.user!.id);
  if (!planAllowsByok(me?.plan)) {
    return res.status(403).json({
      error:
        'Bring-your-own-key is available on the Pro and Business plans. Upgrade to use your own API key.',
    });
  }
  const { provider, apiKey, model } = (req.body ?? {}) as {
    provider?: string;
    apiKey?: string;
    model?: string;
  };
  const p = String(provider ?? '').toLowerCase();
  if (!BYOK_PROVIDER_ENV[p]) {
    return res.status(400).json({
      error: `Unsupported provider. Use one of: ${Object.keys(BYOK_PROVIDER_ENV).join(', ')}`,
    });
  }
  if (!apiKey || String(apiKey).trim().length < 10) {
    return res.status(400).json({ error: 'A valid API key is required.' });
  }
  setUserByok(
    req.user!.id,
    p,
    encryptByok(String(apiKey).trim()),
    model ? String(model).trim() : null,
  );
  logger.info({ userId: req.user!.id, provider: p }, 'User saved a BYOK key');
  res.json({ ok: true, provider: p });
});

// DELETE /api/account/byok — remove the user's key (revert to platform default)
accountRouter.delete('/account/byok', (req: Request, res: Response) => {
  clearUserByok(req.user!.id);
  logger.info({ userId: req.user!.id }, 'User removed their BYOK key');
  res.json({ ok: true });
});

// PUT /api/account/default-model — this owner's default model for agents that don't
// have their own override. Not plan-gated (unlike BYOK): it's picking among the
// platform's own already-configured models, not bringing an external key.
accountRouter.put('/account/default-model', (req: Request, res: Response) => {
  const { model } = (req.body ?? {}) as { model?: string };
  if (!model || !String(model).trim()) {
    return res.status(400).json({ error: 'A model is required.' });
  }
  setUserDefaultModel(req.user!.id, String(model).trim());
  logger.info({ userId: req.user!.id, model }, 'User set their default model');
  res.json({ ok: true });
});

// DELETE /api/account/default-model — clear it (revert to the platform default)
accountRouter.delete(
  '/account/default-model',
  (req: Request, res: Response) => {
    setUserDefaultModel(req.user!.id, null);
    logger.info({ userId: req.user!.id }, 'User cleared their default model');
    res.json({ ok: true });
  },
);

// ── Security posture — the org-level dial every agent this owner runs inherits. ──
// GET /api/account/security — current posture plus the selectable set.
accountRouter.get('/account/security', (req: Request, res: Response) => {
  res.json({
    posture: getUserSecurityPosture(req.user!.id),
    selectable: SELECTABLE_SECURITY_POSTURES,
  });
});

// PUT /api/account/security — change the posture.
accountRouter.put('/account/security', (req: Request, res: Response) => {
  const { posture } = (req.body ?? {}) as { posture?: string };
  const p = String(posture ?? '')
    .trim()
    .toLowerCase();
  if (!(SELECTABLE_SECURITY_POSTURES as readonly string[]).includes(p)) {
    return res.status(400).json({
      error: `Unknown posture. Use one of: ${SELECTABLE_SECURITY_POSTURES.join(', ')}`,
    });
  }
  setUserSecurityPosture(req.user!.id, p as SecurityPosture);
  logger.info(
    { userId: req.user!.id, posture: p },
    'User changed their security posture',
  );
  res.json({ ok: true, posture: p });
});

// GET /api/account/business — what this owner's crew knows about their business.
accountRouter.get('/account/business', (req: Request, res: Response) => {
  res.json({
    context: getUserBusinessContext(req.user!.id),
    maxLength: BUSINESS_CONTEXT_MAX,
  });
});

// PUT /api/account/business — set or clear it.
//
// Editable on purpose: this string is prefixed to every prompt for every agent
// on the account, so a wrong or stale description quietly degrades all of them
// at once. An empty body clears it rather than erroring.
accountRouter.put('/account/business', (req: Request, res: Response) => {
  const { context } = (req.body ?? {}) as { context?: string };
  const text = String(context ?? '')
    .trim()
    .slice(0, BUSINESS_CONTEXT_MAX);
  setUserBusinessContext(req.user!.id, text);
  logger.info(
    { userId: req.user!.id, cleared: text.length === 0 },
    'User updated their business context',
  );
  res.json({ ok: true, context: text });
});

// GET /api/account/approvals — outside-world tool calls waiting on this owner.
// Owner-scoped at the query, so one client never sees another's pending work.
accountRouter.get('/account/approvals', (req: Request, res: Response) => {
  res.json(getPendingToolApprovalsByOwner(req.user!.id));
});

// ── WhatsApp (Stage 30) — per-client session. QR + state are pushed over socket.io. ──
// GET status
accountRouter.get('/account/whatsapp', (req: Request, res: Response) => {
  res.json(whatsAppSessions.status(req.user!.id));
});
// POST connect — starts the session; client then watches socket 'whatsapp:qr' + 'whatsapp:state'
accountRouter.post(
  '/account/whatsapp/connect',
  async (req: Request, res: Response) => {
    try {
      await whatsAppSessions.connect(req.user!.id);
      res.json({ ok: true, ...whatsAppSessions.status(req.user!.id) });
    } catch (e: any) {
      res
        .status(500)
        .json({ error: e?.message || 'Failed to start WhatsApp session' });
    }
  },
);
// POST disconnect — logs out + wipes that client's auth
accountRouter.post(
  '/account/whatsapp/disconnect',
  async (req: Request, res: Response) => {
    await whatsAppSessions.disconnect(req.user!.id);
    res.json({ ok: true });
  },
);

// ── Phone notifications (stage 64 phase 1) — approvals and questions on the owner's WhatsApp ──

/** How this owner's messages would travel right now, in words the settings card can show. */
function notifyDelivery(userId: string) {
  const t = resolveTarget(userId);
  const sender = senderUserId();
  const senderNumber = sender ? whatsAppSessions.status(sender).number : null;
  if (!t) return { mode: 'none' as const, to: null, from: null };
  if (t.channel === 'telegram')
    return { mode: 'telegram' as const, to: null, from: null };
  return {
    mode: t.selfChat ? ('self' as const) : ('contact' as const),
    to: digitsOf(t.toJid),
    from: t.selfChat ? null : senderNumber,
  };
}

/** The Telegram side of the settings card: is the bot running, and is this owner linked? */
function telegramStatus(userId: string) {
  const bot = getTelegramBot();
  return {
    available: !!bot?.isRunning(),
    botUsername: bot?.username ?? null,
    linked: !!getUserNotifyPrefs(userId).telegramChatId,
  };
}

accountRouter.get('/account/notify', (req: Request, res: Response) => {
  res.json({
    prefs: getUserNotifyPrefs(req.user!.id),
    delivery: notifyDelivery(req.user!.id),
    telegram: telegramStatus(req.user!.id),
  });
});

// POST telegram/link — a one-time deep link that binds the owner's Telegram chat (15 min).
accountRouter.post(
  '/account/notify/telegram/link',
  (req: Request, res: Response) => {
    const bot = getTelegramBot();
    if (!bot?.isRunning() || !bot.username)
      return res
        .status(409)
        .json({ error: 'Telegram is not set up on this server yet.' });
    const code = issueLinkCode(req.user!.id);
    res.json({
      code,
      botUsername: bot.username,
      url: `https://t.me/${bot.username}?start=${code}`,
      expiresInMin: 15,
    });
  },
);

// POST telegram/unlink — stop sending to Telegram; WhatsApp (if any) takes over.
accountRouter.post(
  '/account/notify/telegram/unlink',
  (req: Request, res: Response) => {
    setUserNotifyPrefs(req.user!.id, {
      ...getUserNotifyPrefs(req.user!.id),
      telegramChatId: null,
    });
    res.json({
      ok: true,
      delivery: notifyDelivery(req.user!.id),
      telegram: telegramStatus(req.user!.id),
    });
  },
);

accountRouter.put('/account/notify', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Partial<Record<keyof NotifyPrefs, unknown>>;
  const cur = getUserNotifyPrefs(req.user!.id);
  const next: NotifyPrefs = { ...cur };
  if ('whatsapp' in body) {
    if (typeof body.whatsapp !== 'boolean')
      return res.status(422).json({ error: 'whatsapp must be true or false' });
    next.whatsapp = body.whatsapp;
  }
  if ('phone' in body) {
    if (body.phone === null || body.phone === '') next.phone = null;
    else {
      const digits =
        typeof body.phone === 'string'
          ? body.phone.replace(/[\s()+-]/g, '')
          : '';
      if (!/^\d{8,15}$/.test(digits)) {
        return res.status(422).json({
          error: 'Phone must be digits with country code, e.g. 919876543210',
        });
      }
      next.phone = digits;
    }
  }
  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (key in body) {
      const v = body[key];
      if (v === null || v === '') next[key] = null;
      else if (isValidHhmm(v)) next[key] = v as string;
      else return res.status(422).json({ error: `${key} must be HH:MM` });
    }
  }
  setUserNotifyPrefs(req.user!.id, next);
  res.json({
    prefs: next,
    delivery: notifyDelivery(req.user!.id),
    telegram: telegramStatus(req.user!.id),
  });
});

// POST test — one message on the route real notifications would take.
accountRouter.post(
  '/account/notify/test',
  async (req: Request, res: Response) => {
    const t = resolveTarget(req.user!.id);
    if (!t)
      return res
        .status(409)
        .json({ error: 'No route yet — connect Telegram or WhatsApp above.' });
    const text =
      '✅ NanoCrew test — approvals and questions from your agents will arrive here. Tap a button, or reply *1* / *2* / your answer.';
    const id = await ownerTransport.send(t, text);
    if (!id)
      return res.status(502).json({
        error: `${t.channel === 'telegram' ? 'Telegram' : 'WhatsApp'} did not accept the message — check the connection.`,
      });
    res.json({ sent: true, delivery: notifyDelivery(req.user!.id) });
  },
);
