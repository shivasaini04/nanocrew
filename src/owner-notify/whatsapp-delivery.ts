/**
 * Stage 64 phase 1 — which WhatsApp account messages the owner, and at which number.
 *
 * The obvious route — the owner's own linked session writing to its own "Message yourself"
 * chat — delivers, but a message from your own account doesn't ring your phone. The point
 * of this phase is that the owner NOTICES, so the preferred route is a separate sender
 * account (the platform's notifier number) writing to the owner's phone like any contact.
 *
 *   1. Sender account connected, and its number is not the owner's → write to the owner.
 *   2. Otherwise the owner's own session → their self-chat (silent; the UI says so).
 *   3. Otherwise the sender account IS the owner's phone → its self-chat (silent).
 *   4. Otherwise no route: the dashboard (and desktop notification) only.
 */
import { getAllUsers, getUserNotifyPrefs } from '../db.js';
import { logger } from '../logger.js';
import {
  whatsAppSessions,
  type OwnerInbound,
} from '../channels/whatsapp-session.js';
import type {
  DeliveryTarget,
  OwnerNotifier,
  OwnerTransport,
} from './notifier.js';

/**
 * The account whose linked WhatsApp sends owner notifications: OWNER_NOTIFY_SENDER_USER_ID
 * if set, else the first admin. Read on every call so a changed env or a newly linked admin
 * session takes effect without a restart of this module.
 */
export function senderUserId(): string | null {
  const fromEnv = process.env.OWNER_NOTIFY_SENDER_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  return getAllUsers().find((u) => u.role === 'admin')?.id ?? null;
}

function pnJid(digits: string): string {
  return `${digits}@s.whatsapp.net`;
}

export function digitsOf(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

export function resolveTarget(ownerId: string): DeliveryTarget | null {
  const prefs = getUserNotifyPrefs(ownerId);
  const own = whatsAppSessions.status(ownerId);
  const ownNumber = own.state === 'connected' ? own.number : null;
  const recipient = prefs.phone ?? ownNumber;

  const sender = senderUserId();
  const senderStatus = sender ? whatsAppSessions.status(sender) : null;
  const senderNumber =
    senderStatus?.state === 'connected' ? senderStatus.number : null;

  if (sender && senderNumber && recipient && senderNumber !== recipient) {
    return {
      channel: 'whatsapp',
      sendAs: sender,
      toJid: pnJid(recipient),
      selfChat: false,
    };
  }
  if (ownNumber)
    return {
      channel: 'whatsapp',
      sendAs: ownerId,
      toJid: pnJid(ownNumber),
      selfChat: true,
    };
  if (sender && senderNumber && recipient && senderNumber === recipient) {
    return {
      channel: 'whatsapp',
      sendAs: sender,
      toJid: pnJid(senderNumber),
      selfChat: true,
    };
  }
  return null;
}

export const whatsAppTransport: OwnerTransport = {
  resolveTarget,
  send: (target, text) =>
    whatsAppSessions.send(target.sendAs, target.toJid, text),
};

/**
 * Which owners could this inbound message be answering? Only the ones whose route it
 * arrived on: a DM from their phone to the sender account, or the self-chat of the session
 * their route uses. Anything else — the sender account's own typing to someone, a stranger
 * writing to the notifier number — matches no owner and passes through untouched.
 */
export function ownersForInbound(m: OwnerInbound): string[] {
  const out: string[] = [];
  for (const u of getAllUsers()) {
    const t = resolveTarget(u.id);
    if (!t || t.sendAs !== m.sessionOwnerId) continue;
    if (m.selfChat && t.selfChat) out.push(u.id);
    else if (
      !m.fromMe &&
      !t.selfChat &&
      m.phoneDigits &&
      digitsOf(t.toJid) === m.phoneDigits
    )
      out.push(u.id);
  }
  return out;
}

/** Offer an inbound message to each owner it could belong to; the first that takes it wins. */
export async function routeInbound(
  m: OwnerInbound,
  notifier: OwnerNotifier,
): Promise<boolean> {
  const owners = ownersForInbound(m);
  // Metadata only — never the text. Only messages that could be answers: the sender account
  // may be someone's personal WhatsApp, and every other DM it receives is none of our business.
  if (m.selfChat || owners.length > 0) {
    logger.info(
      {
        session: m.sessionOwnerId,
        selfChat: m.selfChat,
        fromMe: m.fromMe,
        candidates: owners.length,
        quoted: !!m.quotedId,
      },
      'owner-notify: inbound',
    );
  }
  for (const ownerId of owners) {
    if (await notifier.handleReply(ownerId, m.text, m.quotedId)) {
      logger.info({ ownerId }, 'owner-notify: answer handled');
      return true;
    }
  }
  return false;
}
