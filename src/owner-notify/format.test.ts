/**
 * Stage 64 phase 1 — what the owner reads on WhatsApp and how their reply is read back.
 *
 * The self-chat is also the owner's notepad, so the dangerous failure is reading an
 * ordinary note as an answer and approving something nobody approved. Those cases are
 * pinned first.
 */
import { describe, it, expect } from 'vitest';

import {
  formatDigest,
  formatSingle,
  isQuietNow,
  mdToWhatsApp,
  parseOwnerReply,
  summarizeFailure,
  toCheckinReply,
  toEscalationDecision,
  type OpenPromptRef,
  type PromptView,
} from './format.js';

const email: PromptView = {
  code: 'K4',
  kind: 'checkin',
  agentName: 'Mailer',
  actionType: 'send_email',
  payload: {
    to: 'jane@acme.com',
    subject: 'Quick question',
    body: 'Hi Jane,\n\nSaw your ops role…',
  },
  text: 'Outreach draft',
};
const question: PromptView = {
  code: 'P7',
  kind: 'checkin',
  agentName: 'Finder',
  actionType: 'clarify_live',
  payload: {
    question: 'Which list?',
    options: [
      { label: 'YC', detail: 'jobs board' },
      { label: 'LinkedIn', detail: '' },
    ],
  },
  text: '## Question\n\nWhich list?',
};
const risky: PromptView = {
  code: 'Q2',
  kind: 'escalation',
  agentName: 'Finder',
  actionType: null,
  payload: { action: 'click', target: 'Submit' },
  text: 'click Submit',
};

function ref(
  p: Partial<OpenPromptRef> & { id: string; code: string },
): OpenPromptRef {
  return {
    kind: 'checkin',
    actionType: null,
    waMsgId: 'm1',
    sentAt: null,
    ...p,
  };
}

const NOW = Date.parse('2026-09-30T12:30:00Z');
const SELF = { dedicated: false, now: NOW };
const DEDICATED = { dedicated: true, now: NOW };

describe('parseOwnerReply — never mistakes a note for an answer', () => {
  const one = [ref({ id: 'a', code: 'K4' })];

  it('free text without a quote or code is not an answer, even with one thing waiting', () => {
    expect(parseOwnerReply('buy milk tomorrow', null, one)).toBeNull();
    expect(parseOwnerReply('yes I should call mom', null, one)).toBeNull();
  });

  it('an @mention is a new task, never an answer', () => {
    expect(parseOwnerReply('@Finder 1', null, one)).toBeNull();
  });

  it('a quote of a message we did not send is not an answer', () => {
    expect(
      parseOwnerReply('1', { waMsgId: 'other', isOurs: false }, one),
    ).toBeNull();
  });

  it('a code that is not open does not match', () => {
    expect(parseOwnerReply('Z9 1', null, one)).toBeNull();
  });

  it('nothing waiting: a bare 1 is not an answer', () => {
    expect(parseOwnerReply('1', null, [])).toBeNull();
  });
});

describe('parseOwnerReply — the ways an owner answers', () => {
  it('a bare decision with exactly one thing waiting', () => {
    const open = [ref({ id: 'a', code: 'K4' })];
    expect(parseOwnerReply('1', null, open)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: '1',
      via: 'bare',
    });
    expect(parseOwnerReply(' no ', null, open)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: 'no',
      via: 'bare',
    });
    expect(parseOwnerReply('1, 3', null, open)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: '1, 3',
      via: 'bare',
    });
  });

  it('a bare decision with several waiting is ambiguous, not a guess', () => {
    const open = [ref({ id: 'a', code: 'K4' }), ref({ id: 'b', code: 'P7' })];
    expect(parseOwnerReply('1', null, open)).toEqual({
      type: 'ambiguous',
      codes: ['K4', 'P7'],
    });
  });

  it('a code prefix, any case, with or without punctuation', () => {
    const open = [ref({ id: 'a', code: 'K4' }), ref({ id: 'b', code: 'P7' })];
    expect(parseOwnerReply('p7 2 too formal', null, open)).toEqual({
      type: 'answer',
      promptId: 'b',
      answer: '2 too formal',
      via: 'code',
    });
    expect(parseOwnerReply('K4: shorter please', null, open)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: 'shorter please',
      via: 'code',
    });
  });

  it('the code alone asks to see it in full', () => {
    const open = [ref({ id: 'a', code: 'K4' })];
    expect(parseOwnerReply('K4', null, open)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: '',
      via: 'code',
    });
  });

  it('a quoted single-prompt message takes free text', () => {
    const open = [ref({ id: 'a', code: 'K4', waMsgId: 'w1' })];
    expect(
      parseOwnerReply('make it shorter', { waMsgId: 'w1', isOurs: true }, open),
    ).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: 'make it shorter',
      via: 'quote',
    });
  });

  it('a quoted digest needs a code', () => {
    const open = [
      ref({ id: 'a', code: 'K4', waMsgId: 'd' }),
      ref({ id: 'b', code: 'P7', waMsgId: 'd' }),
    ];
    expect(parseOwnerReply('1', { waMsgId: 'd', isOurs: true }, open)).toEqual({
      type: 'ambiguous',
      codes: ['K4', 'P7'],
    });
    expect(
      parseOwnerReply('P7 1', { waMsgId: 'd', isOurs: true }, open),
    ).toEqual({ type: 'answer', promptId: 'b', answer: '1', via: 'code' });
  });

  it('a quote of ours whose prompts are settled is reported as stale', () => {
    expect(parseOwnerReply('1', { waMsgId: 'old', isOurs: true }, [])).toEqual({
      type: 'stale',
    });
  });
});

describe('parseOwnerReply — free text (live test 2026-09-30: "yes, it arrived" was dropped)', () => {
  const recent = [ref({ id: 'a', code: 'Q5', sentAt: NOW - 5 * 60_000 })];
  const old = [ref({ id: 'a', code: 'Q5', sentAt: NOW - 3 * 60 * 60_000 })];

  it('answers the one thing waiting when it arrived recently', () => {
    expect(parseOwnerReply('yes, it arrived', null, recent, SELF)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: 'yes, it arrived',
      via: 'text',
    });
  });

  it('in a self-chat, an old prompt does not claim a later note', () => {
    expect(parseOwnerReply('buy milk tomorrow', null, old, SELF)).toBeNull();
  });

  it('in a dedicated chat, free text always answers the one thing waiting', () => {
    expect(parseOwnerReply('make it shorter', null, old, DEDICATED)).toEqual({
      type: 'answer',
      promptId: 'a',
      answer: 'make it shorter',
      via: 'text',
    });
  });

  it('in a dedicated chat with several waiting, free text asks for the code', () => {
    const two = [ref({ id: 'a', code: 'Q5' }), ref({ id: 'b', code: 'K4' })];
    expect(parseOwnerReply('make it shorter', null, two, DEDICATED)).toEqual({
      type: 'ambiguous',
      codes: ['Q5', 'K4'],
    });
    expect(parseOwnerReply('make it shorter', null, two, SELF)).toBeNull();
  });
});

describe('toCheckinReply — lands the same as a dashboard button', () => {
  it('approve / reject words become the words the check-in path acts on', () => {
    expect(toCheckinReply(email, '1')).toBe('approve');
    expect(toCheckinReply(email, 'yes')).toBe('approve');
    expect(toCheckinReply(email, '2')).toBe('reject');
    expect(toCheckinReply(email, '2 too formal')).toBe('reject — too formal');
    expect(toCheckinReply(email, 'skip')).toBe('reject');
  });

  it('batch approvals only act on a reply starting with "approve" — so 1 must become that', () => {
    const batch = { kind: 'checkin' as const, actionType: 'batch_send_live' };
    expect(toCheckinReply(batch, '1').startsWith('approve')).toBe(true);
  });

  it('free text passes through as a comment', () => {
    expect(toCheckinReply(email, 'make the subject shorter')).toBe(
      'make the subject shorter',
    );
  });

  it('a question gets exactly what was typed — the asking cycle reads option numbers itself', () => {
    expect(toCheckinReply(question, '1')).toBe('1');
    expect(toCheckinReply(question, 'use both')).toBe('use both');
  });
});

describe('toEscalationDecision', () => {
  it('only yes or no', () => {
    expect(toEscalationDecision('1')).toBe('approved');
    expect(toEscalationDecision('allow')).toBe('approved');
    expect(toEscalationDecision('2')).toBe('denied');
    expect(toEscalationDecision('block it')).toBe('denied');
    expect(toEscalationDecision('what is this?')).toBeNull();
  });
});

describe('formatting', () => {
  it('an email shows who, to, subject, body, the code and how to answer', () => {
    const t = formatSingle(email, 'https://crew.example/checkins');
    expect(t).toContain('*Mailer* wants to send an email · K4');
    expect(t).toContain('To: jane@acme.com');
    expect(t).toContain('Subject: Quick question');
    expect(t).toContain('Saw your ops role');
    expect(t).toContain('Reply *1* to send · *2* to skip');
    expect(t).toContain('https://crew.example/checkins');
  });

  it('a long body is clipped', () => {
    const t = formatSingle(
      { ...email, payload: { ...email.payload, body: 'x'.repeat(2000) } },
      null,
    );
    expect(t.length).toBeLessThan(900);
    expect(t).toContain('…');
  });

  it('a question lists its options by number', () => {
    const t = formatSingle(question, null);
    expect(t).toContain('Which list?');
    expect(t).toContain('1. YC — jobs board');
    expect(t).toContain('2. LinkedIn');
    expect(t).toContain('Reply with a number');
  });

  it('a risky step says allow or block', () => {
    expect(formatSingle(risky, null)).toContain(
      'Reply *1* to allow · *2* to block',
    );
  });

  it('a digest lists each item with its code, and notices separately', () => {
    const info: PromptView = {
      code: 'Z2',
      kind: 'info',
      agentName: 'Finder',
      actionType: null,
      payload: null,
      text: 'Finder failed — timeout',
    };
    const t = formatDigest([email, question, info], null);
    expect(t).toContain('*2 things are waiting for you*');
    expect(t).toContain('*K4* · Mailer wants to email jane@acme.com');
    expect(t).toContain('*P7* · Finder asks: Which list?');
    expect(t).toContain('*Also:*');
    expect(t).not.toContain('*Z2*');
  });

  it('dashboard markdown becomes WhatsApp markdown', () => {
    expect(
      mdToWhatsApp('## Question\n\n**Where I got to:** page 2 `code`'),
    ).toBe('*Question*\n\n*Where I got to:* page 2 code');
  });
});

describe('summarizeFailure — the notice the founder got on 2026-09-30', () => {
  it('drops the repeated name and the JSON, keeps the provider and its message', () => {
    const body =
      'Agent execution failed: litellm.BadRequestError: GroqException - {"error":{"message":"\'messages.4\' : for \'role:assistant\' the following must be satisfied[(\'messages.4\' : property \'reasoning_content\' is unsupported)]","type":"invalid_request_error"}}\n';
    const s = summarizeFailure(
      'Benchmark (stage 57) failed',
      body,
      'Benchmark (stage 57)',
    );
    expect(s.startsWith('a run failed: GroqException:')).toBe(true);
    expect(s).toContain("property 'reasoning_content' is unsupported");
    expect(s).not.toContain('{');
    expect(s).not.toContain('Benchmark (stage 57)');
    expect(s).not.toContain('litellm.');
  });

  it('an interrupted run says so', () => {
    expect(
      summarizeFailure(
        'Finder interrupted',
        'Orchestrator restarted mid-cycle',
        'Finder',
      ),
    ).toBe('a run was interrupted: Orchestrator restarted mid-cycle');
  });

  it('a plain message passes through, clipped', () => {
    const s = summarizeFailure('Finder failed', 'x'.repeat(500), 'Finder');
    expect(s.length).toBeLessThan(200);
  });
});

describe('isQuietNow', () => {
  const tz = 'Asia/Kolkata';
  // 2026-09-30T17:00Z = 22:30 IST; 02:30Z = 08:00 IST
  it('inside a window that wraps midnight', () => {
    expect(
      isQuietNow(
        { quietStart: '22:00', quietEnd: '08:00' },
        new Date('2026-09-30T17:00:00Z'),
        tz,
      ),
    ).toBe(true);
  });
  it('at the end of the window it is no longer quiet', () => {
    expect(
      isQuietNow(
        { quietStart: '22:00', quietEnd: '08:00' },
        new Date('2026-10-01T02:30:00Z'),
        tz,
      ),
    ).toBe(false);
  });
  it('a same-day window', () => {
    expect(
      isQuietNow(
        { quietStart: '13:00', quietEnd: '14:00' },
        new Date('2026-09-30T07:45:00Z'),
        tz,
      ),
    ).toBe(true); // 13:15 IST
  });
  it('unset or invalid means never quiet', () => {
    expect(
      isQuietNow({ quietStart: null, quietEnd: '08:00' }, new Date(), tz),
    ).toBe(false);
    expect(
      isQuietNow({ quietStart: '25:00', quietEnd: '08:00' }, new Date(), tz),
    ).toBe(false);
  });
});
