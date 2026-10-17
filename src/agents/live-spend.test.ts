import { describe, expect, it } from 'vitest';
import { LiveSpend, type LiveSpendDeps } from './live-spend.js';
import type { UsageBlock } from './nanobot-cycle-runner.js';

/** A fake agent_cycles table: rows started today, keyed by cycle id. */
function harness(
  opts: {
    budget?: number | null;
    cap?: number;
    otherSpendToday?: number;
    now?: () => Date;
  } = {},
) {
  const rows = new Map<
    string,
    { agentId: string; cost: number; running: boolean; today: boolean }
  >();
  const stops: Array<{ agentId: string; cycleId: string; why: string }> = [];
  const deps: LiveSpendDeps = {
    // $1 per 1,000 prompt tokens, or the provider's own figure when it gives one.
    price: (_m, u: UsageBlock) =>
      (u.reported_cost_usd ?? 0) > 0
        ? u.reported_cost_usd!
        : (u.prompt_tokens ?? 0) / 1000,
    persist: (id, cost) => {
      const r = rows.get(id);
      if (r?.running) r.cost = cost;
    },
    agentSpentToday: (agentId) =>
      (opts.otherSpendToday ?? 0) +
      [...rows.values()]
        .filter((r) => r.agentId === agentId && r.today)
        .reduce((s, r) => s + r.cost, 0),
    platformSpentToday: () =>
      (opts.otherSpendToday ?? 0) +
      [...rows.values()].filter((r) => r.today).reduce((s, r) => s + r.cost, 0),
    dailyBudget: () => (opts.budget === undefined ? 100 : opts.budget),
    platformCap: () => opts.cap ?? 0,
    stop: (agentId, cycleId, why) => {
      stops.push({ agentId, cycleId, why });
    },
    now: opts.now,
  };
  const spend = new LiveSpend(deps);
  const start = (agentId: string, cycleId: string, today = true) => {
    rows.set(cycleId, { agentId, cost: 0, running: true, today });
    spend.begin(agentId, cycleId, 'm');
  };
  return { spend, rows, stops, start };
}

describe('LiveSpend', () => {
  it('writes the running cost to the cycle row after every model call', () => {
    const h = harness();
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 2000 });
    expect(h.rows.get('c1')!.cost).toBe(2);
    h.spend.record('c1', { prompt_tokens: 5000 }); // cumulative, not a delta
    expect(h.rows.get('c1')!.cost).toBe(5);
  });

  // The bug this exists for: a cycle killed before its final result block was booked at $0.
  it('leaves the spend in the row when the cycle dies with no result', () => {
    const h = harness();
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 7300 });
    h.rows.get('c1')!.running = false; // watchdog / crash / restart marks it failed
    h.spend.end('c1');
    expect(h.rows.get('c1')!.cost).toBeCloseTo(7.3);
  });

  it("prefers the provider's billed figure", () => {
    const h = harness();
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 9000, reported_cost_usd: 0.42 });
    expect(h.rows.get('c1')!.cost).toBe(0.42);
  });

  it('banks a dead attempt so the retry adds to it instead of replacing it', () => {
    const h = harness();
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 3000 });
    h.spend.bank('c1'); // daemon died → one-shot starts from zero usage
    expect(h.spend.banked('c1')).toBe(3);
    h.spend.record('c1', { prompt_tokens: 1000 });
    expect(h.rows.get('c1')!.cost).toBe(4);
    expect(h.spend.cost('c1')).toBe(4);
  });

  it("stops a cycle once, when the agent's day crosses its budget mid-run", () => {
    const h = harness({ budget: 5, otherSpendToday: 2 });
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 2000 }); // 2 + 2 = 4 < 5
    expect(h.stops).toEqual([]);
    h.spend.record('c1', { prompt_tokens: 3500 }); // 2 + 3.5 = 5.5
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].why).toMatch(
      /daily budget is spent \(\$5\.50 of \$5\.00\)/,
    );
    expect(h.spend.stopReason('c1')).toBe(h.stops[0].why);
    h.spend.record('c1', { prompt_tokens: 3600 }); // the wrap-up call
    expect(h.stops).toHaveLength(1);
    expect(h.rows.get('c1')!.cost).toBe(3.6); // still accounted after the stop
  });

  it('honours the platform-wide cap across agents', () => {
    const h = harness({ budget: null, cap: 10 });
    h.start('a', 'c1');
    h.start('b', 'c2');
    h.spend.record('c1', { prompt_tokens: 6000 });
    expect(h.stops).toEqual([]);
    h.spend.record('c2', { prompt_tokens: 4500 });
    expect(h.stops.map((s) => s.cycleId)).toEqual(['c2']);
    expect(h.stops[0].why).toMatch(/platform's daily budget/);
  });

  it('with no budget and no cap, never stops', () => {
    const h = harness({ budget: null, cap: 0 });
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 10_000_000 });
    expect(h.stops).toEqual([]);
  });

  // A days-long cycle: its row is dated the day it started, so today's sum misses it.
  // Only what it spent since midnight counts against today.
  it("counts a cycle that crossed midnight against today for today's part only", () => {
    let now = new Date('2026-10-01T23:00:00');
    const h = harness({ budget: 5, now: () => now });
    h.start('a', 'c1');
    h.spend.record('c1', { prompt_tokens: 4000 }); // $4 on day 1
    now = new Date('2026-10-02T01:00:00');
    h.rows.get('c1')!.today = false; // its row now reads as yesterday's
    h.spend.record('c1', { prompt_tokens: 8000 }); // $4 more today
    expect(h.stops).toEqual([]);
    h.spend.record('c1', { prompt_tokens: 9500 }); // $5.50 today
    expect(h.stops).toHaveLength(1);
    expect(h.stops[0].why).toMatch(/\$5\.50 of \$5\.00/);
  });

  it('ignores events for cycles it is not tracking', () => {
    const h = harness();
    h.spend.record('nope', { prompt_tokens: 1000 });
    expect(h.spend.cost('nope')).toBe(0);
    expect(h.stops).toEqual([]);
  });
});
