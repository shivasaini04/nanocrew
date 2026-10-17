/**
 * What a cycle has spent while it is still running — and stopping it when that is too much.
 *
 * Until 2026-10-01 a cycle's cost was known only from its final result block. A cycle that
 * timed out, crashed, was killed by the liveness watchdog or lost to an orchestrator restart
 * never produced one, so it was booked at $0 however much it had spent; and a budget was
 * checked only before a cycle started, which was tolerable while every cycle died at 50
 * minutes and is not now that one may run for days (liveness.ts).
 *
 * The loop streams its cumulative usage after every model call (a `usage` progress event).
 * Each one is priced and written to the cycle's own row, so:
 *   - a cycle that dies for any reason keeps what it spent up to its last call;
 *   - today's spend, read from the rows, includes cycles still running — the mid-cycle
 *     budget check is the same query the pre-cycle gate uses;
 *   - the daemon → one-shot fallback re-runs a cycle from zero usage, so the dead attempt's
 *     spend is banked and added to the next one rather than replaced by it.
 *
 * A budget hit sets the agent's interrupt flag. The loop polls it every iteration and ends
 * the turn with a short summary of what it got done — a soft stop, one more call.
 */
import type { UsageBlock } from './nanobot-cycle-runner.js';

export interface LiveSpendDeps {
  price: (model: string, usage: UsageBlock) => number;
  /** Write the running cost to the cycle's row (only while it is still running). */
  persist: (cycleId: string, cost: number) => void;
  /** Spend on this agent's cycles started today, including running ones. */
  agentSpentToday: (agentId: string) => number;
  /** Spend on every cycle started today, including running ones. */
  platformSpentToday: () => number;
  /** The agent's daily budget, read fresh so a raise mid-cycle counts. null = none. */
  dailyBudget: (agentId: string) => number | null;
  /** GLOBAL_DAILY_BUDGET_USD, 0 = none. */
  platformCap: () => number;
  stop: (agentId: string, cycleId: string, why: string) => void;
  now?: () => Date;
}

interface Entry {
  agentId: string;
  model: string;
  usage: UsageBlock;
  banked: number;
  /** Local day the cycle started on, and the day of its last usage event. */
  startDay: string;
  day: string;
  /** Cost when `day` began — a cycle that crosses midnight counts only today's part today. */
  costAtDayStart: number;
  stopped?: string;
}

const dayKey = (d: Date) => d.toDateString();

export class LiveSpend {
  private readonly cycles = new Map<string, Entry>();
  private readonly now: () => Date;

  constructor(private readonly deps: LiveSpendDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  begin(agentId: string, cycleId: string, model: string): void {
    const day = dayKey(this.now());
    this.cycles.set(cycleId, {
      agentId,
      model,
      usage: {},
      banked: 0,
      startDay: day,
      day,
      costAtDayStart: 0,
    });
  }

  /** banked + what the current attempt has spent so far. 0 for an unknown cycle. */
  cost(cycleId: string): number {
    const e = this.cycles.get(cycleId);
    return e ? e.banked + this.deps.price(e.model, e.usage) : 0;
  }

  /** What earlier, dead attempts of this cycle spent. */
  banked(cycleId: string): number {
    return this.cycles.get(cycleId)?.banked ?? 0;
  }

  /** The current attempt died and the cycle is starting over from zero usage. */
  bank(cycleId: string): void {
    const e = this.cycles.get(cycleId);
    if (!e) return;
    e.banked += this.deps.price(e.model, e.usage);
    e.usage = {};
  }

  /** Why this cycle was stopped for money, if it was. */
  stopReason(cycleId: string): string | undefined {
    return this.cycles.get(cycleId)?.stopped;
  }

  /** A `usage` progress event: the current attempt's cumulative usage. */
  record(cycleId: string, usage: UsageBlock): void {
    const e = this.cycles.get(cycleId);
    if (!e) return;
    const before = this.cost(cycleId);
    const today = dayKey(this.now());
    if (e.day !== today) {
      e.costAtDayStart = before;
      e.day = today;
    }
    e.usage = usage;
    const cost = this.cost(cycleId);
    try {
      this.deps.persist(cycleId, cost);
    } catch {
      /* accounting must not break the cycle */
    }
    if (e.stopped) return;
    const why = this.overBudget(cycleId, e, today);
    if (why) {
      e.stopped = why;
      this.deps.stop(e.agentId, cycleId, why);
    }
  }

  end(cycleId: string): void {
    this.cycles.delete(cycleId);
  }

  /** Today's spend of a cycle that started on an earlier day — its row is not in today's sum. */
  private carriedIntoToday(cycleId: string, e: Entry, today: string): number {
    return e.startDay === today
      ? 0
      : Math.max(0, this.cost(cycleId) - e.costAtDayStart);
  }

  private overBudget(cycleId: string, e: Entry, today: string): string | null {
    const budget = this.deps.dailyBudget(e.agentId);
    if (budget !== null) {
      const spent =
        this.deps.agentSpentToday(e.agentId) +
        this.carriedIntoToday(cycleId, e, today);
      if (spent >= budget)
        return `the agent's daily budget is spent ($${spent.toFixed(2)} of $${budget.toFixed(2)})`;
    }
    const cap = this.deps.platformCap();
    if (cap > 0) {
      let spent = this.deps.platformSpentToday();
      for (const [id, x] of this.cycles)
        spent += this.carriedIntoToday(id, x, today);
      if (spent >= cap)
        return `the platform's daily budget is spent ($${spent.toFixed(2)} of $${cap.toFixed(2)})`;
    }
    return null;
  }
}
