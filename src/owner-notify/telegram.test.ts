/**
 * Telegram owner channel. What must hold: only a chat that presented a fresh one-time code
 * from the owner's dashboard is ever bound to them; a button tap is the same as typing its
 * data; nothing from an unlinked chat reaches the answer path.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, createUser, getUserNotifyPrefs } from '../db.js';
import { buttonsFor, toTelegramHtml, type PromptView } from './format.js';
import {
  TelegramBot,
  issueLinkCode,
  ownersForChat,
  redeemLinkCode,
} from './telegram.js';

const OWNER = 'owner-tg';
let calls: Array<{ method: string; body: any }> = [];
let answers: Array<{ ownerId: string; text: string; quoted: string | null }> =
  [];
let answerResult = true;

function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = url.split('/').pop()!;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  calls.push({ method, body });
  const result =
    method === 'sendMessage'
      ? { message_id: 100 + calls.length }
      : method === 'getMe'
        ? { username: 'nanocrew_test_bot' }
        : true;
  return Promise.resolve(
    new Response(JSON.stringify({ ok: true, result }), { status: 200 }),
  );
}

const onAnswer = async (
  ownerId: string,
  text: string,
  quoted: string | null,
) => {
  answers.push({ ownerId, text, quoted });
  return answerResult;
};

beforeEach(() => {
  _initTestDatabase();
  createUser({
    id: OWNER,
    email: 'tg@example.com',
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  calls = [];
  answers = [];
  answerResult = true;
});

const bot = () => new TelegramBot('TOKEN', fakeFetch as typeof fetch);
const msg = (chat: number, text: string, reply?: number) => ({
  update_id: 1,
  message: {
    message_id: 7,
    chat: { id: chat },
    text,
    ...(reply ? { reply_to_message: { message_id: reply } } : {}),
  },
});

describe('linking', () => {
  it('/start with a fresh code binds that chat to the owner and confirms', async () => {
    const code = issueLinkCode(OWNER);
    await bot().handle(msg(555, `/start ${code}`), onAnswer);
    expect(getUserNotifyPrefs(OWNER).telegramChatId).toBe('555');
    expect(ownersForChat('555')).toEqual([OWNER]);
    expect(calls.at(-1)!.body.text).toContain('Linked');
  });

  it('a code works once', async () => {
    const code = issueLinkCode(OWNER);
    expect(redeemLinkCode(code)).toBe(OWNER);
    expect(redeemLinkCode(code)).toBeNull();
  });

  it('an expired code does not link', () => {
    const code = issueLinkCode(OWNER, Date.now() - 20 * 60_000);
    expect(redeemLinkCode(code)).toBeNull();
  });

  it('/start with a wrong code links nothing and says to get a new one', async () => {
    await bot().handle(msg(666, '/start not-a-code'), onAnswer);
    expect(getUserNotifyPrefs(OWNER).telegramChatId).toBeNull();
    expect(calls.at(-1)!.body.text).toContain('didn’t match');
  });

  it("a bare /start (the app's Start button, no code) says the bot is private and how to connect", async () => {
    await bot().handle(msg(666, '/start'), onAnswer);
    expect(getUserNotifyPrefs(OWNER).telegramChatId).toBeNull();
    expect(calls.at(-1)!.body.text).toContain('Connect Telegram');
  });

  // The first codes were base64url; on 2026-10-01 one was read off a screenshot with "l" as "I"
  // and the founder was told "private bot".
  it('codes are 8 characters with no look-alikes (0/O, 1/I/L)', () => {
    for (let i = 0; i < 200; i++)
      expect(issueLinkCode(OWNER)).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
  });

  it('case, spaces and dashes in a typed code do not matter', async () => {
    const code = issueLinkCode(OWNER);
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4).toLowerCase()}`;
    await bot().handle(msg(555, `/start ${typed}`), onAnswer);
    expect(getUserNotifyPrefs(OWNER).telegramChatId).toBe('555');
  });

  it('the code alone, sent from a chat not yet linked, links it', async () => {
    const code = issueLinkCode(OWNER);
    await bot().handle(
      msg(555, `${code.slice(0, 4)} ${code.slice(4)}`),
      onAnswer,
    );
    expect(getUserNotifyPrefs(OWNER).telegramChatId).toBe('555');
    expect(calls.at(-1)!.body.text).toContain('Linked');
  });

  it('ordinary text from a chat not yet linked is not taken as a code', async () => {
    await bot().handle(msg(666, 'hello there'), onAnswer);
    expect(calls.at(-1)!.body.text).toContain('private');
  });
});

describe('answers', () => {
  beforeEach(async () => {
    await bot().handle(msg(555, `/start ${issueLinkCode(OWNER)}`), onAnswer);
    calls = [];
  });

  it('typed text from the linked chat goes to the answer path, with the quoted message id', async () => {
    await bot().handle(msg(555, 'K4 1', 123), onAnswer);
    expect(answers).toEqual([{ ownerId: OWNER, text: 'K4 1', quoted: '123' }]);
  });

  it('from a linked chat, eight letters are an answer, not a link attempt', async () => {
    await bot().handle(msg(555, 'ABCD EFGH'), onAnswer);
    expect(answers).toEqual([
      { ownerId: OWNER, text: 'ABCD EFGH', quoted: null },
    ]);
  });

  it('anything from an unlinked chat never reaches the answer path', async () => {
    await bot().handle(msg(999, 'K4 1'), onAnswer);
    expect(answers).toHaveLength(0);
    expect(calls.at(-1)!.body.text).toContain('private');
  });

  it('a button tap is the same as typing its data; the buttons are then removed', async () => {
    await bot().handle(
      {
        update_id: 2,
        callback_query: {
          id: 'cq1',
          data: 'K4 2',
          message: { message_id: 50, chat: { id: 555 } },
        },
      },
      onAnswer,
    );
    expect(answers).toEqual([{ ownerId: OWNER, text: 'K4 2', quoted: null }]);
    expect(calls.map((c) => c.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
    expect(calls[1].body.reply_markup.inline_keyboard).toEqual([]);
  });

  it('a stale tap is answered but leaves the message alone', async () => {
    answerResult = false;
    await bot().handle(
      {
        update_id: 3,
        callback_query: {
          id: 'cq2',
          data: 'K4 1',
          message: { message_id: 51, chat: { id: 555 } },
        },
      },
      onAnswer,
    );
    expect(calls.map((c) => c.method)).toEqual(['answerCallbackQuery']);
    expect(calls[0].body.text).toContain('Nothing waiting');
  });
});

describe('sending', () => {
  it('HTML with escaped entities, bold, and the buttons as an inline keyboard', async () => {
    await bot().sendMessage(
      '555',
      '*Mailer* wants to email <jane@acme.com> & co',
      [[{ label: '✅ Send', data: 'K4 1' }]],
    );
    const b = calls[0].body;
    expect(b.parse_mode).toBe('HTML');
    expect(b.text).toBe(
      '<b>Mailer</b> wants to email &lt;jane@acme.com&gt; &amp; co',
    );
    expect(b.reply_markup.inline_keyboard).toEqual([
      [{ text: '✅ Send', callback_data: 'K4 1' }],
    ]);
  });
});

describe('buttonsFor', () => {
  const email: PromptView = {
    code: 'K4',
    kind: 'checkin',
    agentName: 'Mailer',
    actionType: 'send_email',
    payload: {},
    text: '',
  };
  const q: PromptView = {
    code: 'P7',
    kind: 'checkin',
    agentName: 'Finder',
    actionType: 'clarify_live',
    payload: { options: [{ label: 'YC' }, { label: 'LinkedIn' }] },
    text: '',
  };
  const risky: PromptView = {
    code: 'Q2',
    kind: 'escalation',
    agentName: 'Finder',
    actionType: null,
    payload: null,
    text: '',
  };
  const info: PromptView = {
    code: 'Z1',
    kind: 'info',
    agentName: 'Finder',
    actionType: null,
    payload: null,
    text: '',
  };

  it('a single email: Send / Skip, carrying what the owner would have typed', () => {
    expect(buttonsFor([email])).toEqual([
      [
        { label: '✅ Send', data: 'K4 1' },
        { label: '❌ Skip', data: 'K4 2' },
      ],
    ]);
  });

  it('a single question: one button per option', () => {
    expect(buttonsFor([q])).toEqual([
      [{ label: '1. YC', data: 'P7 1' }],
      [{ label: '2. LinkedIn', data: 'P7 2' }],
    ]);
  });

  it('a digest: one row per item, labelled with its code; questions are typed, notices get none', () => {
    expect(buttonsFor([email, risky, q, info])).toEqual([
      [
        { label: '✅ Send K4', data: 'K4 1' },
        { label: '❌ Skip K4', data: 'K4 2' },
      ],
      [
        { label: '✅ Allow Q2', data: 'Q2 1' },
        { label: '❌ Block Q2', data: 'Q2 2' },
      ],
    ]);
  });

  it('a notice alone has no buttons', () => {
    expect(buttonsFor([info])).toEqual([]);
  });

  it('toTelegramHtml leaves plain text alone', () => {
    expect(toTelegramHtml('reply 1 or 2')).toBe('reply 1 or 2');
  });
});
