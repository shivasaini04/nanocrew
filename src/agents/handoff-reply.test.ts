/**
 * Stage 56 phase 1 — a handoff can be answered.
 *
 * The measured failure this replaces: `agent_handoffs` had no result column, so 347 of
 * 349 rows read `acknowledged` — a status written by ANY cycle the recipient ran — and
 * exactly one had a `completed_at`. Finder sent 327 handoffs and every one of them looked
 * successful. Meanwhile the agents invented `ack_received` inside the JSON payload to
 * reply to each other, because there was no field for it.
 *
 * So these tests are about the properties that make silence impossible rather than the
 * mechanics of an insert:
 *
 *   - an answer reaches the sender through the delivery path that already works
 *   - `seen` can never be mistaken for an answer, in the data or in the report
 *   - the send-gate that stalled Mailer for 33 hours cannot be armed by a reply
 *   - `cannot` names a capability, and that name is queryable as a backlog
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertAgent,
  createHandoff,
  replyToHandoff,
  getHandoffById,
  getPendingHandoffsByAgent,
  getUnansweredRequestsByAgent,
  getHandoffOutcomes,
  getCannotReasons,
  createAgentCycle,
  updateHandoffStatus,
  getAgentSelfReport,
  getOpenMessagesForAgent,
} from '../db.js';
import { renderSelfReport } from './self-report.js';
import type { AgentConfig } from '../types.js';

const FINDER = 'agent-scout';
const MAILER = 'agent-herald';

function agent(id: string, name: string) {
  insertAgent({
    id,
    name,
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: '2026-08-01T00:00:00.000Z',
    owner_id: 'me',
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'g',
      escalationRules: [],
    } as AgentConfig,
  });
}

/** Finder hands Mailer a batch of leads — the exact shape that went unanswered 84 times. */
function handLeadsOver(note = '28 qualified leads') {
  return createHandoff({
    from_agent_id: FINDER,
    to_agent_id: MAILER,
    type: 'leads',
    payload: JSON.stringify({ batch: 'batch-197', count: 28 }),
    note,
    status: 'pending',
    performative: 'request',
  });
}

beforeEach(() => {
  _initTestDatabase();
  agent(FINDER, 'Finder');
  agent(MAILER, 'Mailer');
});

describe('answering a handoff', () => {
  it('delivers the answer to the sender as a message of its own', () => {
    const h = handLeadsOver();
    // Finder has nothing waiting on it before the reply.
    expect(getPendingHandoffsByAgent(FINDER)).toHaveLength(0);

    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24, 4 bounced.',
    });

    // A reply is a ROW addressed to the original sender, which is what lets it ride the
    // inbox path that already works instead of needing a second surfacing mechanism.
    const inbox = getPendingHandoffsByAgent(FINDER);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].reply_to).toBe(h.id);
    expect(inbox[0].from_agent_id).toBe(MAILER);
    expect(JSON.parse(inbox[0].payload).result).toBe('Sent 24, 4 bounced.');
  });

  it('stamps the message it answers, so the sender need not join to find out', () => {
    const h = handLeadsOver();
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });

    const parent = getHandoffById(h.id)!;
    expect(parent.status).toBe('completed');
    expect(parent.result).toBe('Sent 24.');
    expect(parent.replied_at).toBeTruthy();
    expect(parent.completed_at).toBeTruthy();
  });

  it('records which cycle produced the answer, so a wrong one can be traced', () => {
    const h = handLeadsOver();
    const { reply } = replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
      cycleId: 'cycle-abc',
    });
    expect(getHandoffById(reply.id)!.cycle_id).toBe('cycle-abc');
  });

  it('leaves `agree` open — taking work on is not finishing it', () => {
    const h = handLeadsOver();
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'agree',
      result: 'Picking these up on my next send slot.',
    });

    const parent = getHandoffById(h.id)!;
    expect(parent.status).toBe('agreed');
    expect(parent.completed_at).toBeFalsy();
    // Still owed, so Finder still sees it as outstanding.
    expect(getUnansweredRequestsByAgent(FINDER).map((x) => x.id)).toContain(
      h.id,
    );
  });

  it('closes the request once a real answer lands', () => {
    const h = handLeadsOver();
    expect(getUnansweredRequestsByAgent(FINDER)).toHaveLength(1);
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'done',
    });
    expect(getUnansweredRequestsByAgent(FINDER)).toHaveLength(0);
  });

  it('does not chase an `inform` — nothing was owed', () => {
    createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'fyi',
      payload: '{}',
      status: 'pending',
      performative: 'inform',
    });
    expect(getUnansweredRequestsByAgent(FINDER)).toHaveLength(0);
  });
});

describe('seen is not an answer', () => {
  it('survives as its own state after the recipient runs', () => {
    const h = handLeadsOver();
    // What a completed cycle does to everything in its inbox: it marks it seen. That is
    // all it knows. For 347 rows this was written as `acknowledged` and read as handled.
    updateHandoffStatus(h.id, 'seen');

    const parent = getHandoffById(h.id)!;
    expect(parent.status).toBe('seen');
    expect(parent.result).toBeFalsy();
    // Still owed. Waking up is not answering.
    expect(getUnansweredRequestsByAgent(FINDER).map((x) => x.id)).toContain(
      h.id,
    );
  });

  it('is counted separately from answers in the outcome report', () => {
    const answered = handLeadsOver('batch A');
    const ignored = handLeadsOver('batch B');
    replyToHandoff({
      handoffId: answered.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });
    updateHandoffStatus(ignored.id, 'seen');

    const [out] = getHandoffOutcomes(FINDER);
    expect(out.sent).toBe(2);
    expect(out.completed).toBe(1);
    expect(out.seenOnly).toBe(1);
    expect(out.recentAnswers.map((a) => a.result)).toContain('Sent 24.');
  });

  it("excludes replies from the sender's outcome counts", () => {
    const h = handLeadsOver();
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });

    // Mailer's own outcomes should not count the answer it wrote as work it delegated.
    expect(getHandoffOutcomes(MAILER)).toHaveLength(0);
  });
});

describe('the send gate cannot be armed by a reply', () => {
  /**
   * Mailer's send_outreach slot arms off "are there pending handoffs". A reply now lands
   * in the recipient's inbox as a pending row too — and a reply is not work owed. Counting
   * one would fire outreach cycles with no lead behind them, which is a variant of the bug
   * that stalled Mailer for 33 hours in the other direction.
   */
  it('workOnly sees the request but not the answer', () => {
    const toHerald = handLeadsOver();
    replyToHandoff({
      handoffId: toHerald.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });

    // Finder's inbox now holds exactly one thing: an answer.
    expect(getPendingHandoffsByAgent(FINDER)).toHaveLength(1);
    expect(getPendingHandoffsByAgent(FINDER, { workOnly: true })).toHaveLength(
      0,
    );
  });
});

describe('cannot is the keystone', () => {
  it('names the missing capability and aggregates into a backlog', () => {
    const a = handLeadsOver('batch A');
    const b = handLeadsOver('batch B');
    for (const h of [a, b]) {
      replyToHandoff({
        handoffId: h.id,
        fromAgentId: MAILER,
        performative: 'cannot',
        result: 'I did not send these.',
        reason: 'verify_email',
      });
    }

    expect(getHandoffById(a.id)!.status).toBe('cannot');
    expect(getHandoffById(a.id)!.result_reason).toBe('verify_email');

    // The crew writing its own backlog: two refusals for the same missing tool collapse
    // into one row saying what to build or grant.
    const gaps = getCannotReasons();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      agent: 'Mailer',
      reason: 'verify_email',
      count: 2,
    });
  });
});

describe('self_report tells the sender the truth', () => {
  it('prints the answer verbatim and flags work that was seen and never answered', () => {
    const answered = handLeadsOver('batch A');
    const ignored = handLeadsOver('batch B');
    replyToHandoff({
      handoffId: answered.id,
      fromAgentId: MAILER,
      performative: 'cannot',
      result: 'I did not send these.',
      reason: 'no verify_email tool',
    });
    updateHandoffStatus(ignored.id, 'seen');
    createAgentCycle({
      agent_id: MAILER,
      cycle_type: 'send_outreach',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0.01,
      tasks_done: 1,
    });

    // The real aggregator, not a hand-built fixture — a renderer that only ever sees
    // invented data is how a null count once got reported as a filled count.
    const { report: text } = renderSelfReport({
      agent: {
        name: 'Finder',
        type: 'custom',
        status: 'idle',
        created_at: '2026-08-01T00:00:00.000Z',
        identity_version: 1,
      },
      model: 'test-model',
      triggerMode: 'manual',
      schedule: [],
      nextCycle: null,
      data: getAgentSelfReport(FINDER)!,
      trackedFileCounts: {},
      handoffOutcomes: getHandoffOutcomes(FINDER),
    });

    // The answer in Mailer's own words — not summarised, because summarising is how a
    // "0 found" becomes a "found some" by the time it reaches the model.
    expect(text).toContain('no verify_email tool');
    expect(text).toContain('1 could not');
    expect(text).toContain('seen but never answered');
  });
});

describe('what the agent is shown is what is UNRESOLVED, not what is unread', () => {
  /**
   * Caught on the first live deploy, 2026-09-09, before a single cycle ran.
   *
   * The cycle context was built from `status='pending'` alone. A message flips to `seen`
   * on the way out of the first cycle that carries it — so an agent had exactly ONE
   * cycle's chance to answer, and after that the message was invisible whether it had
   * been answered or not. Mailer had 82 messages owed and would have been shown none of
   * them, on a channel built specifically so it could answer them.
   *
   * Same shape as the bug this stage exists to fix: the state meaning "you saw it and
   * said nothing" is exactly the state that must stay in view.
   */
  it('keeps a seen-but-unanswered request in view', () => {
    const h = handLeadsOver();
    updateHandoffStatus(h.id, 'seen'); // what a completed cycle does on the way out

    expect(getPendingHandoffsByAgent(MAILER)).toHaveLength(0); // unread: nothing
    const open = getOpenMessagesForAgent(MAILER);
    expect(open.owed.map((x) => x.id)).toEqual([h.id]); // unresolved: still owed
  });

  it('drops it the moment it is actually answered', () => {
    const h = handLeadsOver();
    updateHandoffStatus(h.id, 'seen');
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });

    expect(getOpenMessagesForAgent(MAILER).owed).toHaveLength(0);
  });

  it('keeps an `agreed` message in view — taken on is not answered', () => {
    const h = handLeadsOver();
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'agree',
      result: 'Next slot.',
    });

    expect(getOpenMessagesForAgent(MAILER).owed.map((x) => x.id)).toEqual([
      h.id,
    ]);
  });

  it('never asks for an answer to an `inform`', () => {
    createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'fyi',
      payload: '{}',
      status: 'seen',
      performative: 'inform',
    });
    expect(getOpenMessagesForAgent(MAILER).owed).toHaveLength(0);
  });

  it('caps the list and says how many it left out, oldest first', () => {
    // 82 messages at once is a context problem of its own. The cap is not silent: the
    // count is printed, and self_report carries the full figure.
    const ids: string[] = [];
    for (let i = 0; i < 14; i++) {
      const h = createHandoff(
        {
          from_agent_id: FINDER,
          to_agent_id: MAILER,
          type: 'leads',
          payload: '{}',
          status: 'seen',
          performative: 'request',
        },
        new Date(Date.UTC(2026, 8, 1 + i)).toISOString(),
      );
      ids.push(h.id);
    }

    const open = getOpenMessagesForAgent(MAILER, 10);
    expect(open.owed).toHaveLength(10);
    expect(open.owedOverflow).toBe(4);
    // The newest 10, presented oldest-first: whoever has waited longest is answered first.
    expect(open.owed.map((x) => x.id)).toEqual(ids.slice(4));
  });

  it('shows replies alongside, and they are not counted as work owed', () => {
    const h = handLeadsOver();
    replyToHandoff({
      handoffId: h.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'Sent 24.',
    });

    const open = getOpenMessagesForAgent(FINDER);
    expect(open.owed).toHaveLength(0);
    expect(open.replies).toHaveLength(1);
    expect(open.replies[0].reply_to).toBe(h.id);
  });
});
