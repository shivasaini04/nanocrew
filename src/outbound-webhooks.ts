/**
 * Outbound webhooks — the other half of the webhook feature (see api/routes/webhooks.ts
 * for the inbound receiver). Subscribers register a URL + which of an agent's events
 * they want (cycle_completed, cycle_failed, ...); whenever notify() fires for that
 * agent with a matching type, we POST a signed payload to every enabled subscriber.
 *
 * Fire-and-forget: dispatch never blocks or throws into the caller (notify() call
 * sites are on hot paths like cycle completion) — failures are logged to the
 * delivery table for the user to see, not surfaced synchronously.
 */
import crypto from 'crypto';
import dns from 'dns';
import {
  getOutboundWebhooksFor,
  logOutboundDelivery,
  type OutboundWebhook,
} from './db.js';
import { logger } from './logger.js';
import type { NotificationType } from './db.js';

const DELIVERY_TIMEOUT_MS = 8000;

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Outbound webhook URLs are user-supplied and this server POSTs to them — without
// a check, a user could register http://169.254.169.254/... (cloud metadata) or an
// internal docker-network address (e.g. the litellm/db containers) as a "webhook"
// and use the server as an SSRF proxy into its own infrastructure.

function isDisallowedIp(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (
    ip.startsWith('127.') ||
    ip.startsWith('10.') ||
    ip.startsWith('169.254.') ||
    ip.startsWith('192.168.')
  )
    return true;
  if (ip.startsWith('172.')) {
    const second = parseInt(ip.split('.')[1] ?? '0', 10);
    if (second >= 16 && second <= 31) return true;
  }
  const lower = ip.toLowerCase();
  if (
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80')
  )
    return true; // ULA / link-local
  return false;
}

/** True if the URL is safe to register/POST to — public http(s) hostname, not resolving to a private/loopback address. */
export async function isAllowedOutboundUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local')) return false;
  // Literal IP in the URL — check directly without a DNS round-trip.
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    return !isDisallowedIp(hostname);
  }
  try {
    const results = await dns.promises.lookup(hostname, { all: true });
    return results.every((r) => !isDisallowedIp(r.address));
  } catch {
    return false; // Unresolvable hostname — refuse rather than silently accept.
  }
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

function sign(secret: string, body: string): string {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

async function deliverOne(
  webhook: OutboundWebhook,
  event: NotificationType,
  body: string,
): Promise<void> {
  const sentAt = new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-NanoCrew-Event': event,
        'X-NanoCrew-Signature-256': sign(webhook.secret, body),
      },
      body,
      signal: controller.signal,
    });
    logOutboundDelivery({
      webhook_id: webhook.id,
      agent_id: webhook.agent_id,
      event,
      sent_at: sentAt,
      status: res.ok ? 'success' : 'failed',
      status_code: res.status,
      error: res.ok ? null : `HTTP ${res.status}`,
      payload_preview: body.slice(0, 300),
    });
  } catch (err: any) {
    logOutboundDelivery({
      webhook_id: webhook.id,
      agent_id: webhook.agent_id,
      event,
      sent_at: sentAt,
      status: 'failed',
      status_code: null,
      error:
        err?.name === 'AbortError'
          ? `Timed out after ${DELIVERY_TIMEOUT_MS}ms`
          : (err?.message ?? 'Request failed'),
      payload_preview: body.slice(0, 300),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Fire every enabled subscriber for (agentId, type). Never throws — call without awaiting. */
export async function fireOutboundWebhooks(
  agentId: string | null | undefined,
  type: NotificationType,
  payload: {
    title: string;
    body: string;
    meta?: Record<string, unknown> | null;
  },
): Promise<void> {
  if (!agentId) return;
  try {
    const subscribers = getOutboundWebhooksFor(agentId, type);
    if (subscribers.length === 0) return;
    const body = JSON.stringify({
      event: type,
      agentId,
      timestamp: new Date().toISOString(),
      title: payload.title,
      body: payload.body,
      meta: payload.meta ?? null,
    });
    await Promise.all(subscribers.map((w) => deliverOne(w, type, body)));
  } catch (err) {
    logger.warn({ agentId, type, err }, 'Outbound webhook dispatch failed');
  }
}
