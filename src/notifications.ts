import {
  createNotification,
  type NotificationType,
  type Notification,
} from './db.js';
import { getSocketIO } from './api/instances.js';
import { fireOutboundWebhooks } from './outbound-webhooks.js';
import { logger } from './logger.js';

/**
 * Stage 64 phase 1: services that act on a notification beyond the dashboard bell — the
 * owner's WhatsApp, today. Registered once at boot; a listener must be quick and must not
 * throw into the caller, because notify() runs on hot paths (cycle completion, the
 * escalation gate).
 */
type NotifyListener = (n: Notification) => void;
const listeners: NotifyListener[] = [];
export function onNotify(fn: NotifyListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function notify(
  type: NotificationType,
  title: string,
  body: string,
  agent_id?: string | null,
  meta?: Record<string, unknown>,
): Notification {
  const n = createNotification({
    type,
    title,
    body,
    agent_id: agent_id ?? null,
    meta: meta ?? null,
  });
  const io = getSocketIO();
  io?.emit('notification:new', n);
  // Fire-and-forget — every notify() call site is on a hot path (cycle completion,
  // etc.) and must not block waiting on an external URL that may be slow or down.
  fireOutboundWebhooks(agent_id, type, { title, body, meta }).catch((err) =>
    logger.warn({ agent_id, type, err }, 'Outbound webhook dispatch threw'),
  );
  for (const fn of listeners) {
    try {
      fn(n);
    } catch (err) {
      logger.warn({ type, err }, 'notify listener threw');
    }
  }
  return n;
}
