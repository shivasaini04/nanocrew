/**
 * Stage 56 phases 2-4 — discovery, borrowing, and conversation.
 *
 * The objective these serve, in the owner's words: *a web of agents, where if a problem
 * needs a tool one agent has and another does not, that agent can call it, get the
 * response, and continue its job.*
 *
 * Measured 2026-09-08, before any of this: the live network was exactly the three-node
 * chain its three prompts describe, because routing was whatever a prompt happened to
 * name. Nothing could be discovered that had not already been written down.
 *
 * So these tests are about the properties that make a web possible rather than the
 * mechanics of a query:
 *
 *   - proven use outranks a grant, and an asleep agent is flagged as asleep
 *   - a miss is recorded rather than swallowed — the crew writing its own backlog
 *   - a borrow lends the tool and ONLY the credentials that tool needs
 *   - a follow-up question stays a question, and arrives with its history
 *   - an unanswered request lapses visibly instead of waiting forever
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./secrets-manager.js', () => ({
  secretsManager: {
    getAll: (agentId: string) =>
      agentId === 'agent-herald'
        ? {
            HUNTER_API_KEY: 'herald-hunter-key',
            GMAIL_REFRESH_TOKEN: 'herald-gmail-secret',
          }
        : {},
  },
}));

const { findAgents, renderMatches } = await import('./capability-index.js');
const { borrowTool } = await import('./tool-borrowing.js');
const { createHandoffFromRequest, shouldWakeOnHandoff } =
  await import('./agent-handoff.js');
const { findWaitingCycles, renderWaitingCycles } =
  await import('./waiting-cycles.js');
const {
  _initTestDatabase,
  insertAgent,
  createHandoff,
  replyToHandoff,
  getHandoffById,
  getOpenMessagesForAgent,
  getCapabilityGaps,
  getThread,
  expireOverdueHandoffs,
  replaceCycleSteps,
  createAgentCycle,
  getConfigAuditByOwner,
} = await import('../db.js');
import type { AgentConfig } from '../types.js';

const FINDER = 'agent-scout';
const MAILER = 'agent-herald';
const STRANGER = 'agent-stranger';

function agent(
  id: string,
  name: string,
  tools: string[],
  opts: { owner?: string; role?: string } = {},
) {
  insertAgent({
    id,
    name,
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: '2026-08-01T00:00:00.000Z',
    owner_id: opts.owner ?? 'me',
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools,
      goals: 'g',
      escalationRules: [],
      role: opts.role,
    } as AgentConfig,
  });
}

/** Record `n` real calls of `tool` by `agentId`, so usage is not a fixture. */
function used(agentId: string, tool: string, n: number) {
  const cycle = createAgentCycle({
    agent_id: agentId,
    cycle_type: 'custom',
    status: 'completed',
    started_at: new Date().toISOString(),
    cost: 0,
    tasks_done: 1,
  });
  replaceCycleSteps(
    agentId,
    cycle.id,
    Array.from({ length: n }, () => ({
      type: 'tool_call' as const,
      tool,
      input: '{}',
      output: 'ok',
    })),
  );
}

beforeEach(() => {
  _initTestDatabase();
  agent(FINDER, 'Finder', ['linkedin_jobs', 'web_search'], {
    role: 'finds leads',
  });
  agent(MAILER, 'Mailer', ['gmail_search', 'sql_query', 'smtp_send'], {
    role: 'sends outreach email',
  });
});

describe('phase 2 — finding who can help', () => {
  it('finds an agent by capability, not by name or tool name', () => {
    // The question an agent could not previously ask. Nothing here names Mailer.
    const found = findAgents('verify an email address', {
      excludeAgentId: FINDER,
      ownerId: 'me',
    });
    expect(found.map((m) => m.name)).toContain('Mailer');
    expect(found[0].holds).toContain('gmail_search');
  });

  it('ranks proven use above a bare grant', () => {
    agent('agent-idle-holder', 'Bystander', ['gmail_search']);
    used(MAILER, 'gmail_search', 12);

    const found = findAgents('verify email', {
      excludeAgentId: FINDER,
      ownerId: 'me',
    });
    expect(found[0].name).toBe('Mailer');
    expect(found[0].used[0]).toMatchObject({ tool: 'gmail_search', calls: 12 });
    // The bystander still appears — it may be the right answer — but it is shown as
    // holding the tool without ever having used it, rather than as equivalent.
    const bystander = found.find((m) => m.name === 'Bystander')!;
    expect(bystander.used).toHaveLength(0);
  });

  it('says plainly when a candidate is not awake', () => {
    const text = renderMatches(
      'verify email',
      findAgents('verify email', { excludeAgentId: FINDER, ownerId: 'me' }),
    );
    // Recommending an agent that has run nothing in a week is recommending silence.
    expect(text).toContain('IT IS NOT AWAKE');
  });

  it('never returns an agent belonging to someone else', () => {
    agent(STRANGER, 'SomeoneElsesAgent', ['gmail_search'], { owner: 'not-me' });
    const found = findAgents('verify email', {
      excludeAgentId: FINDER,
      ownerId: 'me',
    });
    expect(found.map((m) => m.name)).not.toContain('SomeoneElsesAgent');
  });

  it('records a miss as a capability gap — the crew writing its own backlog', () => {
    const found = findAgents('render a 3d animation', {
      excludeAgentId: FINDER,
      ownerId: 'me',
      context: 'explainer video',
    });
    expect(found).toHaveLength(0);

    const gaps = getCapabilityGaps();
    expect(gaps[0]).toMatchObject({ query: 'render a 3d animation', asks: 1 });
  });

  it('tells the agent what to do instead of returning an empty list', () => {
    const text = renderMatches('render a 3d animation', []);
    // A model handed nothing invents a teammate. This names the two real options.
    expect(text).toContain('recorded as a capability gap');
    expect(text).toContain('clarify');
    expect(text).toContain('Do not invent a teammate');
  });

  it('matches through a synonym, since needs and tool names use different words', () => {
    const found = findAgents('who can send mail', {
      excludeAgentId: FINDER,
      ownerId: 'me',
    });
    expect(found.map((m) => m.name)).toContain('Mailer');
  });

  it('is not fooled into matching everyone by filler words', () => {
    // Without stopword filtering, "can someone please help me" matches every agent that
    // has ever had a common word in a goal, and a list containing everyone is no list.
    expect(
      findAgents('can someone please help me', {
        excludeAgentId: FINDER,
        ownerId: 'me',
      }),
    ).toHaveLength(0);
  });
});

describe('phase 3 — borrowing a tool instead of waking an agent', () => {
  it('lends the tool and the credentials that tool needs', () => {
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'gmail_search',
      reason: 'checking 3 leads before handing them over',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.holder.name).toBe('Mailer');
    expect(r.env).toEqual({ GMAIL_REFRESH_TOKEN: 'herald-gmail-secret' });
  });

  it('does NOT lend credentials the tool does not need', () => {
    // The tempting shortcut is to hand over every secret the holder has that the borrower
    // lacks. Borrowing sql_query must not transfer Mailer's Gmail token or Hunter key.
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'sql_query',
      reason: 'x',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.env.GMAIL_REFRESH_TOKEN).toBeUndefined();
    expect(r.env.HUNTER_API_KEY).toBeUndefined();
  });

  it('lends an unmapped tool WITHOUT credentials and says so', () => {
    agent('agent-x', 'Xeno', ['some_unmapped_tool']);
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'some_unmapped_tool',
      reason: 'x',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Fails safe: a guess here hands over a secret nobody asked for, which is not the
    // kind of failure you find out about.
    expect(r.env).toEqual({});
    expect(r.credentialNote).toContain('WITHOUT credentials');
  });

  it('refuses to lend what the holder does not hold', () => {
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'gmail_search',
      from: 'Finder',
      reason: 'x',
    });
    expect(r.ok).toBe(false);
  });

  it('refuses across owners', () => {
    _initTestDatabase();
    agent(FINDER, 'Finder', []);
    agent(STRANGER, 'SomeoneElsesAgent', ['gmail_search'], { owner: 'not-me' });
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'gmail_search',
      reason: 'x',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('Nobody on your crew');
  });

  it('refuses without a reason — the audit row is the point', () => {
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'gmail_search',
      reason: '',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(422);
  });

  it('tells an agent it already has the tool rather than minting a pointless loan', () => {
    const r = borrowTool({
      borrowerId: FINDER,
      tool: 'web_search',
      reason: 'x',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('already have');
  });

  it("audits BOTH sides — the lender's owner must be able to see it", () => {
    borrowTool({
      borrowerId: FINDER,
      tool: 'gmail_search',
      reason: 'checking leads',
    });
    const rows = getConfigAuditByOwner(
      'me',
      new Date(Date.now() - 60_000).toISOString(),
    );
    const borrower = rows.find(
      (r) => r.agent_id === FINDER && (r.reason ?? '').includes('Borrowed'),
    );
    const lender = rows.find(
      (r) => r.agent_id === MAILER && (r.reason ?? '').includes('borrowed'),
    );
    expect(borrower).toBeTruthy();
    expect(lender).toBeTruthy();
    expect(lender!.reason ?? '').toContain('Finder');
  });
});

describe('phase 4 — conversation across cycles', () => {
  /** Finder asks, Mailer answers, Finder follows up in the same thread. */
  function exchange() {
    const q1 = createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'question',
      payload: JSON.stringify({ q: 'did the 28 leads go out?' }),
      status: 'pending',
      performative: 'request',
    });
    replyToHandoff({
      handoffId: q1.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: '24 sent, 4 bounced.',
    });
    const q2 = createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'question',
      payload: JSON.stringify({ q: 'which 4 bounced?' }),
      status: 'pending',
      performative: 'request',
      reply_to: q1.id,
      thread_id: q1.thread_id ?? q1.id,
    });
    return { q1, q2 };
  }

  it('keeps a follow-up a QUESTION, not an answer', () => {
    const { q2 } = exchange();
    // The trap: phase 4 made reply_to mean "in this thread", so a filter keyed on
    // reply_to would file this follow-up under "answers to you" and nobody would ever
    // answer it.
    const open = getOpenMessagesForAgent(MAILER);
    expect(open.owed.map((m) => m.id)).toContain(q2.id);
    expect(open.replies.map((m) => m.id)).not.toContain(q2.id);
  });

  it('holds the whole exchange in one thread', () => {
    const { q1, q2 } = exchange();
    const thread = getThread(q1.thread_id ?? q1.id);
    expect(thread).toHaveLength(3);
    expect(thread.map((m) => m.performative)).toEqual([
      'request',
      'result',
      'request',
    ]);
    expect(thread[2].id).toBe(q2.id);
  });

  it('expires an unanswered request and TELLS the sender', () => {
    const q = createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'question',
      payload: '{}',
      status: 'pending',
      performative: 'request',
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const expired = expireOverdueHandoffs();
    expect(expired.map((e) => e.id)).toContain(q.id);
    expect(getHandoffById(q.id)!.status).toBe('expired');

    // Visible, not merely recorded: the sender reads its Messages block, not the table.
    // Without this the first mutual wait deadlocks two agents and both look healthy.
    const scoutsInbox = getOpenMessagesForAgent(FINDER);
    const notice = scoutsInbox.replies.find((m) => m.performative === 'expire');
    expect(notice).toBeTruthy();
    expect(notice!.reply_to).toBe(q.id);
    expect(notice!.from_agent_id).toBe(MAILER); // who went quiet, not just that something did
  });

  it('does not expire a request that was answered in time', () => {
    const q = createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'question',
      payload: '{}',
      status: 'pending',
      performative: 'request',
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    replyToHandoff({
      handoffId: q.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'done',
    });

    expect(expireOverdueHandoffs()).toHaveLength(0);
    expect(getHandoffById(q.id)!.status).toBe('completed');
  });

  it('expires each request once, not on every sweep', () => {
    createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'question',
      payload: '{}',
      status: 'pending',
      performative: 'request',
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(expireOverdueHandoffs()).toHaveLength(1);
    expect(expireOverdueHandoffs()).toHaveLength(0);
  });

  it('never expires an `inform` — nothing was owed', () => {
    createHandoff({
      from_agent_id: FINDER,
      to_agent_id: MAILER,
      type: 'fyi',
      payload: '{}',
      status: 'pending',
      performative: 'inform',
      deadline_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(expireOverdueHandoffs()).toHaveLength(0);
  });
});

describe('one implementation, not one per route', () => {
  /**
   * The trap this repo keeps paying for. `app.post('/api/agents/:id/handoffs')` in
   * server.ts is matched by Express before the agents router, so it is the ONLY one an
   * agent ever reaches — and it had a duplicate of the resolution logic. Target resolution
   * was fixed twice on the copy agents never touch. Stage 56 then added threading and
   * deadlines to the same wrong copy, and the first live handoff came out with a thread
   * and no deadline: a deadline that does not exist.
   *
   * These pin the behaviour to the shared function, so a route that stops calling it fails
   * here rather than in production three weeks later.
   */
  const getParent = (id: string) => getHandoffById(id) as any;

  it('gives every request a deadline, so nothing can wait forever', () => {
    const r = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'leads',
        payload: { n: 1 },
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );

    expect(r.status).toBe(201);
    const h = r.body as { id: string };
    expect(getHandoffById(h.id)!.deadline_at).toBeTruthy();
  });

  it('gives an `inform` no deadline — nothing is owed, so nothing can lapse', () => {
    const r = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'fyi',
        payload: {},
        performative: 'inform',
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );

    const h = r.body as { id: string };
    expect(getHandoffById(h.id)!.deadline_at).toBeFalsy();
  });

  it('threads a follow-up onto the conversation it follows', () => {
    const first = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'question',
        payload: {},
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    ).body as { id: string };

    const second = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'question',
        payload: {},
        inReplyTo: first.id,
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    ).body as { id: string };

    expect(getHandoffById(second.id)!.thread_id).toBe(first.id);
  });

  it('refuses to graft a question onto a conversation between two other agents', () => {
    agent('agent-third', 'Third', []);
    const theirs = createHandoffFromRequest(
      MAILER,
      {
        toAgentId: 'Third',
        type: 'question',
        payload: {},
      },
      [{ id: 'agent-third', name: 'Third', owner_id: 'me' }],
      getParent,
    ).body as { id: string };

    const r = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'question',
        payload: {},
        inReplyTo: theirs.id,
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );

    expect(r.status).toBe(403);
  });

  it('refuses an answering verb — those must stamp the message they answer', () => {
    const r = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'x',
        payload: {},
        performative: 'result',
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );

    // Sent as a fresh handoff, a `result` would leave the original still reading unanswered.
    expect(r.status).toBe(400);
  });
});

describe('stage 59 — a request handoff wakes its recipient, matching ask_agent', () => {
  const withStatus = (status: string | undefined) => ({ status, config: {} });

  it('wakes an idle (on_demand or scheduled) recipient', () => {
    expect(shouldWakeOnHandoff('request', withStatus('idle'))).toBe(true);
    expect(shouldWakeOnHandoff(undefined, withStatus('idle'))).toBe(true); // default performative is request
  });

  it('does not wake for an inform — nothing is owed on it', () => {
    expect(shouldWakeOnHandoff('inform', withStatus('idle'))).toBe(false);
  });

  it('does not wake a recipient already running — its own cycle will see this', () => {
    expect(shouldWakeOnHandoff('request', withStatus('running'))).toBe(false);
  });

  it('does not wake a recipient stopped by its owner', () => {
    expect(shouldWakeOnHandoff('request', withStatus('stopped'))).toBe(false);
  });

  it('does nothing when the target status is unknown (target not found)', () => {
    expect(shouldWakeOnHandoff('request', withStatus(undefined))).toBe(false);
    expect(shouldWakeOnHandoff('request', undefined)).toBe(false);
  });

  it('does not wake when wakePolicy.handoff is turned off, even though idle', () => {
    expect(
      shouldWakeOnHandoff('request', {
        status: 'idle',
        config: { wakePolicy: { handoff: false } },
      }),
    ).toBe(false);
  });

  it('stopped still wins over wakePolicy.handoff — the hard floor cannot be overridden', () => {
    expect(
      shouldWakeOnHandoff('request', {
        status: 'stopped',
        config: { wakePolicy: { handoff: true } },
      }),
    ).toBe(false);
  });
});

describe('a message never leaves its own account', () => {
  /**
   * 2026-09-14: Mechanic sent 11 messages to "Recruiter" and every one landed with a
   * different customer's Recruiter — the resolver searched every agent on the platform and
   * the first name match won. A `request` would also have woken that agent on its owner's
   * budget. Every list below puts the other account's agent FIRST, as prod did.
   */
  const getParent = (id: string) => getHandoffById(id) as any;
  const MINE = 'agent-recruiter-mine';
  const THEIRS = 'agent-recruiter-theirs';
  const both = [
    { id: THEIRS, name: 'Recruiter', owner_id: 'someone-else' },
    { id: MINE, name: 'Recruiter', owner_id: 'me' },
  ];

  it('picks my Recruiter when another account also has one', () => {
    agent(MINE, 'Recruiter', []);
    agent(THEIRS, 'Recruiter', [], { owner: 'someone-else' });
    const r = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Recruiter',
        type: 'note',
        payload: {},
        performative: 'inform',
      },
      both,
      getParent,
    );
    expect(r.status).toBe(201);
    expect((r.body as { to_agent_id: string }).to_agent_id).toBe(MINE);
  });

  it("cannot reach another account's agent by name or by id, and does not list it", () => {
    agent(THEIRS, 'Recruiter', [], { owner: 'someone-else' });
    const theirsOnly = [
      both[0],
      { id: FINDER, name: 'Finder', owner_id: 'me' },
    ];
    for (const target of ['Recruiter', THEIRS]) {
      const r = createHandoffFromRequest(
        FINDER,
        { toAgentId: target, type: 'task', payload: {} },
        theirsOnly,
        getParent,
      );
      expect(r.status).toBe(404);
      const offered = (
        r.body as { availableAgents: Array<{ id: string }> }
      ).availableAgents.map((a) => a.id);
      expect(offered).not.toContain(THEIRS);
    }
  });

  it('gives an agent with no owner nobody to message', () => {
    agent('agent-orphan', 'Orphan', [], { owner: '' });
    const r = createHandoffFromRequest(
      'agent-orphan',
      { toAgentId: 'Mailer', type: 'task', payload: {} },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );
    expect(r.status).toBe(404);
  });
});

describe('sending many messages in one cycle', () => {
  /**
   * There is no per-cycle cap (removed 2026-09-14 at the owner's request). What stays is
   * the duplicate check: the SAME message re-sent in the same cycle — a retry loop, not
   * more work — returns the first one instead of showing the recipient a copy.
   */
  const getParent = (id: string) => getHandoffById(id) as any;
  const send = (n: number, cycle: string | undefined, vary = true) => {
    const results = [];
    for (let i = 0; i < n; i++) {
      results.push(
        createHandoffFromRequest(
          FINDER,
          {
            toAgentId: 'Mailer',
            type: 'leads',
            payload: vary ? { n: i } : { n: 1 },
            cycleId: cycle,
          },
          [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
          getParent,
        ),
      );
    }
    return results;
  };

  it('delivers every distinct message, however many', () => {
    expect(send(25, 'cycle-1').every((r) => r.status === 201)).toBe(true);
  });

  it('returns the message it already sent instead of sending it twice', () => {
    const [first, second] = send(2, 'cycle-1', false);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.body as { id: string }).id).toBe(
      (first.body as { id: string }).id,
    );
    expect((second.body as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('does not treat the same batch on a LATER cycle as a duplicate', () => {
    // Finder hands Mailer a batch of the same shape every day. Suppressing that would
    // silently drop real work, which is worse than the storm this guards against.
    const a = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'leads',
        payload: { n: 1 },
        cycleId: 'cycle-1',
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );
    const b = createHandoffFromRequest(
      FINDER,
      {
        toAgentId: 'Mailer',
        type: 'leads',
        payload: { n: 1 },
        cycleId: 'cycle-2',
      },
      [{ id: MAILER, name: 'Mailer', owner_id: 'me' }],
      getParent,
    );
    expect(b.status).toBe(201);
    expect((b.body as { id: string }).id).not.toBe(
      (a.body as { id: string }).id,
    );
  });

  it('leaves a human unlimited — a dashboard handoff has no cycle', () => {
    expect(send(15, undefined).every((r) => r.status === 201)).toBe(true);
  });
});

describe('agents waiting on each other are found', () => {
  /**
   * The failure that is dangerous because it looks fine. A waits on B, B waits on A, both
   * requests sit unanswered, both agents report healthy, and nothing says the pair has
   * stopped. Same shape as 347 handoffs reading `acknowledged` — one level up, in the
   * graph rather than the row.
   */
  let clock = 0;
  const wait = (from: string, to: string) =>
    createHandoff(
      {
        from_agent_id: from,
        to_agent_id: to,
        type: 'question',
        payload: '{}',
        status: 'seen',
        performative: 'request',
      },
      new Date(Date.UTC(2026, 8, 9, 0, clock++)).toISOString(),
    );

  it('finds a two-agent deadlock, reported from whoever has waited longest', () => {
    wait(FINDER, MAILER);
    wait(MAILER, FINDER);

    const cycles = findWaitingCycles();
    expect(cycles).toHaveLength(1);
    expect(cycles[0].path).toEqual(['Finder', 'Mailer', 'Finder']);
  });

  it('finds a longer chain', () => {
    agent('agent-third', 'Third', []);
    wait(FINDER, MAILER);
    wait(MAILER, 'agent-third');
    wait('agent-third', FINDER);

    expect(findWaitingCycles()).toHaveLength(1);
  });

  it('reports one deadlock once, not once per direction', () => {
    wait(FINDER, MAILER);
    wait(MAILER, FINDER);
    // A→B→A and B→A→B are the same deadlock. Reporting both trains the reader to skim.
    expect(findWaitingCycles()).toHaveLength(1);
  });

  it('says nothing when work is merely flowing one way', () => {
    wait(FINDER, MAILER);
    wait(FINDER, MAILER);
    expect(findWaitingCycles()).toHaveLength(0);
  });

  it('stops counting a pair once one of them answers', () => {
    const a = wait(FINDER, MAILER);
    wait(MAILER, FINDER);
    expect(findWaitingCycles()).toHaveLength(1);

    replyToHandoff({
      handoffId: a.id,
      fromAgentId: MAILER,
      performative: 'result',
      result: 'here you go',
    });
    expect(findWaitingCycles()).toHaveLength(0);
  });

  it('renders something a human can act on', () => {
    wait(FINDER, MAILER);
    wait(MAILER, FINDER);
    const text = renderWaitingCycles(findWaitingCycles());
    expect(text).toContain('Finder → Mailer → Finder');
    expect(text).toContain('resolves itself');
  });
});
