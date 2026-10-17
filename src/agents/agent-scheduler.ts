import {
  getAllAgents,
  getCyclesByAgent,
  getCycleCostToday,
  updateAgentStatus,
  updateAgentConfig,
  getFastlanePending,
  clearFastlane,
  getPendingHandoffsByAgent,
} from '../db.js';
import { recordConfigAudit } from '../db.js';
import type {
  AgentConfig,
  CycleType,
  OneOffRun,
  ScheduleEntryConfig,
  TimerContext,
} from '../types.js';
import { notify } from '../notifications.js';
import { randomUUID } from 'crypto';
import type { AgentService } from './agent-service.js';
import { getSocketIO } from '../api/instances.js';
import { CronExpressionParser } from 'cron-parser';
import { logger } from '../logger.js';

// ─── Interval parsing ─────────────────────────────────────────────────────────

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

/** Returns true if the string looks like a 5-field cron expression. */
function isCronExpression(s: string): boolean {
  return /^[\d*,\-\/]+(?: [\d*,\-\/]+){4}$/.test(s.trim());
}

/**
 * Parse an interval string into milliseconds.
 * Supports: "1h", "4h", "12h", "24h", "7d", "monday", "tuesday", ... etc.
 * Returns null for day-of-week strings and cron expressions (handled separately).
 */
export function parseIntervalMs(interval: string): number | null {
  // Spaces, full words and a leading "every" are accepted: models write "1 hour" and
  // "every 30 minutes", and refusing those cost a failed call and a retry each time.
  const lower = interval
    .trim()
    .toLowerCase()
    .replace(/^every\s+/, '');

  const minMatch = lower.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (minMatch) return parseInt(minMatch[1], 10) * 60 * 1000;

  const hourMatch = lower.match(/^(\d+)\s*h(?:rs?|ours?)?$/);
  if (hourMatch) return parseInt(hourMatch[1], 10) * 60 * 60 * 1000;

  const dayMatch = lower.match(/^(\d+)\s*d(?:ays?)?$/);
  if (dayMatch) return parseInt(dayMatch[1], 10) * 24 * 60 * 60 * 1000;

  if (DAY_NAMES.includes(lower)) return null; // day-of-week: special case
  if (isCronExpression(interval)) return null; // cron expression: special case

  return null;
}

/**
 * Get the next occurrence of a day-of-week (e.g. "monday") at 09:00 local time.
 * Always returns a future date (at least tomorrow if today is the same day).
 */
export function nextWeekday(dayName: string, from: Date = new Date()): Date {
  const targetDay = DAY_NAMES.indexOf(dayName.toLowerCase());
  if (targetDay === -1) throw new Error(`Unknown day name: ${dayName}`);

  const result = new Date(from);
  result.setHours(9, 0, 0, 0);

  // Advance until we hit the target weekday (always at least 1 day ahead)
  do {
    result.setDate(result.getDate() + 1);
  } while (result.getDay() !== targetDay);

  return result;
}

/**
 * Calculate the next run time for a given interval, given the last run time.
 * If lastRun is null (never run), next run is "now" (immediately due).
 *
 * Supports:
 *   - "4h", "12h", "7d" — simple duration intervals
 *   - "monday", "friday" — weekly day-of-week at 09:00
 *   - "0 9 * * 1"       — standard 5-field cron expressions
 */
export function calcNextRun(
  interval: string,
  lastRun: Date | null,
  now: Date = new Date(),
  timezone = 'UTC',
): Date {
  const lower = interval.trim().toLowerCase();

  if (DAY_NAMES.includes(lower)) {
    if (lastRun === null) return now; // due immediately on first registration
    return nextWeekday(lower, now);
  }

  if (isCronExpression(interval)) {
    // For cron: compute next fire after lastRun (or now if never run)
    const from = lastRun ?? now;
    try {
      // Always an explicit zone: the timer's own, or UTC. Without `tz` the parser uses the
      // host's zone — UTC in prod, IST on a dev machine — so the same entry fired at
      // different hours depending on where the orchestrator ran.
      const iter = CronExpressionParser.parse(interval, {
        currentDate: from,
        tz: timezone || 'UTC',
      });
      return iter.next().toDate();
    } catch {
      throw new Error(`Invalid cron expression: ${interval}`);
    }
  }

  const ms = parseIntervalMs(interval);
  if (ms === null) throw new Error(`Cannot parse interval: ${interval}`);

  if (lastRun === null) return now; // due immediately
  return new Date(lastRun.getTime() + ms);
}

/**
 * Why a schedule entry will not fire, or null if it will.
 *
 * Three independent switches decide it, and each one used to fail silently: an entry can
 * read perfectly in the config and still never run. Everything that tells a human or an
 * agent "your schedule is set" should go through this, so they all give the same answer
 * the scheduler would.
 */
export type EntryBlock =
  | 'disabled'
  | 'manual'
  | 'trigger_mode'
  | 'agent_not_running';

export function whyEntryWontFire(
  entry: { type: string; interval?: string; enabled?: boolean },
  agent: { status: string; config: { triggerMode?: string } },
): EntryBlock | null {
  if (!entry.interval || entry.interval.trim().toLowerCase() === 'manual')
    return 'manual';
  if (!entry.enabled) return 'disabled';
  const onDemand =
    agent.config.triggerMode === 'on_demand' ||
    agent.config.triggerMode === 'event_driven';
  if (onDemand && entry.type !== 'self_improve' && entry.type !== 'checkin')
    return 'trigger_mode';
  if (agent.status !== 'running') return 'agent_not_running';
  return null;
}

/**
 * Shortest duration-style interval a schedule entry may use. See validateInterval for
 * why this exists. Chosen against measured cycle durations (median 1.3 min for `custom`,
 * 6 min for `lead_search`) so a legal interval has a fair chance of finishing before the
 * next one is due; the scheduler's own 60 s poll is the hard floor beneath that.
 */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MIN_INTERVAL_LABEL = '5m';

/**
 * Validate a schedule interval string the way the scheduler will actually read it.
 * Returns an error message, or null when the interval is usable.
 *
 * This exists because the API used to validate a field that does not exist. The old
 * `validateScheduleCrons` checked `entry.cron` — nothing in the codebase writes that
 * key and `register()` has always read `entry.interval` — so every schedule write was
 * effectively unvalidated. The failure that hid behind it: an unparseable interval is
 * accepted with a 200, `calcNextRun` throws inside `register()`, the PATCH handler
 * catches it and logs `Schedule re-register failed` at warn level, and the agent is
 * now unscheduled with a config that still looks correct. Same shape as every other
 * silent-stop in this codebase — the evidence is an absence.
 *
 * That was tolerable while humans typed intervals into a form with a dropdown. It is
 * not tolerable now that an agent can write its own schedule from a chat message,
 * where "every monday at 9" is exactly the sort of thing a model produces.
 */
export function validateInterval(interval: unknown): string | null {
  if (typeof interval !== 'string' || !interval.trim()) {
    return `interval must be a non-empty string, got ${typeof interval}`;
  }
  const raw = interval.trim();
  const lower = raw.toLowerCase();

  // Duration floor. Two distinct hazards, both newly reachable now that an agent can
  // write its own interval from a chat message rather than a human picking one in a form:
  //
  //   "0m" / "0h" / "0d" parse to 0 ms, so calcNextRun returns `now` on every call and
  //   the entry is permanently due — the scheduler re-fires that agent every tick,
  //   forever, bounded only by the daily budget cap.
  //
  //   Anything under a few minutes collides with itself: measured medians are 1.3 min
  //   (custom) and 6 min (lead_search), so each new cycle starts while the previous one
  //   is still running, gets refused by the runningCycles guard, and logs an error.
  //
  // Below SCHEDULER_POLL_INTERVAL the number is a fiction anyway — the loop only wakes
  // once a minute. Cron expressions are exempt: their granularity is already one minute
  // and there is no zero-valued cron.
  const ms = parseIntervalMs(raw);
  if (ms !== null && ms < MIN_INTERVAL_MS) {
    return ms === 0
      ? `Interval "${raw}" is zero, which would run this agent continuously. Use at least ${MIN_INTERVAL_LABEL}.`
      : `Interval "${raw}" is too short — cycles routinely take longer than that and would overlap. Use at least ${MIN_INTERVAL_LABEL}.`;
  }

  // 'manual' is the documented opt-out — register() filters these out rather than
  // parsing them, so accept it here instead of failing it as an unknown format.
  if (lower === 'manual') return null;
  if (DAY_NAMES.includes(lower)) return null;

  if (isCronExpression(raw)) {
    try {
      CronExpressionParser.parse(raw);
      return null;
    } catch {
      return `Invalid cron expression: "${raw}"`;
    }
  }

  if (parseIntervalMs(raw) !== null) return null;

  return (
    `Cannot parse interval "${raw}". Use a duration ("30m", "4h", "7d"), ` +
    `a weekday ("monday"), a 5-field cron expression ("0 9 * * 1"), or "manual".`
  );
}

/**
 * Validate a whole `config.schedule` array. Returns an error message, or null.
 * Shared by the owner-facing PATCH route and the agent-facing self-management route
 * so the two cannot drift apart.
 */
export function validateSchedule(schedule: unknown): string | null {
  if (!Array.isArray(schedule)) return 'schedule must be an array';
  const ids = new Set<string>();
  for (const [i, entry] of schedule.entries()) {
    if (!entry || typeof entry !== 'object')
      return `schedule[${i}] must be an object`;
    const e = entry as {
      type?: unknown;
      interval?: unknown;
      enabled?: unknown;
      id?: unknown;
      name?: unknown;
      instruction?: unknown;
      timezone?: unknown;
    };
    if (typeof e.type !== 'string' || !e.type.trim()) {
      return `schedule[${i}].type is required`;
    }
    if (e.enabled !== undefined && typeof e.enabled !== 'boolean') {
      return `schedule[${i}].enabled must be a boolean`;
    }
    const err = validateInterval(e.interval);
    if (err) return `schedule[${i}]: ${err}`;
    if (e.id !== undefined) {
      if (typeof e.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(e.id))
        return `schedule[${i}].id must be 1-40 letters, digits, - or _`;
      if (ids.has(e.id)) return `Two timers share the id "${e.id}"`;
      ids.add(e.id);
    }
    if (
      e.name !== undefined &&
      (typeof e.name !== 'string' || e.name.length > 80)
    )
      return `schedule[${i}].name must be text of at most 80 characters`;
    if (
      e.instruction !== undefined &&
      (typeof e.instruction !== 'string' || e.instruction.length > 4000)
    )
      return `schedule[${i}].instruction must be text of at most 4000 characters`;
    if (
      e.timezone !== undefined &&
      e.timezone !== '' &&
      !isValidTimezone(e.timezone)
    ) {
      return `schedule[${i}].timezone "${String(e.timezone)}" is not a known time zone. Use an IANA name like "Asia/Kolkata" or "UTC".`;
    }
  }
  return null;
}

/** True for an IANA zone name the runtime (and so cron-parser) understands. */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The key a timer is tracked by: its id, or — for an entry saved before ids existed — its
 * type, which is also what that entry's past cycles were matched on. Two id-less entries of
 * the same type get positional keys; normaliseSchedule removes that case on the next save.
 */
export function entryKeyOf(
  entry: ScheduleEntryConfig,
  index: number,
  all: ScheduleEntryConfig[],
): string {
  if (entry.id) return entry.id;
  const sameType = all.filter((e) => !e.id && e.type === entry.type).length;
  return sameType === 1 ? entry.type : `${entry.type}#${index}`;
}

/**
 * Give every timer a stable id and tidy its text fields. Run on every write.
 *
 * An id-less legacy entry gets its type as its id when that is unique — so its history (past
 * cycles carry only cycle_type) still counts as this timer's last run — and a fresh id
 * otherwise.
 */
export function normaliseSchedule(
  schedule: ScheduleEntryConfig[],
): ScheduleEntryConfig[] {
  const taken = new Set(schedule.map((e) => e.id).filter(Boolean) as string[]);
  return schedule.map((e) => {
    const out: ScheduleEntryConfig = { ...e };
    if (!out.id) {
      const unique =
        schedule.filter((x) => !x.id && x.type === e.type).length === 1;
      let id =
        unique && !taken.has(e.type)
          ? e.type
          : `${e.type}-${randomUUID().slice(0, 6)}`;
      while (taken.has(id)) id = `${e.type}-${randomUUID().slice(0, 6)}`;
      out.id = id;
      taken.add(id);
    }
    for (const k of ['name', 'instruction', 'timezone'] as const) {
      const v = out[k];
      if (typeof v === 'string') {
        const t = v.trim();
        if (t) out[k] = t;
        else delete out[k];
      }
    }
    return out;
  });
}

/** One timer as the dashboard and the agent see it: config + live state + history. */
export interface TimerStatus extends ScheduleEntryConfig {
  id: string;
  blockedBy: EntryBlock | null;
  nextRunAt: string | null;
  lastRun: {
    at: string;
    status: string;
    cost: number;
    summary?: string;
  } | null;
  /** Consecutive failed runs, newest first. 0 once the last run succeeded. */
  failStreak: number;
}

/**
 * Every timer with why it will or won't fire, its next run, and how its recent runs went.
 * Shared by the owner's schedule API and the agent's self_manage reply so they agree.
 */
export function describeTimers(
  agent: { id: string; config: AgentConfig },
  status: string,
  nextRuns: Map<string, Date>,
): TimerStatus[] {
  const all = agent.config.schedule ?? [];
  const cycles = getCyclesByAgent(agent.id, 200);
  return all.map((e, i) => {
    const key = entryKeyOf(e, i, all);
    const blockedBy = whyEntryWontFire(e, { status, config: agent.config });
    const next = blockedBy ? undefined : nextRuns.get(key);
    const mine = cycles.filter(
      (c) => cycleIsFromTimer(c, key, e.type) && c.status !== 'running',
    );
    let failStreak = 0;
    for (const c of mine) {
      if (c.status === 'failed') failStreak++;
      else break;
    }
    const last = mine[0];
    return {
      ...e,
      id: key,
      blockedBy,
      nextRunAt: next ? next.toISOString() : null,
      lastRun: last
        ? {
            at: last.ended_at ?? last.started_at,
            status: last.status,
            cost: last.cost ?? 0,
            summary: last.summary ?? undefined,
          }
        : null,
      failStreak,
    };
  });
}

/**
 * Typical cost of one unattended run of this agent, for the page's cost estimate.
 * Chat turns are excluded: they are usually far cheaper than scheduled work.
 */
export function averageRunCost(agentId: string): number | null {
  const done = getCyclesByAgent(agentId, 200).filter(
    (c) => c.status === 'completed' && (c.cost ?? 0) > 0,
  );
  const unattended = done.filter(
    (c) => !(c as { human_requested?: unknown }).human_requested,
  );
  const sample = (unattended.length >= 3 ? unattended : done).slice(0, 20);
  if (!sample.length) return null;
  return sample.reduce((s, c) => s + (c.cost ?? 0), 0) / sample.length;
}

/** Next fires and runs-per-30-days for an interval in a zone — the page's live preview. */
export function previewInterval(
  interval: string,
  timezone = 'UTC',
  now: Date = new Date(),
): { nextFires: string[]; runsPer30Days: number } {
  const lower = interval.trim().toLowerCase();
  if (!lower || lower === 'manual') return { nextFires: [], runsPer30Days: 0 };
  const horizon = now.getTime() + 30 * 86_400_000;
  const ms = parseIntervalMs(interval);
  if (ms) {
    return {
      nextFires: Array.from({ length: 5 }, (_, i) =>
        new Date(now.getTime() + ms * (i + 1)).toISOString(),
      ),
      runsPer30Days: Math.round((30 * 86_400_000) / ms),
    };
  }
  if (DAY_NAMES.includes(lower)) {
    const fires: string[] = [];
    let d = now;
    for (let i = 0; i < 5; i++) {
      d = nextWeekday(lower, d);
      fires.push(d.toISOString());
    }
    return { nextFires: fires, runsPer30Days: 4 };
  }
  const iter = CronExpressionParser.parse(interval, {
    currentDate: now,
    tz: timezone || 'UTC',
  });
  const nextFires: string[] = [];
  let runs = 0;
  for (let i = 0; i < 50_000; i++) {
    const t = iter.next().toDate();
    if (t.getTime() > horizon) break;
    runs++;
    if (nextFires.length < 5) nextFires.push(t.toISOString());
  }
  if (nextFires.length < 5) {
    // Rarer than monthly — still show when it next fires.
    while (nextFires.length < 5) {
      try {
        nextFires.push(iter.next().toDate().toISOString());
      } catch {
        break;
      }
    }
  }
  return { nextFires, runsPer30Days: runs };
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface ScheduleEntry {
  /** Stable per-timer key — see entryKeyOf. Several entries may share a cycleType. */
  key: string;
  cycleType: CycleType;
  interval: string;
  enabled: boolean;
  projectId?: string;
  name?: string;
  instruction?: string;
  timezone: string;
}

/** Consecutive failed runs of one timer before the owner is told. */
const FAILURE_ALERT_STREAK = 3;

// Stage 34 Gap 1 — fast-lane consolidation debounce. A salient episode doesn't trigger
// self_improve instantly; it waits this long so a burst of related events (a rejection
// followed by a retry followed by a fix) collapses into ONE early run instead of several.
const FASTLANE_DEBOUNCE_MS = 30 * 60 * 1000; // 30 minutes

interface AgentScheduleState {
  lastRun: Map<string, Date>;
  nextRun: Map<string, Date>;
  schedule: ScheduleEntry[];
}

type CycleRow = ReturnType<typeof getCyclesByAgent>[number];

/** Whether a cycle row was started by the timer with this key. */
function cycleIsFromTimer(c: CycleRow, key: string, type: string): boolean {
  const entryId = (c as { schedule_entry_id?: string | null })
    .schedule_entry_id;
  if (entryId) return entryId === key;
  // Before cycles recorded their timer, the only link was the type — and that is exactly
  // the key a legacy id-less entry has.
  return key === type && c.cycle_type === type;
}

// ─── AgentScheduler ───────────────────────────────────────────────────────────

export class AgentScheduler {
  private state: Map<string, AgentScheduleState> = new Map();
  private agentService: AgentService;

  constructor(agentService: AgentService) {
    this.agentService = agentService;
  }

  /**
   * Register an agent's schedule in memory.
   * Rebuilds last-run times from the DB (so missed cycles aren't retroactively fired).
   */
  register(agentId: string, config: AgentConfig): void {
    // Phase A5 Task 1.4: 'on_demand' agents never run their MAIN work on a schedule,
    // even if entries exist — but self_improve (memory distillation + identity
    // evolution) is background housekeeping, not primary work, so it's exempt from
    // that rule. Without this exemption, "remember" and "learn" never fire at all for
    // any on_demand agent (the overwhelming majority — that's what "hire an agent to
    // do X on demand" means), since nothing else schedules self_improve automatically.
    //
    // checkin is exempt for the same reason: reporting to the owner is not the work
    // the agent was hired to do on demand, it's how the owner finds out what happened.
    // Leaving it filtered here would silently undo a checkin schedule entry for exactly
    // the agents most likely to have one — the entry lands in the DB, the config looks
    // right, and no report is ever produced.
    const onDemand =
      config.triggerMode === 'on_demand' ||
      config.triggerMode === 'event_driven';
    const backgroundTypes = new Set<CycleType>(['self_improve', 'checkin']);
    // Keys are computed over the whole list, before filtering, so a timer's key does not
    // shift when a sibling is disabled.
    const all = config.schedule ?? [];
    const entries: ScheduleEntry[] = all
      .map((s, i) => ({ s, key: entryKeyOf(s, i, all) }))
      .filter(
        ({ s }) =>
          s.enabled && s.interval && s.interval.toLowerCase() !== 'manual',
      )
      .filter(({ s }) => !onDemand || backgroundTypes.has(s.type))
      .map(({ s, key }) => ({
        key,
        cycleType: s.type,
        interval: s.interval,
        enabled: s.enabled,
        projectId: s.project_id,
        name: s.name,
        instruction: s.instruction,
        timezone:
          s.timezone && isValidTimezone(s.timezone) ? s.timezone : 'UTC',
      }));

    const lastRun = new Map<string, Date>();
    const nextRun = new Map<string, Date>();
    const now = new Date();

    // Restore last-run times from completed cycles
    const cycles = getCyclesByAgent(agentId, 200);
    for (const entry of entries) {
      const lastCompleted = cycles.find(
        (c) =>
          cycleIsFromTimer(c, entry.key, entry.cycleType) &&
          c.status === 'completed' &&
          c.ended_at,
      );
      const last = lastCompleted?.ended_at
        ? new Date(lastCompleted.ended_at)
        : null;
      lastRun.set(entry.key, last ?? new Date(0));
      nextRun.set(
        entry.key,
        calcNextRun(entry.interval, last, now, entry.timezone),
      );
    }

    this.state.set(agentId, { lastRun, nextRun, schedule: entries });
  }

  /** Remove all schedule state for an agent (called on pause/stop/delete). */
  unregister(agentId: string): void {
    this.state.delete(agentId);
  }

  /**
   * Returns all due (agentId, cycleType) pairs as of now.
   * Does NOT fire them — tick() does that.
   */
  getDueAgents(now: Date = new Date()): {
    agentId: string;
    key: string;
    cycleType: CycleType;
    projectId?: string;
  }[] {
    const due: {
      agentId: string;
      key: string;
      cycleType: CycleType;
      projectId?: string;
    }[] = [];
    for (const [agentId, state] of this.state) {
      for (const entry of state.schedule) {
        if (!entry.enabled) continue;
        const next = state.nextRun.get(entry.key);
        if (next && next <= now) {
          due.push({
            agentId,
            key: entry.key,
            cycleType: entry.cycleType,
            projectId: entry.projectId,
          });
        }
      }
    }
    return due;
  }

  /**
   * Next due time for every armed entry, keyed by cycle type.
   *
   * getNextCycle only answers for the soonest one, which is why the schedule API used to
   * report null for every other entry — indistinguishable from "not registered".
   */
  getEntryNextRuns(agentId: string): Map<string, Date> {
    const state = this.state.get(agentId);
    const out = new Map<string, Date>();
    if (!state) return out;
    for (const entry of state.schedule) {
      const next = state.nextRun.get(entry.key);
      if (entry.enabled && next) out.set(entry.key, next);
    }
    return out;
  }

  /**
   * Returns the next scheduled cycle for a specific agent (earliest due time).
   */
  getNextCycle(agentId: string): { type: CycleType; dueAt: Date } | null {
    const state = this.state.get(agentId);
    if (!state) return null;

    let earliest: { type: CycleType; dueAt: Date } | null = null;
    for (const entry of state.schedule) {
      if (!entry.enabled) continue;
      const next = state.nextRun.get(entry.key);
      if (!next) continue;
      if (!earliest || next < earliest.dueAt) {
        earliest = { type: entry.cycleType, dueAt: next };
      }
    }
    return earliest;
  }

  /**
   * Called every minute by the main loop.
   * For each due cycle: enforce budget gate, then fire via AgentService.runCycle().
   */
  async tick(now: Date = new Date()): Promise<void> {
    await this.checkFastlane(now);
    await this.checkOneOffs(now);

    const due = this.getDueAgents(now);

    for (const { agentId, key, cycleType, projectId } of due) {
      // `due` is a snapshot taken before the loop, but the loop mutates this.state:
      // the budget branch below calls unregister() when an agent is paused. An agent
      // with two due entries — routine, since every agent carries self_improve and
      // checkin alongside its main work — then reached this line on the second entry
      // with its state already deleted, and the non-null assertions turned that into a
      // TypeError thrown straight out of tick().
      //
      // That aborted the whole pass, so one agent going over budget silently cost every
      // *other* agent its due cycles for that minute, surfacing only as a generic
      // "Agent scheduler tick error". Skip instead: the entry is gone on purpose.
      const state = this.state.get(agentId);
      if (!state) continue;
      const entry = state.schedule.find((e) => e.key === key);
      if (!entry) continue;

      // Budget gate
      const agent = this.agentService.getAgent(agentId);
      if (!agent || agent.status !== 'running') {
        // Agent deleted, paused, or stopped — skip but reschedule
        this._reschedule(agentId, entry, now);
        continue;
      }

      const todayCost = getCycleCostToday(agentId);
      if (todayCost >= agent.config.budget.daily) {
        if (agent.config.budget.onExhaust === 'pause') {
          updateAgentStatus(agentId, 'paused');
          this.unregister(agentId);
          // A budget pause is a real state change the owner should find in one place with
          // everything else that moved, not only in a socket event they had to be watching
          // for. An agent silently going quiet has cost 35 hours here before.
          recordConfigAudit({
            agentId,
            capability: 'status',
            actor: 'system',
            before: { status: 'running' },
            after: { status: 'paused' },
            reason: `Daily budget exhausted: $${todayCost.toFixed(2)} of $${agent.config.budget.daily}`,
          });
          getSocketIO()?.emit('agent:status_changed', {
            agentId,
            status: 'paused',
            reason: 'budget_exceeded',
            costToday: todayCost,
            limit: agent.config.budget.daily,
          });
        }
        // Either way, skip this cycle
        continue;
      }

      // A scheduled send_outreach cycle only has work if a lead is waiting in the inbox —
      // approvals and follow-ups already get their own cycle fired the moment they're due
      // (see outreach-followup.ts and the HITL resume path), so this slot exists purely to
      // catch new first-touch handoffs. Firing the full cycle just to conclude "nothing new"
      // was costing real money for a no-op several times a day. Skip it here instead, before
      // any tokens are spent — everything else still gets its full cycle.
      //
      // workOnly matters here. Since stage 56 a reply lands in the recipient's inbox as a
      // pending row too, and a reply is not work owed — arming a send gate off an
      // acknowledgement would fire outreach cycles with no lead behind them.
      if (
        cycleType === 'send_outreach' &&
        getPendingHandoffsByAgent(agentId, { workOnly: true }).length === 0
      ) {
        logger.info(
          { agentId, cycleType },
          '[scheduler] skipping send_outreach — no pending handoffs',
        );
        this._reschedule(agentId, entry, now);
        continue;
      }

      // Don't fire on top of a cycle that is still running.
      //
      // tick() is scheduled with setInterval and NOT awaited (index.ts), so ticks overlap:
      // a 6-minute lead_search is still inside `await runCycle` when the next tick fires
      // 60 s later. `_reschedule` only runs after that await, so nextRun is still in the
      // past and getDueAgents hands back the very same entry. It then called runCycle,
      // hit the concurrency guard, and logged the rejection at ERROR level — one bogus
      // error per long cycle, in exactly the stream that gets grepped when something is
      // actually wrong (see SUPPORT_GUIDE's triage checklist).
      //
      // Asking first is also what stops the wasted call from having side effects; see the
      // early guard in AgentService.runCycle for what those were.
      //
      // Deliberately NOT rescheduled: leaving the entry due means it fires on a later tick
      // once the agent is free, instead of silently forfeiting this slot.
      if (this.agentService.isExecutingCycle(agentId)) {
        logger.debug(
          { agentId, cycleType },
          '[scheduler] skipping — agent is still executing a cycle; will retry next tick',
        );
        continue;
      }

      // Fire the cycle.
      //
      // This catch used to be bare, on the assumption that runCycle logs its own errors.
      // It does — for failures that happen after a cycle row exists. A throw *before*
      // that point produced no cycle row, no log line, and no container: the scheduler
      // silently swallowed it and rescheduled to the next slot. Finder went 34 hours and
      // three scheduled slots without running and nothing anywhere said why; the only
      // evidence was an absence. Log it here so a failure to *start* is as visible as a
      // failure to finish.
      logger.info(
        { agentId, cycleType, timer: key },
        '[scheduler] firing cycle',
      );
      try {
        await this.agentService.runCycle(
          agentId,
          cycleType,
          undefined,
          projectId,
          undefined,
          undefined,
          {
            timer: this._timerContext(agentId, entry, now),
          },
        );
      } catch (err) {
        logger.error(
          { err, agentId, cycleType, timer: key },
          '[scheduler] runCycle threw — cycle did not run',
        );
      }

      this._reschedule(agentId, entry, now);
      this._alertOnFailureStreak(agentId, entry);
    }
  }

  /**
   * Run one timer's job right now, as the timer would — same instruction, same context —
   * without moving its next scheduled time. For testing a timer without waiting for it.
   *
   * Works whether or not the agent is switched on (testing a timer before switching the
   * agent on is the point) and returns once the cycle has started, not when it ends.
   */
  runNow(
    agentId: string,
    entryId: string,
  ): { ok: true } | { ok: false; error: string } {
    const agent = this.agentService.getAgent(agentId);
    if (!agent) return { ok: false, error: 'Agent not found' };
    const all = agent.config.schedule ?? [];
    const idx = all.findIndex((e, i) => entryKeyOf(e, i, all) === entryId);
    if (idx < 0) return { ok: false, error: `No timer with id "${entryId}"` };
    if (agent.status === 'stopped')
      return { ok: false, error: 'The agent is stopped. Start it first.' };
    if (this.agentService.isExecutingCycle(agentId))
      return {
        ok: false,
        error:
          'The agent is busy with another run. Try again when it finishes.',
      };
    const s = all[idx];
    const entry: ScheduleEntry = {
      key: entryId,
      cycleType: s.type,
      interval: s.interval,
      enabled: s.enabled,
      projectId: s.project_id,
      name: s.name,
      instruction: s.instruction,
      timezone: s.timezone && isValidTimezone(s.timezone) ? s.timezone : 'UTC',
    };
    const timer = {
      ...this._timerContext(agentId, entry, new Date()),
      manual: true,
    };
    void this.agentService
      .runCycle(
        agentId,
        s.type,
        undefined,
        s.project_id,
        undefined,
        undefined,
        { timer },
      )
      .catch((err) =>
        logger.error(
          { err, agentId, timer: entryId },
          '[scheduler] Run now failed to start',
        ),
      )
      .finally(() => this._alertOnFailureStreak(agentId, entry));
    return { ok: true };
  }

  /** What a timer-started run is told about the timer. */
  private _timerContext(
    agentId: string,
    entry: ScheduleEntry,
    now: Date,
  ): TimerContext {
    const last = getCyclesByAgent(agentId, 200).find(
      (c) =>
        cycleIsFromTimer(c, entry.key, entry.cycleType) &&
        c.status !== 'running',
    );
    return {
      id: entry.key,
      name: entry.name,
      instruction: entry.instruction,
      timezone: entry.timezone,
      interval: entry.interval,
      firedAt: now.toISOString(),
      lastRun: last
        ? {
            at: last.ended_at ?? last.started_at,
            status: last.status,
            summary: last.summary ?? undefined,
          }
        : null,
    };
  }

  /**
   * Tell the owner when one timer has failed several runs in a row — once per streak.
   *
   * A timer that fails every run looks, from the outside, exactly like one that is working:
   * it keeps firing on schedule and costing money. The streak resets on the next success.
   */
  private failureAlerted = new Set<string>();
  private _alertOnFailureStreak(agentId: string, entry: ScheduleEntry): void {
    try {
      const recent = getCyclesByAgent(agentId, 200)
        .filter(
          (c) =>
            cycleIsFromTimer(c, entry.key, entry.cycleType) &&
            c.status !== 'running',
        )
        .slice(0, FAILURE_ALERT_STREAK);
      const streakKey = `${agentId}:${entry.key}`;
      if (recent.length > 0 && recent[0].status === 'completed') {
        this.failureAlerted.delete(streakKey);
        return;
      }
      if (
        recent.length < FAILURE_ALERT_STREAK ||
        !recent.every((c) => c.status === 'failed')
      )
        return;
      if (this.failureAlerted.has(streakKey)) return;
      this.failureAlerted.add(streakKey);
      const agent = this.agentService.getAgent(agentId);
      notify(
        'agent_alert',
        `${agent?.name ?? 'An agent'}: timer "${entry.name ?? entry.key}" failed ${FAILURE_ALERT_STREAK} runs in a row`,
        `Last error: ${(recent[0].summary ?? 'no summary').slice(0, 300)}\n\nIt keeps firing (and costing) until fixed or disabled — see the Schedule tab.`,
        agentId,
      );
    } catch (err) {
      logger.warn({ agentId, err }, '[scheduler] failure-streak check failed');
    }
  }

  /**
   * Re-initialise the scheduler from DB on server startup.
   * Loads all running agents and registers their schedules.
   */
  initFromDb(): void {
    const agents = getAllAgents();
    const registered: string[] = [];
    for (const agent of agents) {
      // Only enabled agents. This previously also registered anything with a
      // schedule regardless of status — a workaround from the days when every
      // finished cycle reset status to 'idle', so nothing was left 'running' to
      // re-register after a restart. runCycle now restores the pre-cycle status,
      // so 'running' is once again a truthful record of "this agent is started"
      // and a stopped agent stays unscheduled.
      if (agent.status === 'running') {
        try {
          this.register(agent.id, agent.config);
          registered.push(agent.name);
        } catch (err) {
          // Skip agents with unparseable intervals rather than crashing startup
          logger.warn(
            { agentId: agent.id, err },
            'Skipping agent with invalid schedule config',
          );
        }
      }
    }
    // Registration used to be silent, which made "the agent never ran" and "the agent was
    // never scheduled" look identical from the outside — and they need completely
    // different fixes. Say which agents are armed, and when each one is next due.
    const due = registered.map((name) => {
      const id = agents.find((a) => a.name === name)!.id;
      const next = this.getNextCycle(id);
      return next
        ? `${name}:${next.type}@${next.dueAt.toISOString()}`
        : `${name}:none`;
    });
    logger.info(
      { count: registered.length, scanned: agents.length, due },
      '[scheduler] registered agents from DB',
    );
  }

  /**
   * Stage 34 Gap 1 — drain the fast-lane queue: any agent tagged by writeEpisodeLog() with a
   * salient episode gets its self_improve run NOW (debounced), instead of waiting for the
   * weekly timer. Runs before the normal due-cycle scan every tick() so it shares the same
   * per-minute cadence rather than needing its own timer.
   */
  private async checkFastlane(now: Date): Promise<void> {
    for (const [agentId, state] of this.state) {
      const entry = state.schedule.find((e) => e.cycleType === 'self_improve');
      if (!entry) continue; // agent has no self_improve schedule at all — nothing to fast-lane

      const pending = getFastlanePending(agentId);
      if (!pending) continue;

      const age = now.getTime() - Date.parse(pending.tagged_at);
      if (age < FASTLANE_DEBOUNCE_MS) continue; // let a burst of related events collapse into one run

      const agent = this.agentService.getAgent(agentId);
      if (!agent || agent.status !== 'running') continue; // paused/deleted — leave queued, try again next tick

      // Same reasoning as the due-cycle path: a fast-laned self_improve must not be fired
      // on top of a running cycle. The queue entry survives, so it drains on a later tick.
      if (this.agentService.isExecutingCycle(agentId)) continue;

      const todayCost = getCycleCostToday(agentId);
      if (todayCost >= agent.config.budget.daily) continue; // same budget gate as the normal due-cycle path

      try {
        await this.agentService.runCycle(agentId, 'self_improve');
      } catch {
        // Errors are logged inside runCycle; still clear + reschedule below so a persistently
        // failing agent doesn't retry every single tick.
      }

      clearFastlane(agentId);
      // The fast-lane run already did this cycle's work — push the weekly timer out from
      // now, so it doesn't fire again immediately after.
      this._reschedule(agentId, entry, now);
    }
  }

  /**
   * Fire any one-off runs that have come due, then delete them.
   *
   * Reads agents from the DB rather than `this.state` on purpose. `state` only holds
   * agents that are both `running` and carry a recurring schedule; an `on_demand` agent
   * has no entry at all. Those are precisely the agents most likely to be told "ping me
   * at 1pm", so driving one-offs off the in-memory map would make the feature silently
   * not work for its main use case. getAllAgents() is one indexed SQLite read per minute.
   */
  private async checkOneOffs(now: Date): Promise<void> {
    const nowMs = now.getTime();

    for (const agent of getAllAgents()) {
      const runs = agent.config.oneOffRuns ?? [];
      if (runs.length === 0) continue;

      const due: OneOffRun[] = [];
      const remaining: OneOffRun[] = [];
      for (const run of runs) {
        const at = Date.parse(run.at);
        // An unparseable `at` can never come due and would sit in the config forever;
        // drop it rather than carrying it and re-parsing it every single tick.
        if (Number.isNaN(at)) {
          logger.warn(
            { agentId: agent.id, runId: run.id, at: run.at },
            '[scheduler] discarding one-off with unparseable time',
          );
          continue;
        }
        (at <= nowMs ? due : remaining).push(run);
      }

      if (due.length === 0 && remaining.length === runs.length) continue;

      // A one-off is deleted before it fires, so that a crash mid-cycle cannot replay it.
      // That makes firing into a busy agent destructive: runCycle would be refused by the
      // concurrency guard and the run would be gone, with "ping me at 1pm" silently never
      // happening. Defer the whole agent instead — nothing is written, so the entry is
      // still queued and fires on a later tick once the agent is free.
      if (due.length > 0 && this.agentService.isExecutingCycle(agent.id)) {
        logger.debug(
          { agentId: agent.id, dueCount: due.length },
          '[scheduler] deferring one-off runs — agent is still executing a cycle',
        );
        continue;
      }

      // Persist the removal BEFORE firing. If runCycle throws, or the process dies
      // mid-cycle, the entry is already gone — a one-off that fires twice is worse
      // than one that fires zero times, because the second firing looks like the
      // agent deciding on its own to do the thing again.
      updateAgentConfig(agent.id, { ...agent.config, oneOffRuns: remaining });

      for (const run of due) {
        // 'paused' is an explicit "stop doing things" from the owner and outranks a
        // one-off the agent scheduled for itself earlier. Everything else may fire:
        // unlike the recurring path we do NOT require status 'running', because
        // on_demand agents legitimately sit at 'idle' between runs.
        if (agent.status === 'paused') {
          logger.info(
            { agentId: agent.id, runId: run.id },
            '[scheduler] skipping one-off — agent paused',
          );
          continue;
        }

        const todayCost = getCycleCostToday(agent.id);
        if (todayCost >= agent.config.budget.daily) {
          logger.info(
            {
              agentId: agent.id,
              runId: run.id,
              todayCost,
              limit: agent.config.budget.daily,
            },
            '[scheduler] skipping one-off — daily budget exhausted',
          );
          continue;
        }

        logger.info(
          { agentId: agent.id, runId: run.id, cycleType: run.cycleType },
          '[scheduler] firing one-off run',
        );
        try {
          await this.agentService.runCycle(
            agent.id,
            run.cycleType,
            run.instruction,
          );
        } catch (err) {
          logger.error(
            { err, agentId: agent.id, runId: run.id },
            '[scheduler] one-off runCycle threw — run did not happen',
          );
        }
      }
    }
  }

  // ─── private helpers ─────────────────────────────────────────────────────

  private _reschedule(agentId: string, entry: ScheduleEntry, now: Date): void {
    const state = this.state.get(agentId);
    if (!state) return;
    state.lastRun.set(entry.key, now);
    state.nextRun.set(
      entry.key,
      calcNextRun(entry.interval, now, now, entry.timezone),
    );
  }
}
