/**
 * End-to-end test of agent self-management: real routes, real AgentService, real SQLite,
 * real AgentScheduler. Nothing is mocked except the cycle runner (so no container spawns)
 * and the WhatsApp channel sender.
 *
 * The sibling self-manage.test.ts mocks the service to test the routes' own validation.
 * This one exists to answer the different question: does a request that arrives the way an
 * agent's tool sends it actually change what the platform *does* — arm a schedule, fire a
 * cycle, pause an agent — rather than just persist a field and return 200.
 *
 * agent-registry is mocked only to redirect the singletons at a temp workspace; the objects
 * behind it are the genuine AgentService and AgentScheduler.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';

import { getCheckinsByAgent, _initTestDatabase } from '../../db.js';
import { AgentService, type CycleRunner } from '../../agents/agent-service.js';
import { AgentScheduler } from '../../agents/agent-scheduler.js';
import { issueCycleToken } from '../../agents/cycle-token.js';
import type { AgentConfig } from '../../types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-e2e-'));

const cycleRunner: CycleRunner = {
  run: vi.fn(async () => ({ summary: 'ok', cost: 0.01, tasksDone: 1 })),
};

// Real objects — only the workspace root differs from production.
const realService = new AgentService(tmpDir, cycleRunner);
const realScheduler = new AgentScheduler(realService);

vi.mock('../../agents/agent-registry.js', () => ({
  agentService: new Proxy(
    {},
    {
      get: (_t, p) =>
        (realService as any)[p]?.bind?.(realService) ?? (realService as any)[p],
    },
  ),
  agentScheduler: new Proxy(
    {},
    {
      get: (_t, p) =>
        (realScheduler as any)[p]?.bind?.(realScheduler) ??
        (realScheduler as any)[p],
    },
  ),
}));

const sentWhatsApp: Array<{ jid: string; text: string }> = [];
vi.mock('../instances.js', () => ({
  getChannelSender: () => async (jid: string, text: string) => {
    sentWhatsApp.push({ jid, text });
  },
  getSocketIO: () => null,
}));

let server: Server;
let baseUrl: string;

const baseConfig: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'Find leads',
  escalationRules: [],
};

beforeAll(async () => {
  const { selfManageRouter } = await import('./self-manage.js');
  const app = express();
  app.use(express.json());
  app.use('/api/agents', selfManageRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  _initTestDatabase();
  sentWhatsApp.length = 0;
  vi.clearAllMocks();
});

/** Create a real agent and mint the token its container would have been handed. */
async function newAgent(config: Partial<AgentConfig> = {}) {
  const agent = await realService.createAgent({
    name: 'E2E',
    type: 'lead_hunter',
    config: { ...baseConfig, ...config },
  });
  return { id: agent.id, token: issueCycleToken(agent.id, 'cycle-e2e') };
}

function callAs(
  id: string,
  token: string,
  p: string,
  opts: { method?: string; body?: unknown } = {},
) {
  const method = opts.method ?? 'POST';
  return fetch(`${baseUrl}/api/agents/${id}${p}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body:
      opts.body !== undefined && method !== 'GET'
        ? JSON.stringify(opts.body)
        : undefined,
  });
}

describe('e2e: an agent rescheduling itself', () => {
  it('persists the schedule AND arms the scheduler to match', async () => {
    const { id, token } = await newAgent();

    const res = await callAs(id, token, '/self/schedule', {
      body: {
        schedule: [{ type: 'lead_search', interval: '30m', enabled: true }],
      },
    });
    expect(res.status).toBe(200);

    // Persisted...
    const stored = realService
      .getAgent(id)!
      .config.schedule.find((s) => s.type === 'lead_search');
    expect(stored!.interval).toBe('30m');

    // ...and actually armed, which is the part a 200 alone does not prove.
    const next = realScheduler.getNextCycle(id);
    expect(next).not.toBeNull();
    expect(next!.dueAt.getTime()).toBeGreaterThan(0);
  });

  it('a rejected interval changes nothing at all', async () => {
    const { id, token } = await newAgent();
    const before = JSON.stringify(realService.getAgent(id)!.config.schedule);

    const res = await callAs(id, token, '/self/schedule', {
      body: {
        schedule: [{ type: 'lead_search', interval: '1m', enabled: true }],
      },
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(realService.getAgent(id)!.config.schedule)).toBe(
      before,
    );
  });

  it('switching to on_demand disarms the scheduler', async () => {
    const { id, token } = await newAgent();
    await realService.startAgent(id);
    realScheduler.register(id, realService.getAgent(id)!.config);

    await callAs(id, token, '/self/schedule', {
      body: { triggerMode: 'on_demand' },
    });

    // The property that matters is the disarm, and it still holds: every entry is
    // disabled, so resyncSchedule unregisters the agent and nothing is due.
    const sched = realService.getAgent(id)!.config.schedule;
    expect(sched.every((e) => !e.enabled)).toBe(true);
    expect(realScheduler.getNextCycle(id)).toBeNull();

    // What changed in stage 54 phase 2: the entries are kept rather than deleted, so
    // switching back does not mean retyping cron strings the owner wrote by hand.
    expect(sched.length).toBeGreaterThan(0);
  });
});

describe('e2e: "ping me at 1pm"', () => {
  /** The whole point of the feature, exercised through the same path the tool uses. */
  it('queues a one-off and actually fires a cycle when it comes due', async () => {
    const { id, token } = await newAgent();
    await realService.startAgent(id);

    const at = new Date(Date.now() + 60_000).toISOString();
    const res = await callAs(id, token, '/self/one-off', {
      body: {
        at,
        cycleType: 'custom',
        instruction: 'WhatsApp the owner about Acme',
      },
    });
    expect(res.status).toBe(201);

    // Not yet due — nothing fires.
    await realScheduler.tick(new Date());
    expect(cycleRunner.run).not.toHaveBeenCalled();

    // Due — fires exactly once, with the instruction carried through as context.
    await realScheduler.tick(new Date(Date.now() + 61_000));
    expect(cycleRunner.run).toHaveBeenCalledTimes(1);
    const ctx = JSON.stringify((cycleRunner.run as any).mock.calls[0]);
    expect(ctx).toContain('WhatsApp the owner about Acme');

    // And is consumed, so it cannot fire again.
    expect(realService.getAgent(id)!.config.oneOffRuns ?? []).toHaveLength(0);
    await realScheduler.tick(new Date(Date.now() + 120_000));
    expect(cycleRunner.run).toHaveBeenCalledTimes(1);
  });

  it('can be cancelled before it fires', async () => {
    const { id, token } = await newAgent();
    const at = new Date(Date.now() + 60_000).toISOString();
    const created = (await (
      await callAs(id, token, '/self/one-off', { body: { at } })
    ).json()) as any;

    const del = await callAs(id, token, `/self/one-off/${created.run.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);

    await realScheduler.tick(new Date(Date.now() + 61_000));
    expect(cycleRunner.run).not.toHaveBeenCalled();
  });
});

describe('e2e: budget, model and status', () => {
  it('a self-set budget is the one the scheduler enforces', async () => {
    const { id, token } = await newAgent();
    await realService.startAgent(id);

    await callAs(id, token, '/self/budget', { body: { daily: 0.005 } });
    expect(realService.getAgent(id)!.config.budget.daily).toBe(0.005);

    // Burn past it, then confirm the scheduler honours the new number.
    await realService.runCycle(id, 'lead_search');
    realScheduler.register(id, realService.getAgent(id)!.config);
    await realScheduler.tick(new Date(Date.now() + 10 * 3600e3));

    expect(realService.getAgent(id)!.status).toBe('paused');
  });

  it('does not apply a raise beyond the ceiling, and asks the owner instead', async () => {
    const { id, token } = await newAgent();
    const res = await callAs(id, token, '/self/budget', {
      body: { daily: 5000, reason: 'needs headroom for a bigger sweep' },
    });

    // Stage 54 phase 3: the ceiling still holds, but the refusal now opens a check-in
    // rather than leaving the agent with nowhere to go.
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.status).toBe('pending_approval');

    // The property this test has always been for: the money did not move.
    expect(realService.getAgent(id)!.config.budget.daily).toBe(5);

    // And the ask is really queued, with the agent's reason on it.
    const pending = getCheckinsByAgent(id).filter(
      (c) => c.status === 'pending',
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].action_type).toBe('self_change');
    expect(pending[0].report_md).toMatch(/needs headroom for a bigger sweep/);
  });

  it('self-pausing survives the cycle it happens in, and stops the scheduler', async () => {
    const { id, token } = await newAgent();
    await realService.startAgent(id);
    realScheduler.register(id, realService.getAgent(id)!.config);

    await callAs(id, token, '/self/status', { body: { status: 'paused' } });
    expect(realService.getAgent(id)!.status).toBe('paused');
    expect(realScheduler.getNextCycle(id)).toBeNull();

    await realScheduler.tick(new Date(Date.now() + 10 * 3600e3));
    expect(cycleRunner.run).not.toHaveBeenCalled();
  });

  it('self-enabling is not undone by the end of the cycle it happened in', async () => {
    const { id, token } = await newAgent();
    expect(realService.getAgent(id)!.status).toBe('idle');

    (realService as any).runner = {
      run: vi.fn(async () => {
        await callAs(id, token, '/self/status', {
          body: { status: 'running' },
        });
        return { summary: 'enabled myself', cost: 0.01, tasksDone: 1 };
      }),
    };
    await realService.runCycle(id, 'custom');
    expect(realService.getAgent(id)!.status).toBe('running');
    (realService as any).runner = cycleRunner;
  });
});

describe('e2e: WhatsApp + webhook', () => {
  it('sends only to the owner-bound chat', async () => {
    const { id, token } = await newAgent();
    // No chat bound yet — must refuse rather than invent a destination.
    const refused = await callAs(id, token, '/self/whatsapp', {
      body: { message: 'hi' },
    });
    expect(refused.status).toBe(409);
    expect(sentWhatsApp).toHaveLength(0);

    await realService.updateAgent(id, { whatsapp_jid: '99@s.whatsapp.net' });
    const ok = await callAs(id, token, '/self/whatsapp', {
      body: { message: 'done' },
    });
    expect(ok.status).toBe(200);
    expect(sentWhatsApp).toEqual([{ jid: '99@s.whatsapp.net', text: 'done' }]);
  });

  /**
   * createAgent already mints a webhookToken (agent-service.ts), so in practice this
   * route reads rather than creates — which is precisely what was broken: the read
   * endpoint was session-gated, so register_webhook 401'd on every call despite the
   * token existing all along. What matters here is that repeated calls are stable.
   */
  it('returns the existing webhook token and never rotates it', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://crew.example.com';
    const { id, token } = await newAgent();
    const original = realService.getAgent(id)!.config.webhookToken;
    expect(original).toBeTruthy();

    const first = (await (
      await callAs(id, token, '/self/webhook', { method: 'GET' })
    ).json()) as any;
    expect(first.token).toBe(original);
    expect(first.created).toBe(false);
    expect(first.baseUrl).toBe(`https://crew.example.com/api/webhooks/${id}`);

    // Rotation would silently break whatever the owner already pasted into GitHub.
    const second = (await (
      await callAs(id, token, '/self/webhook', { method: 'GET' })
    ).json()) as any;
    expect(second.token).toBe(original);
    expect(realService.getAgent(id)!.config.webhookToken).toBe(original);

    delete process.env.WEBHOOK_BASE_URL;
  });

  /** The mint-on-first-use branch, for an agent that genuinely has no token. */
  it('mints a token when the agent has none', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://crew.example.com';
    const { id, token } = await newAgent();
    const cfg = { ...realService.getAgent(id)!.config };
    delete cfg.webhookToken;
    await realService.updateAgent(id, { config: cfg as AgentConfig });
    // updateAgent shallow-merges, so clear it explicitly.
    const { updateAgentConfig } = await import('../../db.js');
    updateAgentConfig(id, cfg as AgentConfig);
    expect(realService.getAgent(id)!.config.webhookToken).toBeUndefined();

    const res = (await (
      await callAs(id, token, '/self/webhook', { method: 'GET' })
    ).json()) as any;
    expect(res.created).toBe(true);
    expect(res.token).toBeTruthy();
    expect(realService.getAgent(id)!.config.webhookToken).toBe(res.token);

    delete process.env.WEBHOOK_BASE_URL;
  });
});

describe('e2e: isolation between agents', () => {
  it("one agent's token cannot touch another agent", async () => {
    const a = await newAgent();
    const b = await newAgent();

    const res = await callAs(b.id, a.token, '/self/budget', {
      body: { daily: 19 },
    });
    expect(res.status).toBe(401);
    expect(realService.getAgent(b.id)!.config.budget.daily).toBe(5);
  });
});

// ─── Stage 56 phase 1 — answering a teammate, over the real route ─────────────
//
// The unit tests in agents/handoff-reply.test.ts cover the data. These cover the two
// things only the route decides: who is allowed to put words in whose mouth, and whether
// a refusal is allowed to arrive without a reason.
//
// The second is not pedantry. A bare `reject` on a check-in was once LLM-summarised into
// invented instructions and written to IDENTITY.md at relevance 0.9 — a refusal with no
// reason gets a reason imagined for it. So the route refuses the refusal.

describe('e2e: answering a handoff', () => {
  /** Two real agents, and a message from the first to the second. */
  async function pair() {
    const sender = await newAgent();
    const recipient = await newAgent();
    const { createHandoff } = await import('../../db.js');
    const handoff = createHandoff({
      from_agent_id: sender.id,
      to_agent_id: recipient.id,
      type: 'leads',
      payload: JSON.stringify({ count: 28 }),
      status: 'pending',
      performative: 'request',
    });
    return { sender, recipient, handoff };
  }

  it('writes the answer and closes the message it answers', async () => {
    const { recipient, handoff } = await pair();

    const res = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'result', result: 'Sent 24, 4 bounced.' },
      },
    );
    expect(res.status).toBe(200);

    const { getHandoffById } = await import('../../db.js');
    const parent = getHandoffById(handoff.id)!;
    expect(parent.status).toBe('completed');
    expect(parent.result).toBe('Sent 24, 4 bounced.');
    // Provenance: the cycle that wrote it, taken from the token rather than the body,
    // so an agent cannot attribute its answer to a different run.
    const body = (await res.json()) as { replyId: string };
    expect(getHandoffById(body.replyId)!.cycle_id).toBe('cycle-e2e');
  });

  it('refuses to let an agent answer a message addressed to someone else', async () => {
    const { sender, handoff } = await pair();
    // The SENDER trying to close out its own request — the shape that would let an
    // agent report a teammate as having done work the teammate never did.
    const res = await callAs(
      sender.id,
      sender.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'result', result: 'Mailer says it went fine.' },
      },
    );
    expect(res.status).toBe(403);

    const { getHandoffById } = await import('../../db.js');
    expect(getHandoffById(handoff.id)!.status).toBe('pending');
  });

  it('will not accept a refusal without a reason', async () => {
    const { recipient, handoff } = await pair();
    const res = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'refuse', result: 'No.' },
      },
    );
    expect(res.status).toBe(422);

    const { getHandoffById } = await import('../../db.js');
    expect(getHandoffById(handoff.id)!.status).toBe('pending');
  });

  it('demands the missing capability be named on `cannot`', async () => {
    const { recipient, handoff } = await pair();

    const bare = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'cannot', result: 'I could not do this.' },
      },
    );
    expect(bare.status).toBe(422);

    const named = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: {
          performative: 'cannot',
          result: 'I could not do this.',
          reason: 'verify_email',
        },
      },
    );
    expect(named.status).toBe(200);

    // The name is the product: it is the crew writing its own backlog.
    const { getCannotReasons } = await import('../../db.js');
    expect(getCannotReasons()[0]).toMatchObject({
      reason: 'verify_email',
      count: 1,
    });
  });

  it('rejects an unknown verb with the vocabulary, not a bare error', async () => {
    const { recipient, handoff } = await pair();
    const res = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'done', result: 'finished' },
      },
    );
    expect(res.status).toBe(422);
    // A model handed "invalid" tries a new wrong shape; Mailer did that 90 times in a
    // day. Handed the list, it picks one.
    const body = (await res.json()) as {
      error: string;
      meaning: Record<string, string>;
    };
    expect(body.error).toContain('cannot');
    expect(Object.keys(body.meaning)).toContain('cannot');
  });

  it('lists what it owes an answer on, so a lost id is recoverable', async () => {
    const { recipient, handoff } = await pair();
    const res = await callAs(recipient.id, recipient.token, '/self/handoffs', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      owedByYou: Array<{ id: string; from: string }>;
    };
    expect(body.owedByYou.map((h) => h.id)).toContain(handoff.id);
    // Named, not a UUID — an agent cannot address a teammate by one and will not ask.
    expect(body.owedByYou[0].from).toBe('E2E');
  });
});

// ─── Stage 56 phase 5 — asking a teammate and waiting for the answer ──────────
//
// The last piece of the objective: "call that agent, wait for the response, and once
// confirmed continue its job."
//
// What is worth testing is not that a request row appears — phase 1 covers that. It is the
// three guards, because each one exists against a failure this system has already had:
// a loop a model cannot exit, two agents waiting on each other, and a wait that outlives
// the cycle it was supposed to return into.

describe('e2e: asking a teammate and waiting', () => {
  async function pair() {
    const asker = await newAgent();
    const target = await newAgent();
    // The e2e harness names every agent 'E2E'; rename so resolveSibling can tell them
    // apart the way an agent would — by name.
    // The harness names every agent 'E2E'; rename so resolveSibling can tell them
    // apart the way an agent would — by name. They also need a shared owner: an agent
    // with no owner has no teammates, which is the boundary, not a bug.
    const { updateAgentFields, setAgentOwner } = await import('../../db.js');
    updateAgentFields(target.id, { name: 'Helper' } as any);
    setAgentOwner(asker.id, 'owner-e2e');
    setAgentOwner(target.id, 'owner-e2e');
    return { asker, target };
  }

  it('returns the answer in the same call when the teammate replies', async () => {
    const { asker, target } = await pair();
    const { getPendingHandoffsByAgent, replyToHandoff } =
      await import('../../db.js');

    // Stand in for the woken cycle: answer as soon as the question lands.
    const answering = (async () => {
      for (let i = 0; i < 60; i++) {
        const inbox = getPendingHandoffsByAgent(target.id, { workOnly: true });
        if (inbox.length > 0) {
          replyToHandoff({
            handoffId: inbox[0].id,
            fromAgentId: target.id,
            performative: 'result',
            result: 'Yes — 4 of them bounced.',
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    })();

    const res = await callAs(asker.id, asker.token, '/self/ask', {
      body: {
        to: 'Helper',
        question: 'did any of those bounce?',
        waitSeconds: 20,
      },
    });
    await answering;

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answered: boolean;
      answer: string;
      from: string;
    };
    expect(body.answered).toBe(true);
    expect(body.answer).toBe('Yes — 4 of them bounced.');
    expect(body.from).toBe('Helper');
  }, 20_000);

  it('gives up cleanly and tells the agent NOT to ask again', async () => {
    const { asker } = await pair();

    const res = await callAs(asker.id, asker.token, '/self/ask', {
      body: { to: 'Helper', question: 'anything?', waitSeconds: 0 },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      answered: boolean;
      note: string;
      handoffId: string;
    };
    expect(body.answered).toBe(false);
    // "Not yet" is a real answer. A model told only that the call failed asks again,
    // and asking again is how one unanswered question becomes a retry storm.
    expect(body.note).toContain('Do NOT wait again');

    // The question is not lost — it stands, with its deadline, in their inbox.
    const { getHandoffById } = await import('../../db.js');
    const h = getHandoffById(body.handoffId)!;
    expect(h.status).toBe('pending');
    expect(h.deadline_at).toBeTruthy();
  }, 20_000);

  it('allows a second ask in the same cycle', async () => {
    // The one-ask-per-cycle limit was removed 2026-09-14: the running-agent check
    // below already prevents the deadlock it guarded against.
    const { asker } = await pair();

    const first = await callAs(asker.id, asker.token, '/self/ask', {
      body: { to: 'Helper', question: 'one?', waitSeconds: 0 },
    });
    expect(first.status).toBe(200);

    const second = await callAs(asker.id, asker.token, '/self/ask', {
      body: { to: 'Helper', question: 'two?', waitSeconds: 0 },
    });
    expect(second.status).toBe(200);
  }, 20_000);

  it('refuses to wait on an agent that is already running', async () => {
    const { asker, target } = await pair();
    const { updateAgentStatus } = await import('../../db.js');
    updateAgentStatus(target.id, 'running');

    const res = await callAs(asker.id, asker.token, '/self/ask', {
      body: {
        to: 'Helper',
        question: 'are you waiting on me?',
        waitSeconds: 5,
      },
    });

    // The direct deadlock check: if it is mid-cycle it may be waiting on us.
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain(
      'handoff_to',
    );
  });

  it('names the crew rather than failing blankly on an unknown teammate', async () => {
    const { asker } = await pair();
    const res = await callAs(asker.id, asker.token, '/self/ask', {
      body: { to: 'Nobody', question: 'hello?', waitSeconds: 0 },
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; yourCrew: string[] };
    expect(body.error).toContain('find_agent');
    expect(body.yourCrew).toContain('Helper');
  });
});

describe('e2e: a message cannot be answered twice', () => {
  /**
   * Without this a retry loop stamps the parent again and again, and — worse — a LATER
   * answer silently overwrites an earlier one, so "what did Mailer say" depends on how
   * many times it said it.
   */
  async function asked() {
    const sender = await newAgent();
    const recipient = await newAgent();
    const { createHandoff } = await import('../../db.js');
    const handoff = createHandoff({
      from_agent_id: sender.id,
      to_agent_id: recipient.id,
      type: 'leads',
      payload: '{}',
      status: 'pending',
      performative: 'request',
    });
    return { recipient, handoff };
  }

  it('refuses a second answer and quotes the first', async () => {
    const { recipient, handoff } = await asked();
    const body = { performative: 'result', result: 'Sent 24, 4 bounced.' };

    expect(
      (
        await callAs(
          recipient.id,
          recipient.token,
          `/self/handoffs/${handoff.id}/reply`,
          { body },
        )
      ).status,
    ).toBe(200);

    const again = await callAs(
      recipient.id,
      recipient.token,
      `/self/handoffs/${handoff.id}/reply`,
      {
        body: { performative: 'result', result: 'Actually 12.' },
      },
    );
    expect(again.status).toBe(409);
    const err = (await again.json()) as { error: string };
    expect(err.error).toContain('Sent 24, 4 bounced.');

    const { getHandoffById } = await import('../../db.js');
    expect(getHandoffById(handoff.id)!.result).toBe('Sent 24, 4 bounced.');
  });

  it('still lets an `agree` be followed by the real answer', async () => {
    const { recipient, handoff } = await asked();

    expect(
      (
        await callAs(
          recipient.id,
          recipient.token,
          `/self/handoffs/${handoff.id}/reply`,
          {
            body: {
              performative: 'agree',
              result: 'Picking these up next slot.',
            },
          },
        )
      ).status,
    ).toBe(200);

    // The one legitimate second reply: a promise, then delivery on it.
    expect(
      (
        await callAs(
          recipient.id,
          recipient.token,
          `/self/handoffs/${handoff.id}/reply`,
          {
            body: { performative: 'result', result: 'Done — 24 sent.' },
          },
        )
      ).status,
    ).toBe(200);

    const { getHandoffById } = await import('../../db.js');
    const h = getHandoffById(handoff.id)!;
    expect(h.status).toBe('completed');
    expect(h.result).toBe('Done — 24 sent.');
  });
});
