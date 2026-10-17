/**
 * Stage 64 phase 1 — boot wiring for owner notifications.
 *
 * Sources: every check-in (the DB hook sees all eight creation sites), escalations and
 * failed runs (both already go through notify()). Answers come back through the WhatsApp
 * inbound hook and go out through the same functions as the dashboard's buttons.
 */
import { APP_URL, TIMEZONE } from '../config.js';
import { getAgent, onCheckinCreated } from '../db.js';
import { onNotify } from '../notifications.js';
import { logger } from '../logger.js';
import { getSocketIO } from '../api/instances.js';
import { userRoom } from '../api/socket-scope.js';
import { whatsAppSessions } from '../channels/whatsapp-session.js';
import { respondToCheckin } from '../agents/checkin-respond.js';
import { resolveApproval } from '../agents/runtime/computer-use/escalation.js';
import { OwnerNotifier } from './notifier.js';
import { summarizeFailure } from './format.js';
import { routeInbound } from './whatsapp-delivery.js';
import { ownerTransport, setTelegramBot } from './transport.js';
import { TelegramBot, telegramToken } from './telegram.js';

let instance: OwnerNotifier | null = null;

export function getOwnerNotifier(): OwnerNotifier | null {
  return instance;
}

export function startOwnerNotify(): OwnerNotifier {
  if (instance) return instance;
  const notifier = new OwnerNotifier({
    transport: ownerTransport,
    answerCheckin: async (agentId, checkinId, reply) => {
      const r = await respondToCheckin(agentId, checkinId, reply);
      if (r.ok) return 'ok';
      return r.reason === 'already_responded' ? 'already' : 'not_found';
    },
    answerEscalation: (approvalId, decision) =>
      resolveApproval(approvalId, decision),
    emitDesktop: (ownerId, n) => {
      getSocketIO()?.to(userRoom(ownerId)).emit('owner:prompt', n);
    },
    link: `${APP_URL.replace(/\/$/, '')}/checkins`,
    agentLink: (agentId) => `${APP_URL.replace(/\/$/, '')}/agents/${agentId}`,
    timeZone: TIMEZONE,
  });

  onCheckinCreated((c) => notifier.enqueueCheckin(c));
  onNotify((n) => {
    const approvalId = n.meta?.approvalId;
    if (
      n.type === 'approval_required' &&
      typeof approvalId === 'string' &&
      n.agent_id
    ) {
      notifier.enqueueEscalation(approvalId, n.agent_id);
    } else if (n.type === 'cycle_failed' && n.agent_id) {
      const name = getAgent(n.agent_id)?.name ?? '';
      notifier.enqueueInfo(n.agent_id, summarizeFailure(n.title, n.body, name));
    }
  });
  whatsAppSessions.setOwnerInboundHandler((m) => routeInbound(m, notifier));

  // Telegram (stage 64 phase 1 follow-up): rings without a second phone number. Off when
  // TELEGRAM_BOT_TOKEN is unset; a failed start leaves WhatsApp delivery exactly as before.
  const token = telegramToken();
  if (token) {
    const bot = new TelegramBot(token);
    bot
      .start((ownerId, text, quotedId) =>
        notifier.handleReply(ownerId, text, quotedId),
      )
      .then(() => setTelegramBot(bot))
      .catch((err) =>
        logger.warn(
          { err: String(err) },
          'telegram: bot did not start — WhatsApp delivery only',
        ),
      );
  }
  notifier.start();
  instance = notifier;
  logger.info('owner-notify: started');
  return notifier;
}
