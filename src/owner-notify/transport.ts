/**
 * Which channel reaches an owner: Telegram when they linked it and the bot is running (it
 * rings, and answers are a tap), else WhatsApp (whatsapp-delivery.ts). Answers are accepted
 * from either — an open prompt belongs to the owner, not to the channel it went out on.
 */
import { getUserNotifyPrefs } from '../db.js';
import { whatsAppSessions } from '../channels/whatsapp-session.js';
import type { DeliveryTarget, OwnerTransport } from './notifier.js';
import type { TelegramBot } from './telegram.js';
import { resolveTarget as resolveWhatsApp } from './whatsapp-delivery.js';

let bot: TelegramBot | null = null;

export function setTelegramBot(b: TelegramBot | null): void {
  bot = b;
}

export function getTelegramBot(): TelegramBot | null {
  return bot;
}

export function resolveTarget(ownerId: string): DeliveryTarget | null {
  const chat = getUserNotifyPrefs(ownerId).telegramChatId;
  if (bot?.isRunning() && chat)
    return {
      channel: 'telegram',
      sendAs: 'telegram',
      toJid: chat,
      selfChat: false,
    };
  return resolveWhatsApp(ownerId);
}

export const ownerTransport: OwnerTransport = {
  resolveTarget,
  send: async (target, text, buttons) => {
    if (target.channel === 'telegram')
      return bot ? bot.sendMessage(target.toJid, text, buttons) : null;
    return whatsAppSessions.send(target.sendAs, target.toJid, text);
  },
};
