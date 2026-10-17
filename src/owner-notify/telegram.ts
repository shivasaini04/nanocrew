/**
 * Telegram — the owner-notification channel that rings without a second phone number.
 *
 * Stage 64 phase 1 follow-up (2026-10-01). WhatsApp delivery needs a sender number other than
 * the owner's own: a message from your account to "Message yourself" never rings, and the
 * founder has only one number. A Telegram bot is its own account, so its messages ring like
 * any chat; replies and button taps come back through the official Bot API (long polling —
 * no public webhook, no unofficial client, nothing that can get a number banned).
 *
 * Linking: the dashboard shows a one-time code. The owner sends it to the bot, or opens
 * t.me/<bot>?start=<code>, which sends "/start <code>" (the t.me page's button only works where
 * the Telegram app is installed). That chat is then bound to that owner. Messages from any other
 * chat are never read as an owner's answer.
 *
 * Token: TELEGRAM_BOT_TOKEN (process env, then the .env file). Unset → this channel is off and
 * nothing else changes.
 */
import { randomInt } from 'crypto';

import { getUserNotifyPrefs, setUserNotifyPrefs, getAllUsers } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { ButtonRows } from './notifier.js';
import { toTelegramHtml } from './format.js';

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export function telegramToken(): string {
  return (
    process.env.TELEGRAM_BOT_TOKEN ||
    readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN ||
    ''
  ).trim();
}

// ─── Link codes ─────────────────────────────────────────────────────────────────────────

const LINK_TTL_MS = 15 * 60_000;
const linkCodes = new Map<string, { ownerId: string; expiresAt: number }>();
// Typed by hand on a phone, often read off another screen, so no look-alikes (0/O, 1/I/L).
// The first codes were base64url and failed exactly that way on 2026-10-01: "l" read as "I".
// 31^8 ≈ 8.5e11 codes, each alive 15 minutes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

/** Case, spaces and dashes don't matter: "k7qm-4rxt" is "K7QM4RXT". */
export function normalizeLinkCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, '');
}

/** A one-time code that binds the next Telegram chat to present it to `ownerId`. */
export function issueLinkCode(ownerId: string, now = Date.now()): string {
  for (const [c, v] of linkCodes) if (v.expiresAt <= now) linkCodes.delete(c);
  let code = '';
  for (let i = 0; i < CODE_LEN; i++)
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  linkCodes.set(code, { ownerId, expiresAt: now + LINK_TTL_MS });
  return code;
}

/** Consume a code: the owner it was issued to, or null when unknown or expired. */
export function redeemLinkCode(raw: string, now = Date.now()): string | null {
  const code = normalizeLinkCode(raw);
  const v = linkCodes.get(code);
  linkCodes.delete(code);
  return v && v.expiresAt > now ? v.ownerId : null;
}

/** Owners whose linked Telegram chat this is. */
export function ownersForChat(chatId: string): string[] {
  return getAllUsers()
    .filter((u) => getUserNotifyPrefs(u.id).telegramChatId === chatId)
    .map((u) => u.id);
}

// ─── The bot ────────────────────────────────────────────────────────────────────────────

const PRIVATE_BOT =
  'This is a private NanoCrew bot. To connect it, open *Account → Phone notifications* on your dashboard, press *Connect Telegram*, and send the code it shows here.';
const CODE_DID_NOT_MATCH =
  'That code didn’t match. A code works once, for 15 minutes. Press *Connect Telegram* on your dashboard again and send the new code here.';

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    message?: { message_id: number; chat: { id: number } };
  };
}

/** What a message or tap means to the notifier. True = it was an answer and has been handled. */
export type OwnerAnswerHandler = (
  ownerId: string,
  text: string,
  quotedId: string | null,
) => Promise<boolean>;

export class TelegramBot {
  username: string | null = null;
  private offset = 0;
  private running = false;
  private stopped = false;

  constructor(
    private readonly token: string,
    private readonly f: Fetcher = fetch,
  ) {}

  isRunning(): boolean {
    return this.running;
  }

  private async api<T = any>(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const r = await this.f(
      `https://api.telegram.org/bot${this.token}/${method}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    const j = (await r.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!j.ok)
      throw Object.assign(
        new Error(`telegram ${method}: ${j.description ?? r.status}`),
        { code: j.error_code ?? r.status },
      );
    return j.result as T;
  }

  async sendMessage(
    chatId: string,
    text: string,
    buttons?: ButtonRows,
  ): Promise<string | null> {
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: toTelegramHtml(text).slice(0, 4096),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (buttons?.length) {
        body.reply_markup = {
          inline_keyboard: buttons.map((row) =>
            row.map((b) => ({
              text: b.label.slice(0, 60),
              callback_data: b.data.slice(0, 64),
            })),
          ),
        };
      }
      const m = await this.api<{ message_id: number }>('sendMessage', body);
      return String(m.message_id);
    } catch (err) {
      logger.warn({ err: String(err) }, 'telegram: send failed');
      return null;
    }
  }

  /**
   * Start: identify the bot, then long-poll forever. `onAnswer` receives what an owner sent
   * (typed text, or a tapped button's data) from their linked chat.
   */
  async start(onAnswer: OwnerAnswerHandler): Promise<void> {
    const me = await this.api<{ username: string }>('getMe', {});
    this.username = me.username;
    this.running = true;
    logger.info({ bot: this.username }, 'telegram: bot started');
    void this.loop(onAnswer);
  }

  stop(): void {
    this.stopped = true;
    this.running = false;
  }

  private async loop(onAnswer: OwnerAnswerHandler): Promise<void> {
    let backoff = 1000;
    while (!this.stopped) {
      try {
        const updates = await this.api<TgUpdate[]>(
          'getUpdates',
          {
            offset: this.offset,
            timeout: 50,
            allowed_updates: ['message', 'callback_query'],
          },
          65_000,
        );
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u, onAnswer).catch((err) =>
            logger.warn(
              { err: String(err) },
              'telegram: update handler failed',
            ),
          );
        }
      } catch (err) {
        // 409 = another process polls this token (a dev checkout); back off rather than fight.
        logger.warn(
          { err: String(err), code: (err as { code?: number }).code },
          'telegram: poll failed',
        );
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Exposed for tests. */
  async handle(u: TgUpdate, onAnswer: OwnerAnswerHandler): Promise<void> {
    if (u.callback_query) {
      const cq = u.callback_query;
      const chatId = cq.message ? String(cq.message.chat.id) : '';
      let handled = false;
      for (const ownerId of chatId ? ownersForChat(chatId) : []) {
        if (await onAnswer(ownerId, cq.data ?? '', null)) {
          handled = true;
          break;
        }
      }
      await this.api('answerCallbackQuery', {
        callback_query_id: cq.id,
        text: handled ? '' : 'Nothing waiting for that any more.',
      }).catch(() => {
        /* the spinner times out on its own */
      });
      if (handled && cq.message) {
        // Stop a second tap on the same buttons.
        await this.api('editMessageReplyMarkup', {
          chat_id: cq.message.chat.id,
          message_id: cq.message.message_id,
          reply_markup: { inline_keyboard: [] },
        }).catch(() => {
          /* already edited */
        });
      }
      return;
    }

    const m = u.message;
    if (!m?.text) return;
    const chatId = String(m.chat.id);
    const text = m.text.trim();

    // "/start CODE" (the t.me link, or typed), or, from a chat not yet linked, just the code.
    const owners = ownersForChat(chatId);
    const start = /^\/start(?:@\w+)?(?:\s+(.+))?$/i.exec(text);
    const bare =
      !start &&
      owners.length === 0 &&
      /^[A-Za-z0-9 -]+$/.test(text) &&
      normalizeLinkCode(text).length === CODE_LEN;
    if (start || bare) {
      const code = start ? start[1] : text;
      const ownerId = code ? redeemLinkCode(code) : null;
      if (!ownerId) {
        const reply =
          owners.length > 0 && !code
            ? '✅ This chat is already linked. Approvals and questions arrive here.'
            : code
              ? CODE_DID_NOT_MATCH
              : PRIVATE_BOT;
        await this.sendMessage(chatId, reply);
        return;
      }
      setUserNotifyPrefs(ownerId, {
        ...getUserNotifyPrefs(ownerId),
        telegramChatId: chatId,
      });
      logger.info({ ownerId }, 'telegram: chat linked to owner');
      await this.sendMessage(
        chatId,
        '✅ *Linked.* Approvals and questions from your NanoCrew agents will arrive here. Tap a button, or reply *1* / *2* / your answer.',
      );
      return;
    }

    if (owners.length === 0) {
      await this.sendMessage(chatId, PRIVATE_BOT);
      return;
    }
    const quoted = m.reply_to_message
      ? String(m.reply_to_message.message_id)
      : null;
    for (const ownerId of owners) {
      if (await onAnswer(ownerId, text, quoted)) return;
    }
    await this.sendMessage(
      chatId,
      'Nothing is waiting for an answer right now. To give an agent a task, use the dashboard.',
    );
  }
}
