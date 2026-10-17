/**
 * Milestone 1.4 — AgentScheduler
 * Tests: interval parsing, nextWeekday, calcNextRun, register/unregister,
 * getDueAgents, getNextCycle, tick (budget gate + cycle firing + reschedule).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { _initTestDatabase, getAllAgents } from '../db.js';
import { AgentService, type CycleRunner } from './agent-service.js';
import {
  AgentScheduler,
  parseIntervalMs,
  nextWeekday,
  calcNextRun,
} from './agent-scheduler.js';
import type { AgentConfig } from '../types.js';

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock('../notifications.js', async (orig) => ({
  ...(await orig<any>()),
  notify: notifyMock,
}));

let tmpDir: string;
let svc: AgentService;
let scheduler: AgentScheduler;

const mockRunner: CycleRunner = {
  run: vi.fn(async () => ({ summary: 'ok', cost: 0.01, tasksDone: 1 })),
};

const defaultConfig: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: ['apollo'],
  goals: 'Find leads',
  escalationRules: [],
};

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-sched-test-'));
  svc = new AgentService(tmpDir, mockRunner);
  scheduler = new AgentScheduler(svc);
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── parseIntervalMs ─────────────────────────────────────────────────────────

describe('parseIntervalMs', () => {
  it('parses "1h" to 3 600 000 ms', () => {
    expect(parseIntervalMs('1h')).toBe(3_600_000);
  });

  it('parses "4h" to 14 400 000 ms', () => {
    expect(parseIntervalMs('4h')).toBe(14_400_000);
  });

  it('parses "24h" to 86 400 000 ms', () => {
    expect(parseIntervalMs('24h')).toBe(86_400_000);
  });

  it('parses "7d" to 604 800 000 ms', () => {
    expect(parseIntervalMs('7d')).toBe(604_800_000);
  });

  it('accepts the forms models write: spaces, full words, a leading "every"', () => {
    expect(parseIntervalMs('1 hour')).toBe(3_600_000);
    expect(parseIntervalMs('every 30 minutes')).toBe(1_800_000);
    expect(parseIntervalMs('2 days')).toBe(172_800_000);
    expect(parseIntervalMs('4hrs')).toBe(14_400_000);
  });

  it('returns null for day-of-week strings', () => {
    expect(parseIntervalMs('monday')).toBeNull();
    expect(parseIntervalMs('Sunday')).toBeNull();
  });
});

// ─── nextWeekday ─────────────────────────────────────────────────────────────

describe('nextWeekday', () => {
  it('returns a future date on the correct weekday', () => {
    // Wednesday 2026-03-18
    const from = new Date('2026-03-18T12:00:00Z');
    const next = nextWeekday('monday', from);
    expect(next.getDay()).toBe(1); // Monday
    expect(next > from).toBe(true);
  });

  it('always advances at least 1 day even if today is the target day', () => {
    // 2026-03-23 is a Monday
    const monday = new Date('2026-03-23T10:00:00Z');
    const next = nextWeekday('monday', monday);
    expect(next.getDay()).toBe(1);
    expect(next > monday).toBe(true);
  });

  it('throws for unknown day name', () => {
    expect(() => nextWeekday('funday')).toThrow('Unknown day name');
  });
});

// ─── calcNextRun ─────────────────────────────────────────────────────────────

describe('calcNextRun', () => {
  it('returns "now" when lastRun is null (interval)', () => {
    const now = new Date('2026-03-20T10:00:00Z');
    const next = calcNextRun('4h', null, now);
    expect(next).toEqual(now);
  });

  it('adds interval to lastRun', () => {
    const lastRun = new Date('2026-03-20T08:00:00Z');
    const now = new Date('2026-03-20T10:00:00Z');
    const next = calcNextRun('4h', lastRun, now);
    expect(next).toEqual(new Date('2026-03-20T12:00:00Z'));
  });

  it('returns "now" for day-of-week when lastRun is null', () => {
    const now = new Date('2026-03-20T10:00:00Z');
    const next = calcNextRun('monday', null, now);
    expect(next).toEqual(now);
  });

  it('returns next weekday occurrence when lastRun is set', () => {
    const lastRun = new Date('2026-03-16T09:00:00Z'); // Monday
    const now = new Date('2026-03-20T10:00:00Z'); // Friday
    const next = calcNextRun('monday', lastRun, now);
    expect(next.getDay()).toBe(1); // Monday
    expect(next > now).toBe(true);
  });
});

// ─── register / unregister ───────────────────────────────────────────────────

describe('register / unregister', () => {
  it('getDueAgents returns the agent immediately after register (no prior runs)', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);

    const now = new Date();
    const due = scheduler.getDueAgents(now);
    expect(
      due.some((d) => d.agentId === agent.id && d.cycleType === 'lead_search'),
    ).toBe(true);
  });

  it('unregister removes agent from due list', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);
    scheduler.unregister(agent.id);

    const due = scheduler.getDueAgents(new Date());
    expect(due.some((d) => d.agentId === agent.id)).toBe(false);
  });

  it('getNextCycle returns null for unregistered agent', () => {
    expect(scheduler.getNextCycle('unknown-id')).toBeNull();
  });

  it('getNextCycle returns a future dueAt after a cycle has run', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);

    // Simulate tick — runs the due cycle, reschedules
    await scheduler.tick(new Date());

    const next = scheduler.getNextCycle(agent.id);
    expect(next).not.toBeNull();
    expect(next!.dueAt > new Date()).toBe(true); // rescheduled into the future
  });
});

// ─── getDueAgents ────────────────────────────────────────────────────────────

describe('getDueAgents', () => {
  it('returns empty array when no agents are registered', () => {
    expect(scheduler.getDueAgents(new Date())).toHaveLength(0);
  });

  it('does not return disabled schedule entries', async () => {
    const config: AgentConfig = {
      ...defaultConfig,
      schedule: [{ type: 'lead_search', interval: '4h', enabled: false }],
    };
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, config);

    const due = scheduler.getDueAgents(new Date());
    expect(due.some((d) => d.agentId === agent.id)).toBe(false);
  });

  it('returns only entries whose nextRun <= now', async () => {
    const future = new Date(Date.now() + 99 * 60 * 60 * 1000); // 99 hours from now
    const past = new Date('2026-01-01T00:00:00Z');

    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);

    // getDueAgents called with a past "now" — nothing due
    expect(scheduler.getDueAgents(past)).toHaveLength(0);

    // getDueAgents called with far-future "now" — entry is due
    expect(
      scheduler.getDueAgents(future).some((d) => d.agentId === agent.id),
    ).toBe(true);
  });
});

// ─── tick ────────────────────────────────────────────────────────────────────

describe('tick', () => {
  it('calls runCycle for each due entry and reschedules', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);

    await scheduler.tick(new Date());

    expect(mockRunner.run).toHaveBeenCalledOnce();
    // After tick, should be rescheduled into the future
    const due = scheduler.getDueAgents(new Date());
    expect(due.some((d) => d.agentId === agent.id)).toBe(false);
  });

  it('skips a paused agent', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);
    await svc.pauseAgent(agent.id); // pause AFTER registering

    await scheduler.tick(new Date());
    expect(mockRunner.run).not.toHaveBeenCalled();
  });

  it('enforces daily budget — pauses agent when exhausted', async () => {
    const tightConfig: AgentConfig = {
      ...defaultConfig,
      budget: { daily: 0.005, monthly: 1, onExhaust: 'pause' },
    };
    // mockRunner costs $0.01 — over the $0.005 daily limit after 1 cycle
    const agent = await svc.createAgent({
      name: 'B',
      type: 'lead_hunter',
      config: tightConfig,
    });
    await svc.startAgent(agent.id);

    // Run one cycle manually to accumulate cost
    await svc.runCycle(agent.id, 'lead_search');

    // Register and tick 10h from now — cycle is due, budget is exceeded
    scheduler.register(agent.id, tightConfig);
    const tenHoursLater = new Date(Date.now() + 10 * 60 * 60 * 1000);
    await scheduler.tick(tenHoursLater);

    const fresh = svc.getAgent(agent.id);
    expect(fresh!.status).toBe('paused');
    // The scheduler tick should NOT have called runner again
    expect(mockRunner.run).toHaveBeenCalledOnce(); // only the manual runCycle above
  });

  // Regression: a started agent used to fire exactly one cycle, ever. runCycle
  // forced status to 'idle' when a cycle finished — the same value stopAgent()
  // writes — so tick's `status === 'running'` gate never matched again and the
  // agent was silently unscheduled. The whole scheduler suite was dead at the
  // time, so nothing caught it.
  it('keeps firing on every due tick, not just the first', async () => {
    const agent = await svc.createAgent({
      name: 'R',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, defaultConfig);

    await scheduler.tick(new Date(Date.now() + 5 * 60 * 60 * 1000));
    expect(svc.getAgent(agent.id)!.status).toBe('running'); // still enabled
    expect(mockRunner.run).toHaveBeenCalledTimes(1);

    await scheduler.tick(new Date(Date.now() + 10 * 60 * 60 * 1000));
    expect(mockRunner.run).toHaveBeenCalledTimes(2);
  });

  it('leaves a stopped agent stopped after a manual cycle', async () => {
    const agent = await svc.createAgent({
      name: 'M',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    // never started — a manual run must not silently enable it
    await svc.runCycle(agent.id, 'lead_search');

    expect(svc.getAgent(agent.id)!.status).toBe('idle');
  });

  it('does not error when runner throws — continues to next due entry', async () => {
    const failRunner: CycleRunner = {
      run: vi.fn(async () => {
        throw new Error('network error');
      }),
    };
    const failSvc = new AgentService(tmpDir, failRunner);
    const failScheduler = new AgentScheduler(failSvc);

    const agent = await failSvc.createAgent({
      name: 'C',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await failSvc.startAgent(agent.id);
    failScheduler.register(agent.id, defaultConfig);

    // Should not throw even though runner fails
    await expect(failScheduler.tick(new Date())).resolves.not.toThrow();
  });
});

// ─── initFromDb ──────────────────────────────────────────────────────────────

describe('initFromDb', () => {
  it('registers all running agents from the DB on startup', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    await svc.startAgent(agent.id);

    // Fresh scheduler — simulates server restart
    const freshScheduler = new AgentScheduler(svc);
    freshScheduler.initFromDb();

    const due = freshScheduler.getDueAgents(new Date());
    expect(due.some((d) => d.agentId === agent.id)).toBe(true);
  });

  it('does not register idle or paused agents', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    // left in idle state

    const freshScheduler = new AgentScheduler(svc);
    freshScheduler.initFromDb();

    expect(freshScheduler.getNextCycle(agent.id)).toBeNull();
  });
});

// ─── on-demand exemptions ────────────────────────────────────────────────────

/**
 * on_demand agents have their scheduled entries stripped, because "hire an agent to
 * do X on demand" means X does not fire on a timer. Two cycle types are exempt:
 * self_improve (memory/identity housekeeping) and checkin (reporting to the owner).
 *
 * Without the checkin exemption the failure is silent in the worst way — the entry
 * persists in config.schedule, the DB and the UI both look correct, and no report is
 * ever produced.
 */
describe('on_demand schedule filtering', () => {
  const onDemandConfig: AgentConfig = {
    ...defaultConfig,
    triggerMode: 'on_demand',
    schedule: [
      { type: 'lead_search', interval: '4h', enabled: true },
      { type: 'self_improve', interval: '7d', enabled: true },
      { type: 'checkin', interval: '7d', enabled: true },
    ],
  };

  it('drops primary work but keeps checkin and self_improve', async () => {
    const agent = await svc.createAgent({
      name: 'OD',
      type: 'lead_hunter',
      config: onDemandConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, onDemandConfig);

    const types = scheduler
      .getDueAgents(new Date())
      .filter((d) => d.agentId === agent.id)
      .map((d) => d.cycleType);

    expect(types).toContain('checkin');
    expect(types).toContain('self_improve');
    expect(types).not.toContain('lead_search');
  });

  it('keeps every entry for a scheduled agent', async () => {
    const config: AgentConfig = { ...onDemandConfig, triggerMode: 'scheduled' };
    const agent = await svc.createAgent({
      name: 'S',
      type: 'lead_hunter',
      config,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, config);

    const types = scheduler
      .getDueAgents(new Date())
      .filter((d) => d.agentId === agent.id)
      .map((d) => d.cycleType);

    expect(types).toContain('checkin');
    expect(types).toContain('lead_search');
  });
});

// ─── default schedule entries ────────────────────────────────────────────────

describe('createAgent default schedule', () => {
  it('adds a weekly checkin when the caller did not ask for one', async () => {
    const agent = await svc.createAgent({
      name: 'A',
      type: 'lead_hunter',
      config: defaultConfig,
    });
    const checkin = agent.config.schedule.find((s) => s.type === 'checkin');
    expect(checkin).toBeDefined();
    expect(checkin!.interval).toBe('7d');
    expect(checkin!.enabled).toBe(true);
  });

  it('does not duplicate an explicitly supplied checkin entry', async () => {
    const config: AgentConfig = {
      ...defaultConfig,
      schedule: [
        { type: 'lead_search', interval: '4h', enabled: true },
        { type: 'checkin', interval: '30d', enabled: false },
      ],
    };
    const agent = await svc.createAgent({
      name: 'B',
      type: 'lead_hunter',
      config,
    });
    const checkins = agent.config.schedule.filter((s) => s.type === 'checkin');
    expect(checkins).toHaveLength(1);
    expect(checkins[0].interval).toBe('30d'); // caller's choice wins
  });
});

// ─── Per-timer instructions (2026-09-24) ──────────────────────────────────────
//
// Before this, timers were keyed by cycle type and every one produced the same prompt, so an
// agent with three jobs at three times could neither hold two timers of one kind nor tell a
// run which job it was for.

describe('timers with their own instruction', () => {
  const threeJobs: AgentConfig = {
    ...defaultConfig,
    schedule: [
      {
        id: 'log',
        type: 'work',
        name: 'Hourly log',
        interval: '1h',
        enabled: true,
        instruction: 'Append to the log',
      },
      {
        id: 'report',
        type: 'work',
        name: '9 AM report',
        interval: '0 9 * * *',
        timezone: 'Asia/Kolkata',
        enabled: true,
        instruction: 'Build the xlsx and message me',
      },
      {
        id: 'email',
        type: 'work',
        name: 'Weekend email',
        interval: '0 10 * * 0,6',
        timezone: 'Asia/Kolkata',
        enabled: true,
        instruction: 'Email the owner a summary',
      },
    ],
  };

  it('tracks two timers of the same kind separately', async () => {
    const agent = await svc.createAgent({
      name: 'T',
      type: 'custom',
      config: threeJobs,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, threeJobs);
    const next = scheduler.getEntryNextRuns(agent.id);
    expect([...next.keys()].sort()).toEqual(['email', 'log', 'report']);
  });

  it("reads a cron in the timer's own zone: 9 AM Kolkata is 03:30 UTC", () => {
    const from = new Date('2026-09-24T00:00:00Z');
    const next = calcNextRun('0 9 * * *', from, from, 'Asia/Kolkata');
    expect(next.toISOString()).toBe('2026-09-24T03:30:00.000Z');
  });

  it('hands the run its timer: which one, its instruction, and when it fired', async () => {
    const agent = await svc.createAgent({
      name: 'T',
      type: 'custom',
      config: threeJobs,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, threeJobs);

    // Only the hourly timer is due right now (an interval with no history fires at once).
    await scheduler.tick(new Date());

    expect(mockRunner.run).toHaveBeenCalledOnce();
    const params = (mockRunner.run as any).mock.calls[0][0];
    expect(params.timer).toMatchObject({
      id: 'log',
      name: 'Hourly log',
      instruction: 'Append to the log',
    });
    expect(params.timer.lastRun).toBeNull();
  });

  it('records which timer started a cycle, so its next run sees its own history', async () => {
    const agent = await svc.createAgent({
      name: 'T',
      type: 'custom',
      config: threeJobs,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, threeJobs);
    await scheduler.tick(new Date());

    const result = scheduler.runNow(agent.id, 'log');
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(mockRunner.run).toHaveBeenCalledTimes(2));
    const second = (mockRunner.run as any).mock.calls[1][0];
    expect(second.timer.manual).toBe(true);
    expect(second.timer.lastRun?.status).toBe('completed');
  });

  it('refuses Run now for a timer that does not exist', async () => {
    const agent = await svc.createAgent({
      name: 'T',
      type: 'custom',
      config: threeJobs,
    });
    expect(scheduler.runNow(agent.id, 'nope')).toEqual({
      ok: false,
      error: 'No timer with id "nope"',
    });
  });
});

describe('failure streak alert', () => {
  it('tells the owner once after 3 failed runs of one timer, not on every failure after', async () => {
    const cfg: AgentConfig = {
      ...defaultConfig,
      schedule: [
        {
          id: 'flaky',
          type: 'work',
          name: 'Flaky job',
          interval: 'manual',
          enabled: false,
          instruction: 'x',
        },
      ],
    };
    const agent = await svc.createAgent({
      name: 'F',
      type: 'custom',
      config: cfg,
    });
    (mockRunner.run as any).mockImplementation(async () => {
      throw new Error('boom');
    });
    try {
      for (let i = 1; i <= 4; i++) {
        expect(scheduler.runNow(agent.id, 'flaky').ok).toBe(true);
        await vi.waitFor(() => expect(mockRunner.run).toHaveBeenCalledTimes(i));
        await new Promise((r) => setTimeout(r, 50)); // let the run settle and the check run
      }
      const alerts = notifyMock.mock.calls.filter((c) =>
        String(c[1]).includes('"Flaky job" failed 3 runs in a row'),
      );
      expect(alerts).toHaveLength(1);
    } finally {
      (mockRunner.run as any).mockImplementation(async () => ({
        summary: 'ok',
        cost: 0.01,
        tasksDone: 1,
      }));
    }
  });
});
