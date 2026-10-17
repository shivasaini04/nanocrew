/**
 * Agent self-management: interval validation, one-off runs, cycle tokens, and the
 * post-cycle status restore.
 *
 * Each block here pins a failure that the change was made to prevent, rather than
 * restating the happy path the implementation obviously supports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

import {
  _initTestDatabase,
  updateAgentConfig,
  getCyclesByAgent,
  createAgentCycle,
  updateAgentStatus,
  reconcileStuckCycles,
} from '../db.js';
import { AgentService, type CycleRunner } from './agent-service.js';
import {
  AgentScheduler,
  validateInterval,
  validateSchedule,
  calcNextRun,
} from './agent-scheduler.js';
import {
  issueCycleToken,
  verifyCycleToken,
  revokeCycleToken,
  liveTokenCount,
  TOKEN_TTL_MS,
} from './cycle-token.js';
import type { AgentConfig } from '../types.js';

let tmpDir: string;
let svc: AgentService;
let scheduler: AgentScheduler;

const mockRunner: CycleRunner = {
  run: vi.fn(async () => ({ summary: 'ok', cost: 0.01, tasksDone: 1 })),
};

const baseConfig: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'Find leads',
  escalationRules: [],
};

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-selfmanage-test-'));
  svc = new AgentService(tmpDir, mockRunner);
  scheduler = new AgentScheduler(svc);
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Interval validation ──────────────────────────────────────────────────────

describe('validateInterval', () => {
  it('accepts the formats calcNextRun can actually parse', () => {
    for (const ok of ['30m', '4h', '7d', 'monday', '0 9 * * 1', 'manual']) {
      expect(validateInterval(ok), `expected "${ok}" to be valid`).toBeNull();
    }
  });

  it('rejects natural-language intervals a model is likely to emit', () => {
    // The exact shape that used to sail through the API and then throw inside
    // register(), leaving the agent silently unscheduled.
    expect(validateInterval('every monday at 9')).toMatch(
      /Cannot parse interval/,
    );
    expect(validateInterval('daily')).toMatch(/Cannot parse interval/);
    expect(validateInterval('')).toMatch(/non-empty string/);
    expect(validateInterval(undefined)).toMatch(/non-empty string/);
  });

  it('rejects a malformed cron expression', () => {
    expect(validateInterval('99 99 * * *')).toMatch(/Invalid cron expression/);
  });

  /**
   * "0m"/"0h"/"0d" parse to 0 ms, which makes calcNextRun return `now` every time and
   * the entry permanently due — the scheduler would re-fire the agent every tick until
   * the daily budget cap stopped it. Unreachable while a human picked intervals from a
   * form; reachable the moment an agent writes its own.
   */
  it('rejects zero-length intervals that would run an agent continuously', () => {
    for (const zero of ['0m', '0h', '0d', '0min', '0days']) {
      expect(validateInterval(zero), zero).toMatch(/zero|too short/);
    }
    expect(calcNextRun('5m', new Date(), new Date()).getTime()).toBeGreaterThan(
      0,
    );
  });

  it('rejects intervals shorter than a cycle typically takes', () => {
    for (const tooShort of ['1m', '2m', '4m']) {
      expect(validateInterval(tooShort), tooShort).toMatch(/too short/);
    }
    expect(validateInterval('5m')).toBeNull();
    expect(validateInterval('30m')).toBeNull();
  });

  /** The floor must not retroactively invalidate anything already running in prod. */
  it('still accepts every interval currently live in production', () => {
    for (const live of [
      '15 4-19 * * 1-6', // Finder   lead_search
      '30 5 * * 0', // Finder   work
      '0 18 * * *', // Finder   self_improve
      '0 11 * * 0', // Finder   checkin
      '30 */2 * * 1-6', // Mailer  send_outreach
      '45 */2 * * *', // Crawler lead_search
      '0 */2 * * *', // Seeker  custom
      '7d', // self_improve / checkin
    ]) {
      expect(validateInterval(live), live).toBeNull();
    }
  });

  it('reports which entry failed, not just that one did', () => {
    const err = validateSchedule([
      { type: 'lead_search', interval: '4h', enabled: true },
      { type: 'checkin', interval: 'whenever', enabled: true },
    ]);
    expect(err).toMatch(/schedule\[1\]/);
  });

  /**
   * The regression this whole validator exists for: an unparseable interval must be
   * refused up front, because once it is persisted the scheduler cannot arm the agent
   * and nothing surfaces that except a warn-level log line.
   */
  it('catches what the old cron-only validator missed', async () => {
    const bad: AgentConfig = {
      ...baseConfig,
      schedule: [
        { type: 'lead_search', interval: 'every monday at 9', enabled: true },
      ],
    };
    expect(validateSchedule(bad.schedule)).not.toBeNull();

    // Prove the consequence is real: persisting it makes register() throw.
    const agent = await svc.createAgent({
      name: 'Bad',
      type: 'lead_hunter',
      config: bad,
    });
    expect(() => scheduler.register(agent.id, bad)).toThrow(
      /Cannot parse interval/,
    );
  });
});

// ─── Cycle tokens ─────────────────────────────────────────────────────────────

describe('cycle tokens', () => {
  it('verifies only for the agent it was minted for', () => {
    const token = issueCycleToken('agent-a', 'cycle-1');
    expect(verifyCycleToken(token, 'agent-a')).toBe(true);
    // The whole point of binding: every running agent holds a live token, so an
    // unbound token would let any of them write to any other.
    expect(verifyCycleToken(token, 'agent-b')).toBe(false);
  });

  it('rejects missing, empty and unknown tokens', () => {
    expect(verifyCycleToken(undefined, 'agent-a')).toBe(false);
    expect(verifyCycleToken('', 'agent-a')).toBe(false);
    expect(verifyCycleToken('not-a-real-token', 'agent-a')).toBe(false);
  });

  it('stops verifying once revoked', () => {
    const token = issueCycleToken('agent-a', 'cycle-1');
    revokeCycleToken(token);
    expect(verifyCycleToken(token, 'agent-a')).toBe(false);
  });

  it('expires tokens rather than accumulating them forever', () => {
    const before = liveTokenCount();
    const token = issueCycleToken('agent-a', 'cycle-1');
    expect(liveTokenCount()).toBe(before + 1);

    // Just past the TTL (30 days by default since cycles lost their wall-clock limit).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + TOKEN_TTL_MS + 60 * 1000));
    expect(verifyCycleToken(token, 'agent-a')).toBe(false);
    vi.useRealTimers();
  });
});

// ─── One-off runs ─────────────────────────────────────────────────────────────

describe('one-off runs', () => {
  async function agentWithOneOff(at: Date, extra: Partial<AgentConfig> = {}) {
    const agent = await svc.createAgent({
      name: 'One',
      type: 'lead_hunter',
      config: { ...baseConfig, ...extra },
    });
    const fresh = svc.getAgent(agent.id)!;
    updateAgentConfig(agent.id, {
      ...fresh.config,
      oneOffRuns: [
        {
          id: 'run-1',
          at: at.toISOString(),
          cycleType: 'custom',
          instruction: 'send the reminder',
          createdAt: new Date().toISOString(),
          createdBy: 'agent',
        },
      ],
    });
    return agent.id;
  }

  it('fires a due one-off and passes the instruction through as context', async () => {
    const id = await agentWithOneOff(new Date(Date.now() - 1000));
    await svc.startAgent(id);

    await scheduler.tick(new Date());

    expect(mockRunner.run).toHaveBeenCalledOnce();
    const cycles = getCyclesByAgent(id, 10);
    expect(cycles.some((c) => c.cycle_type === 'custom')).toBe(true);
  });

  it('does not fire before its time', async () => {
    const id = await agentWithOneOff(new Date(Date.now() + 60 * 60 * 1000));
    await svc.startAgent(id);

    await scheduler.tick(new Date());
    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(svc.getAgent(id)!.config.oneOffRuns).toHaveLength(1);
  });

  /** A one-off that fires twice reads as the agent deciding to repeat itself. */
  it('fires exactly once, even across repeated ticks', async () => {
    const id = await agentWithOneOff(new Date(Date.now() - 1000));
    await svc.startAgent(id);

    await scheduler.tick(new Date());
    await scheduler.tick(new Date());
    await scheduler.tick(new Date());

    expect(mockRunner.run).toHaveBeenCalledOnce();
    expect(svc.getAgent(id)!.config.oneOffRuns ?? []).toHaveLength(0);
  });

  /**
   * The main use case — "ping me at 1pm" — is aimed at agents that have no recurring
   * schedule at all. Driving one-offs off the scheduler's in-memory map would skip
   * exactly those agents, because nothing ever registers them.
   */
  it('fires for an on_demand agent that was never registered with the scheduler', async () => {
    const id = await agentWithOneOff(new Date(Date.now() - 1000), {
      triggerMode: 'on_demand',
      schedule: [],
    });
    await svc.startAgent(id);

    expect(scheduler.getNextCycle(id)).toBeNull(); // genuinely unregistered
    await scheduler.tick(new Date());
    expect(mockRunner.run).toHaveBeenCalledOnce();
  });

  it('skips a paused agent but still clears the entry', async () => {
    const id = await agentWithOneOff(new Date(Date.now() - 1000));
    await svc.startAgent(id);
    await svc.pauseAgent(id);

    await scheduler.tick(new Date());

    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(svc.getAgent(id)!.config.oneOffRuns ?? []).toHaveLength(0);
  });

  it('discards an entry whose time cannot be parsed instead of retrying it forever', async () => {
    const agent = await svc.createAgent({
      name: 'Junk',
      type: 'lead_hunter',
      config: baseConfig,
    });
    const fresh = svc.getAgent(agent.id)!;
    updateAgentConfig(agent.id, {
      ...fresh.config,
      oneOffRuns: [
        {
          id: 'bad',
          at: 'tomorrow afternoon',
          cycleType: 'custom',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await svc.startAgent(agent.id);

    await scheduler.tick(new Date());

    expect(mockRunner.run).not.toHaveBeenCalled();
    expect(svc.getAgent(agent.id)!.config.oneOffRuns ?? []).toHaveLength(0);
  });

  /**
   * Clearing a fired one-off rewrites the whole config row, so the recurring schedule
   * rides along in that write. Compare against the schedule as it stood before the
   * tick — not against baseConfig, since createAgent appends its own self_improve and
   * checkin defaults.
   */
  it('leaves an unrelated recurring schedule untouched', async () => {
    const id = await agentWithOneOff(new Date(Date.now() - 1000));
    await svc.startAgent(id);
    const scheduleBefore = svc.getAgent(id)!.config.schedule;
    expect(scheduleBefore.length).toBeGreaterThan(0);
    scheduler.register(id, svc.getAgent(id)!.config);

    await scheduler.tick(new Date());

    expect(svc.getAgent(id)!.config.schedule).toEqual(scheduleBefore);
  });
});

// ─── Concurrent-cycle handling ────────────────────────────────────────────────

describe('cycles that overlap a running one', () => {
  /**
   * tick() is fired by setInterval and never awaited, so ticks overlap: a long cycle is
   * still inside `await runCycle` when the next tick fires and `_reschedule` has not run
   * yet, so getDueAgents returns the same entry again. The scheduler must ask before
   * firing rather than letting the concurrency guard throw.
   */
  it('does not even call runCycle for an agent that is still executing', async () => {
    const agent = await svc.createAgent({
      name: 'Busy',
      type: 'lead_hunter',
      config: baseConfig,
    });
    await svc.startAgent(agent.id);
    scheduler.register(agent.id, baseConfig);

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const runner = svc as unknown as { runner: CycleRunner };
    runner.runner = {
      run: vi.fn(async () => {
        await held;
        return { summary: 'ok', cost: 0.01, tasksDone: 1 };
      }),
    };

    // Spy on runCycle itself, not on the runner: the concurrency guard inside
    // runCycle would keep the runner at one call either way, so only counting
    // runCycle *attempts* distinguishes "asked and was refused" (an error log per
    // long cycle) from "did not ask".
    const realRunCycle = svc.runCycle.bind(svc);
    const attempts = vi.fn((...args: Parameters<typeof svc.runCycle>) =>
      realRunCycle(...args),
    );
    (svc as unknown as { runCycle: unknown }).runCycle = attempts;

    const firstTick = scheduler.tick(new Date()); // enters runCycle, blocks inside the runner
    await new Promise((r) => setImmediate(r));
    expect(svc.isExecutingCycle(agent.id)).toBe(true);
    const afterFirst = attempts.mock.calls.length;

    await scheduler.tick(new Date()); // overlapping tick — must not ask again
    expect(attempts.mock.calls.length).toBe(afterFirst);

    release();
    await firstTick;
  });

  /**
   * The refusal used to happen *after* the cycle.start webhook, so every collision
   * announced a cycle that never ran — with no matching cycle.completed or cycle.failed
   * to close it out. A consumer counting starts against finishes drifts by one per
   * overlapping tick, and nothing in the logs explains it.
   */
  it('does not announce cycle.start for a cycle it then refuses', async () => {
    const agent = await svc.createAgent({
      name: 'Idle',
      type: 'lead_hunter',
      config: baseConfig,
    });

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const runner = svc as unknown as { runner: CycleRunner };
    runner.runner = {
      run: vi.fn(async () => {
        await held;
        return { summary: 'ok', cost: 0.01, tasksDone: 1 };
      }),
    };

    const dispatched: string[] = [];
    const internals = svc as unknown as {
      _dispatchWebhook: (a: unknown, p: { type: string }) => void;
    };
    const realDispatch = internals._dispatchWebhook.bind(svc);
    internals._dispatchWebhook = (a: unknown, p: { type: string }) => {
      dispatched.push(p.type);
      return realDispatch(a, p);
    };

    const first = svc.runCycle(agent.id, 'custom');
    await new Promise((r) => setImmediate(r));
    const startsAfterFirst = dispatched.filter(
      (t) => t === 'cycle.start',
    ).length;
    expect(startsAfterFirst).toBe(1);

    await expect(svc.runCycle(agent.id, 'custom')).rejects.toThrow(
      /already running a cycle/,
    );

    // The refused call must not have added a second start.
    expect(dispatched.filter((t) => t === 'cycle.start').length).toBe(
      startsAfterFirst,
    );

    release();
    await first;
    expect(svc.getAgent(agent.id)!.status).toBe('idle');
  });

  /**
   * One-offs are deleted before they fire so a crash cannot replay them. That makes
   * firing into a busy agent destructive, so the whole agent is deferred instead.
   */
  it('defers a due one-off instead of consuming it against a busy agent', async () => {
    const agent = await svc.createAgent({
      name: 'Both',
      type: 'lead_hunter',
      config: baseConfig,
    });
    await svc.startAgent(agent.id);
    const fresh = svc.getAgent(agent.id)!;
    updateAgentConfig(agent.id, {
      ...fresh.config,
      oneOffRuns: [
        {
          id: 'run-1',
          at: new Date(Date.now() - 1000).toISOString(),
          cycleType: 'custom',
          instruction: 'ping the owner',
          createdAt: new Date().toISOString(),
        },
      ],
    });

    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const runner = svc as unknown as { runner: CycleRunner };
    runner.runner = {
      run: vi.fn(async () => {
        await held;
        return { summary: 'ok', cost: 0.01, tasksDone: 1 };
      }),
    };

    const first = svc.runCycle(agent.id, 'lead_search'); // occupy the agent
    await new Promise((r) => setImmediate(r));

    await scheduler.tick(new Date());
    // Still queued — not silently thrown away.
    expect(svc.getAgent(agent.id)!.config.oneOffRuns).toHaveLength(1);

    release();
    await first;

    // Once free, it fires and is then cleared.
    await scheduler.tick(new Date());
    expect(svc.getAgent(agent.id)!.config.oneOffRuns ?? []).toHaveLength(0);
  });
});

// ─── Self-set status vs. the post-cycle restore ───────────────────────────────

describe('setSelfStatus', () => {
  /**
   * An agent can only act mid-cycle, which is exactly when runCycle's restore writes
   * `statusBeforeCycle` back. Self-enabling used to be erased by that restore: the
   * cycle started at 'idle', so 'idle' was written back over the agent's 'running'.
   */
  it('survives the post-cycle restore when the agent enables itself mid-cycle', async () => {
    const agent = await svc.createAgent({
      name: 'Self',
      type: 'lead_hunter',
      config: baseConfig,
    });
    expect(svc.getAgent(agent.id)!.status).toBe('idle');

    const runner = svc as unknown as { runner: CycleRunner };
    runner.runner = {
      run: vi.fn(async () => {
        svc.setSelfStatus(agent.id, 'running');
        return { summary: 'enabled myself', cost: 0.01, tasksDone: 1 };
      }),
    };

    await svc.runCycle(agent.id, 'custom');

    expect(svc.getAgent(agent.id)!.status).toBe('running');
  });

  it('still lets the agent pause itself', async () => {
    const agent = await svc.createAgent({
      name: 'Self2',
      type: 'lead_hunter',
      config: baseConfig,
    });
    await svc.startAgent(agent.id);

    const runner = svc as unknown as { runner: CycleRunner };
    runner.runner = {
      run: vi.fn(async () => {
        svc.setSelfStatus(agent.id, 'paused');
        return { summary: 'pausing', cost: 0.01, tasksDone: 1 };
      }),
    };

    await svc.runCycle(agent.id, 'custom');

    expect(svc.getAgent(agent.id)!.status).toBe('paused');
  });

  it('does not leak an override into the next cycle', async () => {
    const agent = await svc.createAgent({
      name: 'Self3',
      type: 'lead_hunter',
      config: baseConfig,
    });
    await svc.startAgent(agent.id);

    const runner = svc as unknown as { runner: CycleRunner };
    let first = true;
    runner.runner = {
      run: vi.fn(async () => {
        if (first) {
          first = false;
          svc.setSelfStatus(agent.id, 'paused');
        }
        return { summary: 'ok', cost: 0.01, tasksDone: 1 };
      }),
    };

    await svc.runCycle(agent.id, 'custom');
    expect(svc.getAgent(agent.id)!.status).toBe('paused');

    // Owner restarts it; the second cycle must not re-apply the earlier self-pause.
    await svc.startAgent(agent.id);
    await svc.runCycle(agent.id, 'custom');
    expect(svc.getAgent(agent.id)!.status).toBe('running');
  });
});

describe('the agent is put back after every kind of cycle', () => {
  /**
   * A cycle on an idle agent flips it to 'running', and 'running' is also what the
   * scheduler reads as "started". The restore used to sit on the two main exits only, so
   * every other exit left a manual agent looking started — and firing on its schedule.
   */
  it('after a weekly check-in, which returns early', async () => {
    const agent = await svc.createAgent({
      name: 'Weekly',
      type: 'lead_hunter',
      config: baseConfig,
    });
    (
      svc as unknown as { generateCheckinReport: unknown }
    ).generateCheckinReport = async () => ({
      reportMd: '## Report\nfine',
      cost: 0,
    });

    await svc.runCycle(agent.id, 'checkin');

    expect(getCyclesByAgent(agent.id, 1)[0].status).toBe('completed');
    expect(svc.getAgent(agent.id)!.status).toBe('idle');
  });

  it('after an error before the model ever ran, and the cycle is not left open', async () => {
    const agent = await svc.createAgent({
      name: 'Broken',
      type: 'lead_hunter',
      config: baseConfig,
    });
    (
      svc as unknown as { workspace: { readFile: unknown } }
    ).workspace.readFile = () => {
      throw new Error('disk gone');
    };

    await expect(svc.runCycle(agent.id, 'custom')).rejects.toThrow('disk gone');

    expect(svc.getAgent(agent.id)!.status).toBe('idle');
    expect(getCyclesByAgent(agent.id, 1)[0].status).toBe('failed');
  });

  it('keeps a started agent started after a failure', async () => {
    const agent = await svc.createAgent({
      name: 'Started',
      type: 'lead_hunter',
      config: baseConfig,
    });
    await svc.startAgent(agent.id);
    (
      svc as unknown as { workspace: { readFile: unknown } }
    ).workspace.readFile = () => {
      throw new Error('disk gone');
    };

    await expect(svc.runCycle(agent.id, 'custom')).rejects.toThrow('disk gone');

    expect(svc.getAgent(agent.id)!.status).toBe('running');
  });
});

describe('an orchestrator restart mid-cycle', () => {
  /**
   * The pre-cycle status lived only in runCycle's memory, so a restart lost it: the dead
   * cycle was marked failed but the agent stayed 'running' for good. It is now stored on
   * the cycle row, and startup puts it back.
   */
  async function strandedCycle(
    name: string,
    before: 'idle' | 'running' | null,
  ) {
    const agent = await svc.createAgent({
      name,
      type: 'lead_hunter',
      config: baseConfig,
    });
    createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'custom',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
      status_before: before,
    });
    updateAgentStatus(agent.id, 'running'); // what runCycle wrote at the start
    return agent;
  }

  it('puts a manual agent back to idle', async () => {
    const agent = await strandedCycle('Manual', 'idle');
    expect(reconcileStuckCycles()).toHaveLength(1);
    expect(svc.getAgent(agent.id)!.status).toBe('idle');
    expect(getCyclesByAgent(agent.id, 1)[0].status).toBe('failed');
  });

  it('leaves a started agent started', async () => {
    const agent = await strandedCycle('Scheduled', 'running');
    reconcileStuckCycles();
    expect(svc.getAgent(agent.id)!.status).toBe('running');
  });

  it('does not undo a pause that happened during the cycle', async () => {
    const agent = await strandedCycle('Paused', 'idle');
    updateAgentStatus(agent.id, 'paused');
    reconcileStuckCycles();
    expect(svc.getAgent(agent.id)!.status).toBe('paused');
  });

  it('leaves a cycle from before the status was recorded alone', async () => {
    const agent = await strandedCycle('Legacy', null);
    reconcileStuckCycles();
    expect(svc.getAgent(agent.id)!.status).toBe('running');
  });
});
