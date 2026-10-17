/**
 * Webhooks — inbound events that trigger agent cycles immediately.
 *
 * Auth modes (tried in order):
 *   1. X-Hub-Signature-256: sha256=<hex>   — GitHub / generic HMAC-SHA256
 *   2. Stripe-Signature: t=<ts>,v1=<hmac>  — Stripe signed payloads
 *   3. ?token=<value>                       — legacy query-param token
 *
 * The agent's webhookToken is used as the HMAC secret for modes 1 & 2,
 * and as the bearer value for mode 3. All comparisons are constant-time.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { DATA_DIR } from '../../config.js';
import { agentService } from '../../agents/agent-registry.js';
import { logger } from '../../logger.js';
import {
  logWebhookDelivery,
  updateWebhookDeliveryStatus,
  getWebhookDeliveries,
  createOutboundWebhook,
  listOutboundWebhooks,
  getOutboundWebhook,
  updateOutboundWebhook,
  deleteOutboundWebhook,
  getOutboundDeliveries,
} from '../../db.js';
import { notify } from '../../notifications.js';
import { requireAuth } from '../middleware/auth.js';
import { canWake } from '../../agents/wake-policy.js';
import { ownsResource } from '../middleware/ownership.js';
import { isAllowedOutboundUrl } from '../../outbound-webhooks.js';

export const webhooksRouter = Router();

// This whole router is mounted BEFORE the global session gate (see server.ts) so the
// inbound event-trigger route below can be called by external services with no
// session cookie — it authenticates via the agent's own webhook token instead.
// But that exemption must NOT extend to managing that token: generating/rotating/
// revoking it, or reading it and the delivery log, are account actions and need a
// real login + ownership check, or any logged-out visitor who learns an agent's UUID
// (a shared link, a screenshot, a referer header) could read or rotate its webhook
// credentials. Applied per-route (not via router.param) so it doesn't also gate the
// intentionally-public /:agentId/:event route below.
function requireOwnedAgent(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const agent = agentService.getAgent(String(req.params.agentId));
  if (!agent) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!ownsResource(req, agent.owner_id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

// ─── Constant-time string comparison ─────────────────────────────────────────

function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a.padEnd(128, '\0'), 'utf-8');
  const bBuf = Buffer.from(b.padEnd(128, '\0'), 'utf-8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── HMAC verification helpers ────────────────────────────────────────────────

/**
 * GitHub / generic: X-Hub-Signature-256: sha256=<hex>
 */
function verifyHubSignature(
  secret: string,
  rawBody: Buffer,
  header: string,
): boolean {
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return timingSafeEqual(expected, header);
}

/**
 * Stripe: Stripe-Signature: t=<timestamp>,v1=<hmac>[,v1=<hmac2>...]
 * Signed payload is: "<timestamp>.<raw_body_utf8>"
 */
function verifyStripeSignature(
  secret: string,
  rawBody: Buffer,
  header: string,
): boolean {
  const parts: Record<string, string[]> = {};
  for (const seg of header.split(',')) {
    const eq = seg.indexOf('=');
    if (eq === -1) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    (parts[k] ??= []).push(v);
  }
  const timestamp = parts.t?.[0] ?? '';
  const signatures = parts.v1 ?? [];
  if (!timestamp || !signatures.length) return false;

  const payload = `${timestamp}.${rawBody.toString('utf-8')}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return signatures.some((sig) => timingSafeEqual(expected, sig));
}

// ─── Auth resolution ──────────────────────────────────────────────────────────

function authorize(
  secret: string,
  req: {
    headers: Record<string, string | string[] | undefined>;
    query: Record<string, unknown>;
  },
  rawBody: Buffer | undefined,
): boolean {
  if (!secret) return false;

  const hubSig = req.headers['x-hub-signature-256'] as string | undefined;
  const stripeSig = req.headers['stripe-signature'] as string | undefined;
  const queryTok = typeof req.query.token === 'string' ? req.query.token : '';

  if (hubSig && rawBody) return verifyHubSignature(secret, rawBody, hubSig);
  if (stripeSig && rawBody)
    return verifyStripeSignature(secret, rawBody, stripeSig);
  if (queryTok) return timingSafeEqual(queryTok, secret);

  return false;
}

// ─── POST /api/webhooks/:agentId/token — generate or rotate webhook token ────
// Must be declared BEFORE /:agentId/:event to avoid Express matching "token" as :event

webhooksRouter.post(
  '/:agentId/token',
  requireAuth,
  requireOwnedAgent,
  async (req, res) => {
    const agent = agentService.getAgent(String(req.params.agentId));
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const newToken = crypto.randomBytes(24).toString('base64url');
    const updatedConfig = { ...agent.config, webhookToken: newToken };

    try {
      await agentService.updateAgent(String(req.params.agentId), {
        config: updatedConfig,
      });
      res.json({ token: newToken });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── DELETE /api/webhooks/:agentId/token — revoke token ──────────────────────
// Must be declared BEFORE /:agentId/:event too (for consistency)

webhooksRouter.delete(
  '/:agentId/token',
  requireAuth,
  requireOwnedAgent,
  async (req, res) => {
    const agent = agentService.getAgent(String(req.params.agentId));
    if (!agent) return res.status(404).json({ error: 'Agent not found' });

    const updatedConfig = { ...agent.config, webhookToken: undefined };
    try {
      await agentService.updateAgent(String(req.params.agentId), {
        config: updatedConfig,
      });
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Outbound webhooks — subscribe an external URL to this agent's own events ─
// Must be declared BEFORE /:agentId/:event (POST /:agentId/outbound would otherwise
// be swallowed by the event-trigger catch-all, same reason as /token above).

const OUTBOUND_EVENT_TYPES = [
  'cycle_completed',
  'cycle_failed',
  'pipeline_fired',
  'agent_error',
  'budget_warning',
  'webhook_received',
  'subagent_done',
  'message_received',
  'agent_alert',
  'handoff_completed',
  'handoff_rejected',
  'handoff_updated',
  'usage_alert',
] as const;

function validateOutboundEvents(events: unknown): string[] | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  if (events.length === 1 && events[0] === '*') return ['*'];
  if (
    !events.every(
      (e) =>
        typeof e === 'string' &&
        (OUTBOUND_EVENT_TYPES as readonly string[]).includes(e),
    )
  )
    return null;
  return events;
}

// Masks the secret in list/get responses — only shown in full at creation time,
// same convention as the inbound token being always-visible-to-owner but this one
// additionally supports "shown once" since there's no legitimate reason to re-copy
// it after initial setup (unlike the inbound token, which the owner re-pastes into
// whatever service they're configuring).
function maskSecret(secret: string): string {
  return secret.length <= 8
    ? '••••••••'
    : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;
}

webhooksRouter.get(
  '/:agentId/outbound',
  requireAuth,
  requireOwnedAgent,
  (req, res) => {
    const hooks = listOutboundWebhooks(String(req.params.agentId));
    res.json(hooks.map((h) => ({ ...h, secret: maskSecret(h.secret) })));
  },
);

webhooksRouter.post(
  '/:agentId/outbound',
  requireAuth,
  requireOwnedAgent,
  async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const events = validateOutboundEvents(req.body?.events);
    if (!url) return res.status(400).json({ error: 'url is required' });
    if (!events)
      return res.status(400).json({
        error: `events must be a non-empty array of ${OUTBOUND_EVENT_TYPES.join(', ')}, or ["*"] for all`,
      });
    if (!(await isAllowedOutboundUrl(url))) {
      return res.status(400).json({
        error:
          'That URL is not reachable, not http(s), or resolves to a private/internal address.',
      });
    }
    const secret = crypto.randomBytes(24).toString('base64url');
    const hook = createOutboundWebhook({
      agent_id: String(req.params.agentId),
      url,
      secret,
      events,
    });
    res.status(201).json(hook); // full secret returned once, at creation
  },
);

webhooksRouter.patch(
  '/:agentId/outbound/:id',
  requireAuth,
  requireOwnedAgent,
  async (req, res) => {
    const existing = getOutboundWebhook(String(req.params.id));
    if (!existing || existing.agent_id !== String(req.params.agentId))
      return res.status(404).json({ error: 'Not found' });

    const patch: { url?: string; events?: string[]; enabled?: boolean } = {};
    if (req.body?.url !== undefined) {
      const url = String(req.body.url).trim();
      if (!(await isAllowedOutboundUrl(url))) {
        return res.status(400).json({
          error:
            'That URL is not reachable, not http(s), or resolves to a private/internal address.',
        });
      }
      patch.url = url;
    }
    if (req.body?.events !== undefined) {
      const events = validateOutboundEvents(req.body.events);
      if (!events)
        return res.status(400).json({
          error: `events must be a non-empty array of ${OUTBOUND_EVENT_TYPES.join(', ')}, or ["*"] for all`,
        });
      patch.events = events;
    }
    if (req.body?.enabled !== undefined) patch.enabled = !!req.body.enabled;

    updateOutboundWebhook(String(req.params.id), patch);
    const updated = getOutboundWebhook(String(req.params.id))!;
    res.json({ ...updated, secret: maskSecret(updated.secret) });
  },
);

webhooksRouter.delete(
  '/:agentId/outbound/:id',
  requireAuth,
  requireOwnedAgent,
  (req, res) => {
    const existing = getOutboundWebhook(String(req.params.id));
    if (!existing || existing.agent_id !== String(req.params.agentId))
      return res.status(404).json({ error: 'Not found' });
    deleteOutboundWebhook(String(req.params.id));
    res.json({ ok: true });
  },
);

webhooksRouter.get(
  '/:agentId/outbound/:id/deliveries',
  requireAuth,
  requireOwnedAgent,
  (req, res) => {
    const existing = getOutboundWebhook(String(req.params.id));
    if (!existing || existing.agent_id !== String(req.params.agentId))
      return res.status(404).json({ error: 'Not found' });
    const limit = Math.min(
      parseInt((req.query.limit as string) || '50', 10),
      200,
    );
    res.json(getOutboundDeliveries(String(req.params.id), limit));
  },
);

// ─── POST /api/webhooks/:agentId/:event ──────────────────────────────────────

webhooksRouter.post('/:agentId/:event', async (req, res) => {
  const { agentId, event } = req.params;

  // 1. Verify the agent exists
  const agent = agentService.getAgent(agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  // 2. Authenticate
  const secret = agent.config.webhookToken ?? '';
  const rawBody: Buffer | undefined = (req as any).rawBody;

  if (!authorize(secret, req as any, rawBody)) {
    return res
      .status(401)
      .json({ error: 'Unauthorized — invalid signature or token' });
  }

  // 3. Write the event payload to the agent's inbox
  const payload = req.body ?? {};
  const now = new Date().toISOString();
  const ts = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const inboxFile = path.join(
    DATA_DIR,
    'agents',
    agentId,
    'workspace',
    'inbox',
    `webhook-${ts}.json`,
  );
  try {
    fs.mkdirSync(path.dirname(inboxFile), { recursive: true });
    fs.writeFileSync(
      inboxFile,
      JSON.stringify({ event, receivedAt: now, payload }, null, 2),
      'utf-8',
    );
  } catch (err) {
    logger.warn(
      { agentId, event, err },
      'Failed to write webhook payload to inbox',
    );
  }

  // 4. Log delivery record
  const delivery = logWebhookDelivery({
    agent_id: agentId,
    event,
    received_at: now,
    payload_preview: JSON.stringify(payload).slice(0, 300),
    cycle_status: 'pending',
  });

  const eventContext = `## Inbound Webhook: ${event}\nReceived at: ${now}\nFull payload at: workspace/inbox/webhook-${ts}.json\nPreview: ${JSON.stringify(payload).slice(0, 200)}`;

  notify(
    'webhook_received',
    `Webhook: ${event}`,
    `Agent ${agentId} received a "${event}" event`,
    agentId,
    { event, deliveryId: delivery.id },
  );
  res.json({ received: true, agentId, event, deliveryId: delivery.id });

  // 5. Respond immediately, then trigger cycle asynchronously
  if (!canWake(agent, 'webhook')) {
    updateWebhookDeliveryStatus(delivery.id, 'skipped');
    logger.info(
      { agentId, event },
      'Webhook received but not woken — wake policy has webhook turned off (or agent is stopped)',
    );
    return;
  }
  setImmediate(async () => {
    updateWebhookDeliveryStatus(delivery.id, 'running');
    try {
      await agentService.runCycle(agentId, 'custom', eventContext);
      updateWebhookDeliveryStatus(delivery.id, 'completed');
      logger.info({ agentId, event }, 'Webhook-triggered cycle completed');
    } catch (err) {
      updateWebhookDeliveryStatus(delivery.id, 'failed');
      logger.error({ agentId, event, err }, 'Webhook-triggered cycle failed');
    }
  });
});

// ─── GET /api/webhooks/:agentId — return webhook info for this agent ──────────

webhooksRouter.get('/:agentId', requireAuth, requireOwnedAgent, (req, res) => {
  const agent = agentService.getAgent(String(req.params.agentId));
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const token = agent.config.webhookToken ?? null;
  const agentId = String(req.params.agentId);
  const base = process.env.WEBHOOK_BASE_URL ?? '';

  res.json({
    token,
    baseUrl: token ? `${base}/api/webhooks/${agentId}` : null,
    authModes: token
      ? {
          query_param: `?token=${token}`,
          hmac_header:
            'X-Hub-Signature-256: sha256=<HMAC-SHA256 of body using token as secret>',
          stripe_header:
            'Stripe-Signature: t=<ts>,v1=<HMAC-SHA256 of "<ts>.<body>">',
        }
      : null,
    examples: token
      ? {
          generic: `${base}/api/webhooks/${agentId}/event_name?token=${token}`,
          github: `${base}/api/webhooks/${agentId}/github_push  (+ X-Hub-Signature-256 header)`,
          stripe: `${base}/api/webhooks/${agentId}/stripe_payment  (+ Stripe-Signature header)`,
        }
      : null,
  });
});

// ─── GET /api/webhooks/:agentId/deliveries — delivery history ────────────────

webhooksRouter.get(
  '/:agentId/deliveries',
  requireAuth,
  requireOwnedAgent,
  (req, res) => {
    try {
      const limit = Math.min(
        parseInt((req.query.limit as string) || '50', 10),
        200,
      );
      res.json(getWebhookDeliveries(String(req.params.agentId), limit));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);
