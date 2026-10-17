/**
 * Route-level tests for the agent self-management API.
 *
 * These exist because a typecheck proves nothing about reachability: the whole feature
 * hangs on the router being mounted where an unauthenticated container can reach it AND
 * on the token check actually running. Both are runtime facts, so they get exercised
 * over real HTTP against a real express app.
 *
 * The service layer is mocked — its behaviour is covered in agents/self-manage.test.ts.
 * What is deliberately NOT mocked is cycle-token.ts, since token enforcement is the
 * property most worth pinning here.
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
import type { Server } from 'http';

import { issueCycleToken } from '../../agents/cycle-token.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockAgent = {
  id: 'agent-1',
  name: 'Seeker',
  emoji: '🎯',
  status: 'idle',
  whatsapp_jid: '123@s.whatsapp.net',
  config: {
    schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
    budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
    tools: [],
    goals: '',
    escalationRules: [],
  },
};

/** What the mocked createAgentCheckin stores — the route must hand this back, not its own. */
const createdCheckinId = 'checkin-from-the-db-layer';

const updateAgent = vi.fn(async (_id: string, updates: any) => ({
  ...mockAgent,
  config: { ...mockAgent.config, ...updates.config },
}));
const setSelfStatus = vi.fn();
/** What the agent returns to after the current cycle — idle unless a test says otherwise. */
let settledStatus = 'idle';
/** Whether the current cycle was started by the owner's own message. */
let humanCycle = false;
const send = vi.fn(async () => {});

vi.mock('../../agents/agent-registry.js', () => ({
  agentService: {
    getAgent: (id: string) => (id === 'agent-1' ? mockAgent : null),
    updateAgent: (...args: any[]) => (updateAgent as any)(...args),
    setSelfStatus: (...args: any[]) => (setSelfStatus as any)(...args),
    getSettledStatus: () => settledStatus,
  },
  agentScheduler: {
    register: vi.fn(),
    unregister: vi.fn(),
    getNextCycle: () => null,
    getEntryNextRuns: () => new Map(),
  },
}));

const probeModel = vi.fn(async () => true);
vi.mock('../../agents/model-safety.js', () => ({
  probeModel: (...a: any[]) => (probeModel as any)(...a),
}));

vi.mock('../../db.js', () => ({
  getAgentSelfReport: () => ({}),
  getCyclesByAgent: () => [],
  getAgentCycleById: (id: string) => ({
    id,
    human_requested: humanCycle ? 1 : 0,
  }),
  getUserById: () => ({ email: 'owner@mine.com' }),
  recordConfigAudit: vi.fn(() => 'audit-1'),
  getAllAgents: () => [mockAgent],
  getLearnedBullets: () => [],
  getEntitySchema: () => null,
  upsertEntitySchema: vi.fn(),
  countTrackedItemsInStage: () => 0,
  // Generates its own id and ignores any passed in — the behaviour the route got wrong.
  createAgentCheckin: vi.fn((c: any) => ({
    ...c,
    id: createdCheckinId,
    created_at: new Date().toISOString(),
  })),
}));

vi.mock('../instances.js', () => ({
  getChannelSender: () => send,
  getSocketIO: () => null,
}));

vi.mock('../../services/model-router.js', () => ({
  getModelConfig: () => ({
    defaultModel: 'deepseek/deepseek-v4-flash',
    fallbackChain: ['gemini/gemini-2.0-flash'],
    taskModels: {},
    thinkingDefault: false,
  }),
}));

// ─── Harness ──────────────────────────────────────────────────────────────────

let server: Server;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const mod = await import('./self-manage.js');
  (globalThis as any).__selfManageMod = mod;
  const { selfManageRouter } = mod;
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.ts mounts it, and with NO auth middleware in front —
  // which is the point: the token check inside the router is the only thing standing
  // between a container and these endpoints.
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
});

beforeEach(() => {
  vi.clearAllMocks();
  settledStatus = 'idle';
  humanCycle = false;
  delete (mockAgent.config as any).approvalRules;
  token = issueCycleToken('agent-1', 'cycle-1');
});

/** Snapshot helper for the assertions below — the module is already imported by then. */
function auditSnapshotSync(capability: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = (globalThis as any).__selfManageMod;
  return mod.auditSnapshot('agent-1', capability);
}

/** `Response.json()` resolves to `unknown` here, so read bodies through this. */
async function json(res: Response): Promise<any> {
  return await res.json();
}

function call(
  path: string,
  opts: { method?: string; body?: unknown; token?: string | null } = {},
) {
  const method = opts.method ?? 'POST';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (opts.token !== null)
    headers.authorization = `Bearer ${opts.token ?? token}`;
  // fetch throws on a GET/HEAD with a body, so drop it rather than making every
  // caller remember which verb it is using.
  const sendBody =
    opts.body !== undefined && method !== 'GET' && method !== 'HEAD';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: sendBody ? JSON.stringify(opts.body) : undefined,
  });
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('token enforcement', () => {
  it('rejects every self route without a token', async () => {
    for (const [method, path] of [
      ['GET', '/api/agents/agent-1/self'],
      ['POST', '/api/agents/agent-1/self/schedule'],
      ['POST', '/api/agents/agent-1/self/budget'],
      ['POST', '/api/agents/agent-1/self/model'],
      ['POST', '/api/agents/agent-1/self/status'],
      ['POST', '/api/agents/agent-1/self/one-off'],
      ['POST', '/api/agents/agent-1/self/whatsapp'],
    ] as const) {
      const res = await call(path, { method, body: {}, token: null });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  /** The reason tokens are agent-bound: every running agent holds a live one. */
  it("rejects another agent's valid token", async () => {
    const otherToken = issueCycleToken('agent-2', 'cycle-9');
    const res = await call('/api/agents/agent-1/self/budget', {
      body: { daily: 3 },
      token: otherToken,
    });
    expect(res.status).toBe(401);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('accepts a token minted for this agent', async () => {
    const res = await call('/api/agents/agent-1/self', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});

// ─── Schedule ─────────────────────────────────────────────────────────────────

describe('POST /self/schedule', () => {
  it('accepts a valid schedule and persists it', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        schedule: [
          { type: 'lead_search', interval: '0 9 * * 1', enabled: true },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledOnce();
    expect(updateAgent.mock.calls[0][1].config.schedule[0].interval).toBe(
      '0 9 * * 1',
    );
  });

  /** The bug this feature would otherwise have shipped with. */
  it('rejects an unparseable interval with 422 instead of silently unscheduling', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        schedule: [
          { type: 'lead_search', interval: 'every monday at 9', enabled: true },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/Cannot parse interval/);
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('rejects a cycle type the orchestrator only dispatches on events', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: { schedule: [{ type: 'job_done', interval: '4h', enabled: true }] },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/Unknown cycle type/);
  });

  it('disables the schedule when switching to on_demand, without discarding it', async () => {
    // This used to write an empty array. That did disarm the scheduler, but it also
    // threw away hand-written cron strings, so "make yourself on-demand" could not be
    // undone without retyping them. Disabling achieves the same disarm and is
    // reversible — stage 54 phase 2.
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: { triggerMode: 'on_demand' },
    });
    expect(res.status).toBe(200);

    const written = updateAgent.mock.calls[0][1].config.schedule;
    expect(written).toHaveLength(1);
    expect(written[0].enabled).toBe(false);
    // The part that must survive: the interval the owner actually wrote.
    expect(written[0].interval).toBe('4h');
    expect(written[0].type).toBe('lead_search');
  });

  it('refuses a no-op call rather than writing nothing and reporting success', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', { body: {} });
    expect(res.status).toBe(400);
  });

  /**
   * Crawler, 2026-09-23: "run 4 times a day" wrote the cron, returned ok, and the
   * agent reported Done — while it sat idle, so the scheduler skipped every fire.
   */
  it('switches an idle agent on when it sets a schedule that would fire', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        op: 'add',
        schedule: [
          { type: 'work', interval: '0 0,6,12,18 * * 1-5', enabled: true },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(setSelfStatus).toHaveBeenCalledWith('agent-1', 'running');
    const body = await json(res);
    expect(body.switchedOnNow).toBe(true);
    expect(body.on).toBe(true);
    expect(body.status).toBe('running');
    expect(body.schedule.find((e: any) => e.type === 'work').willFire).toBe(
      true,
    );
  });

  it('does not lift a pause, and says plainly that nothing will run', async () => {
    settledStatus = 'paused';
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        op: 'add',
        schedule: [{ type: 'work', interval: '4h', enabled: true }],
      },
    });
    expect(setSelfStatus).not.toHaveBeenCalled();
    const body = await json(res);
    expect(body.switchedOnNow).toBe(false);
    expect(body.on).toBe(false);
    expect(body.summary).toMatch(/NOTHING on this schedule will run/);
    expect(body.schedule.find((e: any) => e.type === 'work').blockedBy).toBe(
      'agent_not_running',
    );
  });

  it('does not switch on for a schedule that has nothing to fire', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        schedule: [{ type: 'lead_search', interval: 'manual', enabled: false }],
      },
    });
    expect(res.status).toBe(200);
    expect(setSelfStatus).not.toHaveBeenCalled();
  });

  /** 2026-09-24: an agent with three jobs needs three timers, two of them the same kind. */
  it('keeps several timers of the same kind apart by name, each with its own instruction', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        op: 'add',
        schedule: [
          {
            type: 'work',
            name: 'Hourly log',
            interval: '1h',
            enabled: true,
            instruction: 'Append to the log',
          },
          {
            type: 'work',
            name: '9 AM report',
            interval: '0 9 * * *',
            timezone: 'Asia/Kolkata',
            enabled: true,
            instruction: 'Build the xlsx',
          },
        ],
      },
    });
    expect(res.status).toBe(200);
    const written = updateAgent.mock.calls[0][1].config.schedule;
    const work = written.filter((e: any) => e.type === 'work');
    expect(work.map((e: any) => e.name)).toEqual(['Hourly log', '9 AM report']);
    expect(new Set(written.map((e: any) => e.id)).size).toBe(written.length);
    expect(work[1].timezone).toBe('Asia/Kolkata');
    // The pre-existing id-less lead_search entry survived and got its type as its id.
    expect(written.find((e: any) => e.type === 'lead_search').id).toBe(
      'lead_search',
    );
  });

  it('updates a named timer in place instead of adding a second one', async () => {
    (mockAgent.config as any).schedule = [
      {
        id: 'log',
        type: 'work',
        name: 'Hourly log',
        interval: '1h',
        enabled: true,
        instruction: 'old',
      },
    ];
    try {
      await call('/api/agents/agent-1/self/schedule', {
        body: {
          op: 'add',
          schedule: [
            { type: 'work', name: 'hourly log', interval: '2h', enabled: true },
          ],
        },
      });
      const written = updateAgent.mock.calls[0][1].config.schedule;
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        id: 'log',
        interval: '2h',
        instruction: 'old',
      });
    } finally {
      (mockAgent.config as any).schedule = [
        { type: 'lead_search', interval: '4h', enabled: true },
      ];
    }
  });

  it('refuses to guess which of several same-kind timers to remove', async () => {
    (mockAgent.config as any).schedule = [
      { id: 'a', type: 'work', name: 'A', interval: '1h', enabled: true },
      { id: 'b', type: 'work', name: 'B', interval: '2h', enabled: true },
    ];
    try {
      const res = await call('/api/agents/agent-1/self/schedule', {
        body: { op: 'remove', schedule: [{ type: 'work', interval: '1h' }] },
      });
      expect(res.status).toBe(422);
      expect((await json(res)).error).toMatch(/say which by id or name/);
    } finally {
      (mockAgent.config as any).schedule = [
        { type: 'lead_search', interval: '4h', enabled: true },
      ];
    }
  });

  /** GLM, 2026-09-24: `switchedOn: false` on an agent already running read as "you are off". */
  it('says plainly that an already-running agent is on', async () => {
    settledStatus = 'running';
    const body = await json(
      await call('/api/agents/agent-1/self/schedule', {
        body: {
          op: 'add',
          schedule: [
            { type: 'work', name: 'X', interval: '1 hour', enabled: true },
          ],
        },
      }),
    );
    expect(body.on).toBe(true);
    expect(body.switchedOnNow).toBe(false);
    expect(body.summary).toMatch(/^You are ON/);
  });

  it('answers status with no value as a read, not an error', async () => {
    settledStatus = 'idle';
    const res = await call('/api/agents/agent-1/self/status', { body: {} });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ status: 'idle', on: false });
    expect(setSelfStatus).not.toHaveBeenCalled();
  });

  it('rejects a timezone that does not exist', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        op: 'add',
        schedule: [
          {
            type: 'work',
            interval: '0 9 * * *',
            timezone: 'India/Delhi',
            enabled: true,
          },
        ],
      },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/not a known time zone/);
  });

  it('names entries that triggerMode suppresses instead of reporting them live', async () => {
    const res = await call('/api/agents/agent-1/self/schedule', {
      body: {
        triggerMode: 'on_demand',
        schedule: [{ type: 'work', interval: '4h', enabled: true }],
      },
    });
    const body = await json(res);
    expect(setSelfStatus).not.toHaveBeenCalled();
    expect(body.schedule[0].blockedBy).toBe('trigger_mode');
    expect(body.summary).toMatch(/suppresses these entries: work/);
  });
});

// ─── Settings ─────────────────────────────────────────────────────────────────

describe('POST /self/settings', () => {
  it('applies plain settings', async () => {
    const res = await call('/api/agents/agent-1/self/settings', {
      body: { icp: 'B2B SaaS, 10-50 staff', wakePolicy: { webhook: false } },
    });
    expect(res.status).toBe(200);
    const written = updateAgent.mock.calls[0][1].config;
    expect(written.icp).toBe('B2B SaaS, 10-50 staff');
    expect(written.wakePolicy).toEqual({ webhook: false });
  });

  it('refuses a wake source that does not exist', async () => {
    const res = await call('/api/agents/agent-1/self/settings', {
      body: { wakePolicy: { email: true } },
    });
    expect(res.status).toBe(422);
  });

  it("holds using the owner's own browser for approval, and applies switching it off", async () => {
    const on = await json(
      await call('/api/agents/agent-1/self/settings', {
        body: { useUserBrowser: true },
      }),
    );
    expect(on.pendingApproval.settings).toEqual(['useUserBrowser']);
    expect(updateAgent).not.toHaveBeenCalled();

    await call('/api/agents/agent-1/self/settings', {
      body: { useUserBrowser: false },
    });
    expect(updateAgent.mock.calls[0][1].config.useUserBrowser).toBe(false);
  });
});

describe('POST /self/model taskModels', () => {
  it('merges per-task overrides and drops one on null', async () => {
    (mockAgent.config as any).task_models = {
      lead_search: 'old/model',
      checkin: 'x/y',
    };
    try {
      await call('/api/agents/agent-1/self/model', {
        body: {
          taskModels: {
            lead_search: 'deepseek/deepseek-v4-flash',
            checkin: null,
          },
        },
      });
      expect(updateAgent.mock.calls[0][1].config.task_models).toEqual({
        lead_search: 'deepseek/deepseek-v4-flash',
      });
    } finally {
      delete (mockAgent.config as any).task_models;
    }
  });
});

// ─── Approval rules ───────────────────────────────────────────────────────────

describe('POST /self/approvals', () => {
  const stopAskingForMyEmails = {
    op: 'add',
    rule: { action: 'email', match: { recipient: 'owner' }, decision: 'auto' },
    reason: 'owner said so',
  };

  it('accepts "stop asking" in a run the owner started, and applies it', async () => {
    humanCycle = true;
    const res = await call('/api/agents/agent-1/self/approvals', {
      body: stopAskingForMyEmails,
    });
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(updateAgent.mock.calls[0][1].config.approvalRules[0]).toMatchObject({
      action: 'email',
      decision: 'auto',
      createdBy: 'agent',
    });
  });

  /** An agent — or a web page it read — must not be able to talk it out of asking. */
  it('turns "stop asking" into a check-in when the owner did not start the run', async () => {
    humanCycle = false;
    const body = await json(
      await call('/api/agents/agent-1/self/approvals', {
        body: stopAskingForMyEmails,
      }),
    );
    expect(body.status).toBe('pending_approval');
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('always lets the agent tighten', async () => {
    humanCycle = false;
    const body = await json(
      await call('/api/agents/agent-1/self/approvals', {
        body: {
          op: 'add',
          rule: { action: 'email', decision: 'ask' },
          reason: 'be careful',
        },
      }),
    );
    expect(body.ok).toBe(true);
  });
});

describe('held changes follow the owner rules', () => {
  it('raises the budget past the ceiling when a rule allows it', async () => {
    (mockAgent.config as any).approvalRules = [
      {
        id: 'r',
        action: 'budget_raise',
        decision: 'auto',
        createdBy: 'owner',
        createdAt: 'x',
      },
    ];
    const body = await json(
      await call('/api/agents/agent-1/self/budget', {
        body: { daily: 999, reason: 'big job' },
      }),
    );
    expect(body.ok).toBe(true);
    expect(updateAgent.mock.calls[0][1].config.budget.daily).toBe(999);
  });

  it('still holds it with no rule', async () => {
    const body = await json(
      await call('/api/agents/agent-1/self/budget', {
        body: { daily: 999, reason: 'big job' },
      }),
    );
    expect(body.status).toBe('pending_approval');
  });
});

// ─── Audit snapshots must be restorable ───────────────────────────────────────

describe('audit snapshots', () => {
  it('keeps unset fields as null so a revert can restore "unset"', async () => {
    // JSON.stringify drops undefined. Mechanic had never had a `role`, so its
    // identity snapshot came out with no `role` key at all, and the revert that was
    // supposed to clear the role had nothing to say. It reported ok and did nothing.
    const { auditSnapshot } = await import('./self-manage.js');
    const snap = auditSnapshot('agent-1', 'identity') as Record<
      string,
      unknown
    >;

    const roundTripped = JSON.parse(JSON.stringify(snap));
    for (const key of ['goals', 'role', 'personality', 'customSystemPrompt']) {
      expect(roundTripped, `"${key}" must survive JSON`).toHaveProperty(key);
    }
    expect(roundTripped.role).toBeNull();
  });

  it('names the config field, not a friendly label', () => {
    // The whole bug in one assertion.
    const snap = auditSnapshotSync('identity');
    expect(snap).toHaveProperty('customSystemPrompt');
    expect(snap).not.toHaveProperty('systemPrompt');
  });
});

// ─── Deferred self-changes ────────────────────────────────────────────────────

describe('changes that need approval', () => {
  it('returns the id of the check-in it actually created', async () => {
    // The route used to mint its own uuid and hand that back while
    // createAgentCheckin stored a different one, so the agent held a reference to a
    // row that did not exist and the owner could not correlate the two. Found on the
    // first live run, not by the types.
    const res = await call('/api/agents/agent-1/self/budget', {
      body: { daily: 1000, reason: 'testing' },
    });
    expect(res.status).toBe(200);

    const body = await json(res);
    expect(body.status).toBe('pending_approval');
    expect(body.checkinId).toBe(createdCheckinId);
  });

  it('does not apply the change while it is pending', async () => {
    await call('/api/agents/agent-1/self/budget', {
      body: { daily: 1000, reason: 'testing' },
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('an ordinary identity edit applies directly — no approval, no grant needed', async () => {
    // "Every identity edit needs approval" was removed 2026-09-14. Only an edit that
    // deletes over 30% of the identity text is still held.
    const res = await call('/api/agents/agent-1/self/identity', {
      body: { role: 'Platform Mechanic', reason: 'testing' },
    });
    expect(res.status).toBe(200);
    expect((await json(res)).ok).toBe(true);
    expect(updateAgent).toHaveBeenCalled();
  });
});

// ─── One-off runs ─────────────────────────────────────────────────────────────

describe('POST /self/one-off', () => {
  it('queues a future run', async () => {
    const at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await call('/api/agents/agent-1/self/one-off', {
      body: { at, instruction: 'ping the owner' },
    });
    expect(res.status).toBe(201);
    const { run } = await json(res);
    expect(run.instruction).toBe('ping the owner');
    expect(run.createdBy).toBe('agent');
  });

  /**
   * A past timestamp almost always means the agent resolved "1pm" against the wrong
   * day or zone. Firing immediately would hide that; refusing surfaces it.
   */
  it('rejects a time in the past', async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const res = await call('/api/agents/agent-1/self/one-off', {
      body: { at },
    });
    expect(res.status).toBe(422);
    expect((await json(res)).error).toMatch(/in the past/);
  });

  it('rejects an unparseable time', async () => {
    const res = await call('/api/agents/agent-1/self/one-off', {
      body: { at: 'tomorrow at 1' },
    });
    expect(res.status).toBe(422);
  });
});

// ─── Budget ───────────────────────────────────────────────────────────────────

describe('POST /self/budget', () => {
  it('accepts a raise within the cap', async () => {
    const res = await call('/api/agents/agent-1/self/budget', {
      body: { daily: 12 },
    });
    expect(res.status).toBe(200);
    expect(updateAgent.mock.calls[0][1].config.budget.daily).toBe(12);
  });

  it('does not apply a raise beyond the ceiling — it asks the owner instead', async () => {
    // Used to be a flat 422. That left the agent at a dead end: it would write "I
    // could not raise my budget" into a summary nobody reads and carry on degraded.
    // Stage 54 phase 3 turns the wall into a request, carrying the agent's own reason.
    const res = await call('/api/agents/agent-1/self/budget', {
      body: { daily: 5000, reason: 'web_fetch is hitting the cap mid-sweep' },
    });

    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('pending_approval');
    expect(body.checkinId).toBe(createdCheckinId);
    expect(body.error).toMatch(/ceiling/);

    // The important half: nothing was applied.
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('rejects nonsense values', async () => {
    for (const daily of [0, -1, 'lots']) {
      const res = await call('/api/agents/agent-1/self/budget', {
        body: { daily },
      });
      expect(res.status, String(daily)).toBe(422);
    }
  });

  it('leaves untouched fields alone', async () => {
    await call('/api/agents/agent-1/self/budget', { body: { daily: 7 } });
    expect(updateAgent.mock.calls[0][1].config.budget.monthly).toBe(50);
  });
});

// ─── Model ────────────────────────────────────────────────────────────────────

describe('POST /self/model', () => {
  it('accepts a model the platform is configured for', async () => {
    const res = await call('/api/agents/agent-1/self/model', {
      body: { model: 'gemini/gemini-2.0-flash' },
    });
    expect(res.status).toBe(200);
  });

  /** An unroutable model breaks every future cycle, including the one that would fix it. */
  it('refuses a model that fails a live probe, naming what is configured', async () => {
    // The allowlist this replaces was blocking a real need — in early September every
    // agent was stuck on a free model that took 43.9s to fail a one-word test and none
    // could move off it. What it was really protecting against is narrower: a model id
    // that does not resolve fails on every future cycle, including the one the agent
    // would need to undo it. So the gate is now "does it answer", not "is it on a list".
    probeModel.mockResolvedValueOnce(false);

    const res = await call('/api/agents/agent-1/self/model', {
      body: { model: 'acme/does-not-exist', reason: 'trying something faster' },
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.availableModels).toContain('deepseek/deepseek-v4-flash');
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it('accepts a model outside the configured list when it answers', async () => {
    probeModel.mockResolvedValueOnce(true);
    const res = await call('/api/agents/agent-1/self/model', {
      body: {
        model: 'acme/brand-new',
        reason: 'benchmarked faster on our prompts',
      },
    });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledOnce();
    expect(updateAgent.mock.calls[0][1].config.model).toBe('acme/brand-new');
  });
});

// ─── Status ───────────────────────────────────────────────────────────────────

describe('POST /self/status', () => {
  it('enables via the self-status path so the post-cycle restore cannot undo it', async () => {
    const res = await call('/api/agents/agent-1/self/status', {
      body: { status: 'running' },
    });
    expect(res.status).toBe(200);
    expect(setSelfStatus).toHaveBeenCalledWith('agent-1', 'running');
  });

  it('rejects runtime states the orchestrator owns', async () => {
    for (const status of ['idle', 'error', 'banana']) {
      const res = await call('/api/agents/agent-1/self/status', {
        body: { status },
      });
      expect(res.status, status).toBe(422);
    }
    expect(setSelfStatus).not.toHaveBeenCalled();
  });
});

// ─── WhatsApp ─────────────────────────────────────────────────────────────────

describe('POST /self/whatsapp', () => {
  it('sends to the bound chat, attributed to the agent', async () => {
    const res = await call('/api/agents/agent-1/self/whatsapp', {
      body: { message: 'done' },
    });
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith('123@s.whatsapp.net', 'done', {
      name: 'Seeker',
      emoji: '🎯',
    });
  });

  /** No destination parameter exists — an arbitrary JID would mean arbitrary numbers. */
  it('offers no way to choose a different recipient', async () => {
    await call('/api/agents/agent-1/self/whatsapp', {
      body: {
        message: 'hi',
        jid: '999@s.whatsapp.net',
        chatJid: '999@s.whatsapp.net',
        to: '999',
      },
    });
    expect(send).toHaveBeenCalledWith(
      '123@s.whatsapp.net',
      'hi',
      expect.anything(),
    );
  });

  it('rejects an empty message', async () => {
    const res = await call('/api/agents/agent-1/self/whatsapp', {
      body: { message: '  ' },
    });
    expect(res.status).toBe(422);
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

describe('GET /self/webhook', () => {
  /** The owner-facing equivalents are session-gated, which is why the tool always 401'd. */
  it('returns a token and an externally reachable base URL', async () => {
    process.env.WEBHOOK_BASE_URL = 'https://crew.example.com';
    const res = await call('/api/agents/agent-1/self/webhook', {
      method: 'GET',
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token).toBeTruthy();
    expect(body.baseUrl).toBe(
      'https://crew.example.com/api/agents/agent-1'.replace(
        '/agents/',
        '/webhooks/',
      ),
    );
    expect(body.externalBaseUrlConfigured).toBe(true);
    delete process.env.WEBHOOK_BASE_URL;
  });

  /**
   * Without an external base URL the only thing we could build points at the in-container
   * callback host, which resolves nowhere outside Docker. Flag it rather than return a
   * link that looks valid and silently never fires.
   */
  it('flags when no external base URL is configured', async () => {
    const savedWebhook = process.env.WEBHOOK_BASE_URL;
    const savedApp = process.env.APP_URL;
    delete process.env.WEBHOOK_BASE_URL;
    delete process.env.APP_URL;

    const res = await call('/api/agents/agent-1/self/webhook', {
      method: 'GET',
    });
    const body = await json(res);
    expect(body.externalBaseUrlConfigured).toBe(false);
    expect(body.baseUrl).toBeNull();

    if (savedWebhook !== undefined) process.env.WEBHOOK_BASE_URL = savedWebhook;
    if (savedApp !== undefined) process.env.APP_URL = savedApp;
  });

  it('requires the cycle token like every other self route', async () => {
    const res = await call('/api/agents/agent-1/self/webhook', {
      method: 'GET',
      token: null,
    });
    expect(res.status).toBe(401);
  });
});

// ─── Unknown agent ────────────────────────────────────────────────────────────

describe('unknown agent', () => {
  it('401s before 404 — an invalid token must not confirm whether an agent exists', async () => {
    const res = await call('/api/agents/nope/self', { method: 'GET' });
    expect(res.status).toBe(401);
  });
});
