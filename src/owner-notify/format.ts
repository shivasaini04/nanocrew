/**
 * Stage 64 phase 1 — what the owner reads on WhatsApp, and how their reply is read back.
 *
 * Pure: no DB, no socket, no clock except what is passed in. Everything a person sees or
 * types passes through here, so this is the part worth pinning with tests.
 */

export type PromptKind = 'checkin' | 'escalation' | 'info';

/** What the formatter needs to know about one waiting thing. */
export interface PromptView {
  code: string;
  kind: PromptKind;
  agentName: string;
  /** agent_checkins.action_type for a check-in; null otherwise. */
  actionType: string | null;
  /** Parsed action_payload (check-in) or step (escalation). */
  payload: Record<string, unknown> | null;
  /** report_md (check-in), step description (escalation), or the notice text (info). */
  text: string;
}

const BODY_PREVIEW = 600;
const DIGEST_PREVIEW = 90;
export const DIGEST_MAX_ITEMS = 10;

/** The dashboard's markdown → WhatsApp's: **bold** → *bold*, headings to bold lines. */
export function mdToWhatsApp(md: string): string {
  return md
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s*(.+)$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n).trimEnd()}…` : t;
}

function oneLine(s: string, n: number): string {
  return clip(s.replace(/\s+/g, ' '), n);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Is this check-in a question (answered with words or an option number)? */
export function isQuestion(
  p: Pick<PromptView, 'kind' | 'actionType'>,
): boolean {
  return p.kind === 'checkin' && p.actionType === 'clarify_live';
}

/** One line for a digest: what is waiting, without the full body. */
export function summaryLine(p: PromptView): string {
  const who = p.agentName;
  if (p.kind === 'escalation')
    return `${who} wants to do a risky step: ${oneLine(p.text, DIGEST_PREVIEW)}`;
  if (p.kind === 'info') return `${who}: ${oneLine(p.text, DIGEST_PREVIEW)}`;
  const pl = p.payload ?? {};
  switch (p.actionType) {
    case 'send_email': {
      const to = str(pl.to);
      const subject = str(pl.subject);
      return `${who} wants to email ${to || 'someone'}${subject ? ` — "${oneLine(subject, 60)}"` : ''}`;
    }
    case 'clarify_live':
      return `${who} asks: ${oneLine(str(pl.question) || p.text, DIGEST_PREVIEW)}`;
    case 'batch_send_live': {
      const n = Array.isArray(pl.items) ? pl.items.length : 0;
      return `${who} wants to send ${n} message${n === 1 ? '' : 's'} on ${str(pl.site) || 'a site'}`;
    }
    case 'create_agent':
      return `${who} wants to hire a new agent`;
    default:
      return `${who} needs your OK: ${oneLine(mdToWhatsApp(p.text).replace(/\*/g, ''), DIGEST_PREVIEW)}`;
  }
}

/** How to answer this one, in the owner's words. */
function howToAnswer(p: PromptView): string {
  if (p.kind === 'escalation') return 'Reply *1* to allow · *2* to block';
  if (isQuestion(p)) {
    const options = Array.isArray(p.payload?.options)
      ? (p.payload!.options as unknown[])
      : [];
    return options.length
      ? 'Reply with a number, or write your answer'
      : 'Reply with your answer';
  }
  if (p.actionType === 'send_email')
    return 'Reply *1* to send · *2* to skip · or write what to change';
  return 'Reply *1* to approve · *2* to reject · or write a reply';
}

/** The full message for one waiting thing. */
export function formatSingle(p: PromptView, link: string | null): string {
  const lines: string[] = [];
  const who = `*${p.agentName}*`;
  const pl = p.payload ?? {};

  if (p.kind === 'info') {
    lines.push(`⛔ ${who} — ${clip(p.text, 400)}`);
    if (link) lines.push('', link);
    return lines.join('\n');
  }

  if (p.kind === 'escalation') {
    lines.push(
      `⚠️ ${who} wants to do a risky step · ${p.code}`,
      '',
      clip(p.text, BODY_PREVIEW),
    );
  } else if (p.actionType === 'send_email') {
    lines.push(`✉️ ${who} wants to send an email · ${p.code}`);
    if (str(pl.to)) lines.push(`To: ${str(pl.to)}`);
    if (str(pl.subject)) lines.push(`Subject: ${str(pl.subject)}`);
    const body = str(pl.body);
    if (body) lines.push('', clip(body, BODY_PREVIEW));
  } else if (isQuestion(p)) {
    lines.push(
      `❓ ${who} has a question · ${p.code}`,
      '',
      clip(str(pl.question) || mdToWhatsApp(p.text), BODY_PREVIEW),
    );
    const options = Array.isArray(pl.options)
      ? (pl.options as Array<Record<string, unknown>>)
      : [];
    if (options.length) {
      lines.push('');
      options.forEach((o, i) => {
        const detail = str(o.detail);
        lines.push(`${i + 1}. ${str(o.label)}${detail ? ` — ${detail}` : ''}`);
      });
    }
  } else if (p.actionType === 'batch_send_live') {
    const items = Array.isArray(pl.items)
      ? (pl.items as Array<Record<string, unknown>>)
      : [];
    lines.push(
      `📨 ${who} wants to send ${items.length} message${items.length === 1 ? '' : 's'} on ${str(pl.site) || 'a site'} · ${p.code}`,
      '',
    );
    for (const it of items.slice(0, 8))
      lines.push(
        `• ${str(it.to)}${str(it.text) ? `: ${oneLine(str(it.text), 80)}` : ''}`,
      );
    if (items.length > 8) lines.push(`…and ${items.length - 8} more`);
  } else {
    lines.push(
      `📋 ${who} needs your OK · ${p.code}`,
      '',
      clip(mdToWhatsApp(p.text), BODY_PREVIEW),
    );
  }

  lines.push('', howToAnswer(p));
  if (link) lines.push(link);
  return lines.join('\n');
}

/** Several waiting things in one message, each answerable by its code. */
export function formatDigest(
  prompts: PromptView[],
  link: string | null,
): string {
  const answerable = prompts.filter((p) => p.kind !== 'info');
  const notices = prompts.filter((p) => p.kind === 'info');
  const lines: string[] = [];

  if (answerable.length) {
    lines.push(
      `*${answerable.length} thing${answerable.length === 1 ? ' is' : 's are'} waiting for you*`,
      '',
    );
    for (const p of answerable.slice(0, DIGEST_MAX_ITEMS))
      lines.push(`*${p.code}* · ${summaryLine(p)}`);
    if (answerable.length > DIGEST_MAX_ITEMS)
      lines.push(
        `…and ${answerable.length - DIGEST_MAX_ITEMS} more on the dashboard`,
      );
    lines.push(
      '',
      'Reply with the code and your answer, e.g. *' +
        answerable[0].code +
        ' 1*.',
      'Send just the code to see it in full.',
    );
  }
  if (notices.length) {
    if (lines.length) lines.push('');
    lines.push('*Also:*');
    for (const p of notices.slice(0, DIGEST_MAX_ITEMS))
      lines.push(`⛔ ${summaryLine(p)}`);
  }
  if (link) lines.push('', link);
  return lines.join('\n');
}

/**
 * A failed-run notice a person can read on a phone. The raw one (live test 2026-09-30) was
 * "Benchmark (stage 57) failed — Agent execution failed: litellm.BadRequestError:
 * GroqException - {"error":{"message":"…"}}": the agent's name twice, then a JSON blob.
 * Keeps the provider name and the provider's own message, drops the wrapping.
 */
export function summarizeFailure(
  title: string,
  body: string,
  agentName: string,
): string {
  const interrupted = /\binterrupted\b/i.test(title);
  let reason = (body ?? '')
    .split('\n')[0]
    .replace(/^Agent execution failed:\s*/i, '')
    .replace(/^Agent container exited with code \d+:\s*/i, '')
    .replace(/\blitellm\.(exceptions\.)?\w+Error:\s*/g, '')
    .trim();
  // "GroqException - {json}" → "GroqException: <error.message>"
  const json = reason.match(/\{[\s\S]*\}/);
  if (json) {
    try {
      const parsed = JSON.parse(json[0]) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      const msg =
        typeof parsed.error === 'object' &&
        parsed.error &&
        typeof parsed.error.message === 'string'
          ? parsed.error.message
          : typeof parsed.error === 'string'
            ? parsed.error
            : typeof parsed.message === 'string'
              ? parsed.message
              : null;
      if (msg)
        reason =
          `${reason.slice(0, json.index).replace(/[\s\-—:]+$/, '')}: ${msg}`.replace(
            /^: /,
            '',
          );
    } catch {
      /* not JSON after all — keep the text */
    }
  }
  reason = reason
    .replace(
      new RegExp(
        `^${agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`,
        'i',
      ),
      '',
    )
    .trim();
  return `${interrupted ? 'a run was interrupted' : 'a run failed'}${reason ? `: ${clip(reason.replace(/\s+/g, ' '), 180)}` : ''}`;
}

// ─── Tap-to-answer buttons (Telegram) ───────────────────────────────────────────────────

const BUTTON_ITEMS_MAX = 8;

/**
 * Buttons for a message: one row per waiting thing. A button's `data` is exactly what the
 * owner could have typed ("K4 1"), so a tap goes through the same parser and the same answer
 * path as a typed reply — nothing about answering is button-specific.
 */
export function buttonsFor(
  views: PromptView[],
): Array<Array<{ label: string; data: string }>> {
  const answerable = views
    .filter((v) => v.kind !== 'info')
    .slice(0, BUTTON_ITEMS_MAX);
  const single = answerable.length === 1 && views.length === 1;
  const rows: Array<Array<{ label: string; data: string }>> = [];
  for (const v of answerable) {
    const tag = single ? '' : ` ${v.code}`;
    if (v.kind === 'escalation') {
      rows.push([
        { label: `✅ Allow${tag}`, data: `${v.code} 1` },
        { label: `❌ Block${tag}`, data: `${v.code} 2` },
      ]);
    } else if (isQuestion(v)) {
      // Options only as buttons on a single question: a digest of several questions
      // would be a wall of buttons — there the owner types "K4 2".
      const options = Array.isArray(v.payload?.options)
        ? (v.payload!.options as Array<Record<string, unknown>>)
        : [];
      if (single) {
        options.slice(0, BUTTON_ITEMS_MAX).forEach((o, i) => {
          rows.push([
            {
              label: `${i + 1}. ${oneLine(str(o.label), 40)}`,
              data: `${v.code} ${i + 1}`,
            },
          ]);
        });
      }
    } else if (v.actionType === 'send_email') {
      rows.push([
        { label: `✅ Send${tag}`, data: `${v.code} 1` },
        { label: `❌ Skip${tag}`, data: `${v.code} 2` },
      ]);
    } else {
      rows.push([
        { label: `✅ Approve${tag}`, data: `${v.code} 1` },
        { label: `❌ Reject${tag}`, data: `${v.code} 2` },
      ]);
    }
  }
  return rows;
}

/**
 * The WhatsApp-flavoured text above, as Telegram HTML: entities escaped, *bold* → <b>.
 * HTML rather than MarkdownV2, whose dozen reserved characters turn an email body into a
 * send error.
 */
export function toTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

// ─── Reading the owner's reply ──────────────────────────────────────────────────────────

export interface OpenPromptRef {
  id: string;
  code: string;
  kind: PromptKind;
  actionType: string | null;
  waMsgId: string | null;
  /** When it was sent (ms). Free text only answers something recent in a self-chat. */
  sentAt: number | null;
}

/**
 * How the answer was tied to its prompt. 'text' — free text with nothing tying it — is the
 * loosest, so an approval never fires from it (see OwnerNotifier.handleReply).
 */
export type AnswerVia = 'code' | 'quote' | 'bare' | 'text';

export type ParsedReply =
  /** An answer to one prompt. `answer` is what follows the code, trimmed; '' = code alone. */
  | { type: 'answer'; promptId: string; answer: string; via: AnswerVia }
  /** Decision-shaped, but it could mean more than one waiting thing. */
  | { type: 'ambiguous'; codes: string[] }
  /** Quoted a message that is no longer open. */
  | { type: 'stale' };

const APPROVE_WORDS = new Set([
  '1',
  'approve',
  'approved',
  'yes',
  'y',
  'send',
  'ok',
  'okay',
  'go',
  'allow',
  'accept',
  'lgtm',
]);
const REJECT_WORDS = new Set([
  '2',
  'reject',
  'rejected',
  'no',
  'n',
  'skip',
  'deny',
  'block',
  'cancel',
  'stop',
  'decline',
]);

function firstWord(s: string): string {
  return (
    s
      .trim()
      .toLowerCase()
      .split(/[\s,:.;—–-]+/)[0] ?? ''
  );
}

/** A reply that is only a decision or option number(s) — safe to read without a quote. */
function isBareDecision(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^\d+(\s*,\s*\d+)*$/.test(t)) return true;
  return APPROVE_WORDS.has(t) || REJECT_WORDS.has(t);
}

/** In a self-chat, free text answers a lone waiting prompt only this soon after it arrived. */
export const FREE_TEXT_WINDOW_MS = 30 * 60_000;

/**
 * Work out which prompt, if any, a message answers. Null means "not a reply" — the message
 * goes on to the normal @mention handling untouched.
 *
 * - A code prefix or a quote ties any text to its prompt.
 * - A bare decision ("1", "no", "2, 3") answers the one thing waiting.
 * - Free text answers the one thing waiting too. In a dedicated chat (a separate notifier
 *   number) everything typed there is meant for us. In the owner's self-chat — also their
 *   notepad — only when that thing arrived in the last 30 minutes. The first live test
 *   (2026-09-30) answered a question with "yes, it arrived", as the message invited, and
 *   the stricter first version dropped it silently.
 */
export function parseOwnerReply(
  text: string,
  quote: { waMsgId: string; isOurs: boolean } | null,
  open: OpenPromptRef[],
  opts: { dedicated: boolean; now: number } = {
    dedicated: false,
    now: Date.now(),
  },
): ParsedReply | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  // An @mention is a new task for an agent, never an answer.
  if (raw.startsWith('@')) return null;

  const answerable = open.filter((p) => p.kind !== 'info');

  // 1. Code prefix: "K4", "K4 1", "k4: too formal".
  const m = raw.match(
    /^([A-Za-z]\d{1,2})(?=$|[\s,:.;—–-])[\s,:.;—–-]*([\s\S]*)$/,
  );
  if (m) {
    const code = m[1].toUpperCase();
    const hit = answerable.find((p) => p.code === code);
    if (hit)
      return {
        type: 'answer',
        promptId: hit.id,
        answer: m[2].trim(),
        via: 'code',
      };
  }

  // 2. A quoted message. A quote of anything we didn't send is not an answer.
  if (quote) {
    if (!quote.isOurs) return null;
    const quoted = answerable.filter((p) => p.waMsgId === quote.waMsgId);
    if (quoted.length === 1)
      return {
        type: 'answer',
        promptId: quoted[0].id,
        answer: raw,
        via: 'quote',
      };
    if (quoted.length > 1)
      return { type: 'ambiguous', codes: quoted.map((p) => p.code) };
    // Ours, but everything it asked is settled — say so rather than look ignored.
    return { type: 'stale' };
  }

  // 3. A bare decision with nothing to tie it to.
  if (isBareDecision(raw)) {
    if (answerable.length === 1)
      return {
        type: 'answer',
        promptId: answerable[0].id,
        answer: raw,
        via: 'bare',
      };
    if (answerable.length > 1)
      return { type: 'ambiguous', codes: answerable.map((p) => p.code) };
    return null;
  }

  // 4. Free text.
  if (answerable.length === 1) {
    const p = answerable[0];
    const recent =
      p.sentAt !== null && opts.now - p.sentAt < FREE_TEXT_WINDOW_MS;
    if (opts.dedicated || recent)
      return { type: 'answer', promptId: p.id, answer: raw, via: 'text' };
    return null;
  }
  if (answerable.length > 1 && opts.dedicated)
    return { type: 'ambiguous', codes: answerable.map((p) => p.code) };
  return null;
}

/** Does the text open with a yes/no word ("yes, it arrived", "no thanks")? */
export function startsWithDecisionWord(text: string): boolean {
  const w = firstWord(text);
  return APPROVE_WORDS.has(w) || REJECT_WORDS.has(w);
}

/**
 * Turn the owner's answer into what the check-in path expects. Questions get the words as
 * typed (the asking cycle reads option numbers itself); approvals get a leading
 * 'approve' / 'reject' the way the dashboard buttons send them, so "1" and "yes" and
 * "2 too formal" all land the same as a button press — batch approvals only act on a reply
 * that starts with "approve".
 */
export function toCheckinReply(
  p: Pick<PromptView, 'kind' | 'actionType'>,
  answer: string,
): string {
  const a = answer.trim();
  if (isQuestion(p)) return a;
  const w = firstWord(a);
  const rest = a.replace(/^\S+[\s,:.;—–-]*/, '').trim();
  if (APPROVE_WORDS.has(w)) return rest ? `approve — ${rest}` : 'approve';
  if (REJECT_WORDS.has(w)) return rest ? `reject — ${rest}` : 'reject';
  return a;
}

/** An escalation takes only yes or no. Null = the answer was neither. */
export function toEscalationDecision(
  answer: string,
): 'approved' | 'denied' | null {
  const w = firstWord(answer);
  if (APPROVE_WORDS.has(w)) return 'approved';
  if (REJECT_WORDS.has(w)) return 'denied';
  return null;
}

// ─── Quiet hours ────────────────────────────────────────────────────────────────────────

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]),
    min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** True inside [start, end) in `timeZone`. A range may wrap midnight (22:00–08:00). */
export function isQuietNow(
  prefs: { quietStart: string | null; quietEnd: string | null },
  now: Date,
  timeZone: string,
): boolean {
  if (!prefs.quietStart || !prefs.quietEnd) return false;
  const start = toMinutes(prefs.quietStart);
  const end = toMinutes(prefs.quietEnd);
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find((x) => x.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((x) => x.type === 'minute')?.value ?? 0);
  const cur = h * 60 + m;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function isValidHhmm(s: unknown): boolean {
  return typeof s === 'string' && toMinutes(s) !== null;
}
