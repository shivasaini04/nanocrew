/**
 * Stage 64 phase 1 — the notifier end to end against a real (in-memory) DB and a fake
 * WhatsApp. What must hold:
 *  - something a rule or a dashboard click settles before the send never reaches the phone;
 *  - a reply acts through the same answer path as the dashboard, exactly once;
 *  - the owner is never flooded: one message per window, several things become a digest.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createAgent,
  createAgentCheckin,
  createUser,
  getOpenOwnerPrompts,
  getOwnerPrompt,
  insertEscalationApproval,
  onCheckinCreated,
  setUserNotifyPrefs,
  updateAgentCheckin,
  DEFAULT_NOTIFY_PREFS,
} from '../db.js';
import type { Agent } from '../types.js';
import { OwnerNotifier, MIN_GAP_MS, type DeliveryTarget } from './notifier.js';

const OWNER = 'owner-1';
let AGENT = '';
let clock = 0;
let sent: Array<{ to: string; text: string; id: string }> = [];
let answers: Array<{ checkinId: string; reply: string }> = [];
let escalations: Array<{ id: string; decision: string }> = [];
let route: DeliveryTarget | null;

function makeNotifier(): OwnerNotifier {
  return new OwnerNotifier({
    transport: {
      resolveTarget: () => route,
      send: async (t, text) => {
        const id = `wa-${sent.length + 1}`;
        sent.push({ to: t.toJid, text, id });
        return id;
      },
    },
    answerCheckin: async (_agentId, checkinId, reply) => {
      answers.push({ checkinId, reply });
      updateAgentCheckin(checkinId, {
        status: 'responded',
        user_reply: reply,
        responded_at: new Date().toISOString(),
      });
      return 'ok';
    },
    answerEscalation: (id, decision) => {
      escalations.push({ id, decision });
      return true;
    },
    link: 'https://crew.example/checkins',
    timeZone: 'UTC',
    now: () => clock,
  });
}

function emailCheckin(to = 'jane@acme.com') {
  return createAgentCheckin({
    agent_id: AGENT,
    status: 'pending',
    report_md: 'Outreach draft',
    action_type: 'send_email',
    action_payload: JSON.stringify({ to, subject: 'Hello', body: 'Hi there' }),
  });
}

beforeEach(() => {
  _initTestDatabase();
  createUser({
    id: OWNER,
    email: 'owner@example.com',
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  AGENT = createAgent({
    name: 'Mailer',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: OWNER,
  }).id;
  // Past the settle window for anything created "now".
  clock = Date.now() + 60_000;
  sent = [];
  answers = [];
  escalations = [];
  route = {
    channel: 'whatsapp',
    sendAs: 'sender',
    toJid: '919999999999@s.whatsapp.net',
    selfChat: false,
  };
});

describe('sending', () => {
  it('one waiting email becomes one message with its code, and the prompt is marked sent', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    expect(sent).toHaveLength(1);
    const [p] = getOpenOwnerPrompts(OWNER);
    expect(p.status).toBe('sent');
    expect(p.wa_msg_id).toBe('wa-1');
    expect(sent[0].text).toContain(`· ${p.code}`);
    expect(sent[0].text).toContain('To: jane@acme.com');
  });

  it('a check-in settled before the send (rule or dashboard) never reaches the phone', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    updateAgentCheckin(c.id, {
      status: 'responded',
      user_reply: 'approve',
      responded_at: new Date().toISOString(),
    });
    await n.flush();
    expect(sent).toHaveLength(0);
    expect(getOpenOwnerPrompts(OWNER)).toHaveLength(0);
  });

  it('nothing is sent inside the settle window', async () => {
    const n = makeNotifier();
    clock = Date.now(); // created just now
    n.enqueueCheckin(emailCheckin());
    await n.flush();
    expect(sent).toHaveLength(0);
  });

  it('several at once become one digest', async () => {
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin('a@x.com'));
    n.enqueueCheckin(emailCheckin('b@x.com'));
    n.enqueueCheckin(emailCheckin('c@x.com'));
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('*3 things are waiting for you*');
  });

  it('one message per window per owner — the next waits', async () => {
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin('a@x.com'));
    await n.flush();
    n.enqueueCheckin(emailCheckin('b@x.com'));
    clock += 30_000;
    await n.flush();
    expect(sent).toHaveLength(1);
    clock += MIN_GAP_MS;
    await n.flush();
    expect(sent).toHaveLength(2);
  });

  it('an owner who switched it off gets nothing', async () => {
    setUserNotifyPrefs(OWNER, { ...DEFAULT_NOTIFY_PREFS, whatsapp: false });
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin());
    await n.flush();
    expect(sent).toHaveLength(0);
    expect(getOpenOwnerPrompts(OWNER)).toHaveLength(0);
  });

  it('no route to the owner: nothing is queued', async () => {
    route = null;
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin());
    expect(getOpenOwnerPrompts(OWNER)).toHaveLength(0);
  });

  it('a failure notice is delivered and closed — there is nothing to answer', async () => {
    const n = makeNotifier();
    n.enqueueInfo(AGENT, 'Mailer failed — model not found');
    await n.flush();
    expect(sent[0].text).toContain('Mailer failed — model not found');
    expect(getOpenOwnerPrompts(OWNER)).toHaveLength(0);
    expect(await n.handleReply(OWNER, '1', null)).toBe(false);
  });
});

describe('answering', () => {
  it('"1" approves through the check-in path, once, and is acknowledged', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    expect(await n.handleReply(OWNER, '1', null)).toBe(true);
    expect(answers).toEqual([{ checkinId: c.id, reply: 'approve' }]);
    expect(sent.at(-1)!.text).toContain('approved');
    // A second "1" has nothing left to answer.
    expect(await n.handleReply(OWNER, '1', null)).toBe(false);
    expect(answers).toHaveLength(1);
  });

  it('a code with a reason rejects with the reason', async () => {
    const n = makeNotifier();
    const c1 = emailCheckin('a@x.com');
    const c2 = emailCheckin('b@x.com');
    n.enqueueCheckin(c1);
    n.enqueueCheckin(c2);
    await n.flush();
    const p2 = getOpenOwnerPrompts(OWNER).find((p) => p.ref_id === c2.id)!;
    expect(await n.handleReply(OWNER, `${p2.code} 2 too formal`, null)).toBe(
      true,
    );
    expect(answers).toEqual([
      { checkinId: c2.id, reply: 'reject — too formal' },
    ]);
  });

  it('a bare "1" with two waiting asks for the code instead of guessing', async () => {
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin('a@x.com'));
    n.enqueueCheckin(emailCheckin('b@x.com'));
    await n.flush();
    expect(await n.handleReply(OWNER, '1', null)).toBe(true);
    expect(answers).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('Start your reply with the code');
  });

  it('a swipe-reply with free text passes the note on without approving', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    expect(await n.handleReply(OWNER, 'make it shorter', 'wa-1')).toBe(true);
    expect(answers).toEqual([{ checkinId: c.id, reply: 'make it shorter' }]);
    expect(sent.at(-1)!.text).toContain('It will reply before doing anything');
  });

  it('a note in the self-chat, long after the last message, is left alone', async () => {
    route = {
      channel: 'whatsapp',
      sendAs: 'owner-1',
      toJid: '15551234567@s.whatsapp.net',
      selfChat: true,
    };
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin());
    await n.flush();
    clock += 31 * 60_000;
    expect(await n.handleReply(OWNER, 'remember to call the bank', null)).toBe(
      false,
    );
    expect(answers).toHaveLength(0);
  });

  it('answered on the dashboard after it was sent: the reply says so and does nothing', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    updateAgentCheckin(c.id, {
      status: 'responded',
      user_reply: 'approve',
      responded_at: new Date().toISOString(),
    });
    expect(await n.handleReply(OWNER, '1', null)).toBe(true);
    expect(answers).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain('already answered');
  });

  it('the code alone re-sends the item in full, and a quote of that finds it', async () => {
    const n = makeNotifier();
    const c1 = emailCheckin('a@x.com');
    n.enqueueCheckin(c1);
    n.enqueueCheckin(emailCheckin('b@x.com'));
    await n.flush();
    const p1 = getOpenOwnerPrompts(OWNER).find((p) => p.ref_id === c1.id)!;
    expect(await n.handleReply(OWNER, p1.code, null)).toBe(true);
    const full = sent.at(-1)!;
    expect(full.text).toContain('To: a@x.com');
    expect(getOwnerPrompt(p1.id)!.wa_msg_id).toBe(full.id);
    expect(await n.handleReply(OWNER, 'yes', full.id)).toBe(true);
    expect(answers).toEqual([{ checkinId: c1.id, reply: 'approve' }]);
  });

  it('a risky step: "1" allows it through the escalation path', async () => {
    insertEscalationApproval({
      id: 'esc-1',
      agent_id: AGENT,
      run_id: 'r1',
      step: JSON.stringify({ action: 'click', target: 'Submit' }),
      timeout_ms: 1_800_000,
      created_at: new Date().toISOString(),
    });
    const n = makeNotifier();
    n.enqueueEscalation('esc-1', AGENT);
    await n.flush();
    expect(sent[0].text).toContain('click Submit');
    expect(await n.handleReply(OWNER, '1', null)).toBe(true);
    expect(escalations).toEqual([{ id: 'esc-1', decision: 'approved' }]);
  });

  it('a risky step does not take free text as a decision', async () => {
    insertEscalationApproval({
      id: 'esc-2',
      agent_id: AGENT,
      run_id: 'r1',
      step: JSON.stringify({ description: 'Pay invoice' }),
      timeout_ms: 1_800_000,
      created_at: new Date().toISOString(),
    });
    const n = makeNotifier();
    n.enqueueEscalation('esc-2', AGENT);
    await n.flush();
    const [p] = getOpenOwnerPrompts(OWNER);
    expect(await n.handleReply(OWNER, `${p.code} what is this`, null)).toBe(
      true,
    );
    expect(escalations).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain(
      'reply just *1* to allow or *2* to block',
    );
  });
});

describe('live-test follow-ups (2026-09-30)', () => {
  it('one failure notice per agent per hour, not one per failed run', async () => {
    const n = makeNotifier();
    n.enqueueInfo(AGENT, 'a run failed: timeout');
    n.enqueueInfo(AGENT, 'a run failed: timeout again');
    n.enqueueInfo(AGENT, 'a run failed: and again');
    await n.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('a run failed: timeout');
  });

  it('a failure notice links to the agent, not the check-in inbox', async () => {
    const n = new OwnerNotifier({
      transport: {
        resolveTarget: () => route,
        send: async (_t, text) => {
          sent.push({ to: '', text, id: 'x' });
          return 'x';
        },
      },
      answerCheckin: async () => 'ok',
      answerEscalation: () => true,
      link: 'https://crew.example/checkins',
      agentLink: (id) => `https://crew.example/agents/${id}`,
      timeZone: 'UTC',
      now: () => clock,
    });
    n.enqueueInfo(AGENT, 'a run failed: timeout');
    await n.flush();
    expect(sent[0].text).toContain(`https://crew.example/agents/${AGENT}`);
    expect(sent[0].text).not.toContain('/checkins');
  });

  it('answered on the dashboard after it went out: the next pass closes it', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    updateAgentCheckin(c.id, {
      status: 'responded',
      user_reply: '1. Yes',
      responded_at: new Date().toISOString(),
    });
    await n.flush();
    expect(getOpenOwnerPrompts(OWNER)).toHaveLength(0);
    expect(await n.handleReply(OWNER, '1', null)).toBe(false);
  });
});

describe('free-text answers (live test 2026-09-30)', () => {
  function questionCheckin() {
    return createAgentCheckin({
      agent_id: AGENT,
      status: 'pending',
      report_md: '## Question\n\nDid this reach your phone?',
      action_type: 'clarify_live',
      action_payload: JSON.stringify({
        awaitUntil: Date.now() + 3_600_000,
        question: 'Did this reach your phone?',
        options: [{ label: 'Yes' }, { label: 'Late' }],
      }),
    });
  }

  it('the exact live-test reply — "yes, it arrived" in the self-chat — answers the question', async () => {
    route = {
      channel: 'whatsapp',
      sendAs: 'owner-1',
      toJid: '15551234567@s.whatsapp.net',
      selfChat: true,
    };
    const n = makeNotifier();
    const c = questionCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    expect(await n.handleReply(OWNER, 'yes, it arrived', null)).toBe(true);
    expect(answers).toEqual([{ checkinId: c.id, reply: 'yes, it arrived' }]);
    expect(sent.at(-1)!.text).toContain('Sent your answer');
  });

  it('free text that opens with "yes" never approves an email — it gets a hint', async () => {
    route = {
      channel: 'whatsapp',
      sendAs: 'owner-1',
      toJid: '15551234567@s.whatsapp.net',
      selfChat: true,
    };
    const n = makeNotifier();
    n.enqueueCheckin(emailCheckin());
    await n.flush();
    const [p] = getOpenOwnerPrompts(OWNER);
    expect(await n.handleReply(OWNER, 'yes remember the milk', null)).toBe(
      true,
    );
    expect(answers).toHaveLength(0);
    expect(sent.at(-1)!.text).toContain(`reply just *1* to send`);
    expect(getOwnerPrompt(p.id)!.status).toBe('sent');
  });

  it('free text without a decision word is passed on as a note, not an approval', async () => {
    const n = makeNotifier();
    const c = emailCheckin();
    n.enqueueCheckin(c);
    await n.flush();
    expect(await n.handleReply(OWNER, 'make the subject shorter', null)).toBe(
      true,
    );
    expect(answers).toEqual([
      { checkinId: c.id, reply: 'make the subject shorter' },
    ]);
  });
});

describe('the DB hook', () => {
  it('fires for every created check-in, whoever creates it', () => {
    const seen: string[] = [];
    const off = onCheckinCreated((c) => seen.push(c.id));
    const c = emailCheckin();
    off();
    emailCheckin();
    expect(seen).toEqual([c.id]);
  });
});
