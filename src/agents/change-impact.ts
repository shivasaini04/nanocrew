/**
 * What happened after a change — the half of self-improvement that has never existed.
 *
 * Stage 55 phase 2. Every audit row records what changed and when. Nothing records what
 * followed, and that gap is the difference between an agent that can change itself and one
 * that can improve.
 *
 * The case it is built from, measured 2026-09-08:
 *
 *   Crawler changed its sourcing method on 2026-08-22 — abandoned linkedin_jobs and
 *   yc_jobs for hand-written Serper scripts. Leads carrying contact details stopped two
 *   days later. It ran ~200 more cycles on the new method, reported "honest 0-fresh cycle"
 *   every time, and wrote 21 learned bullets concluding the approach was working. Nothing
 *   compared before to after. A human found it seventeen days later by reading a git log.
 *
 * Correlation, stated as correlation. Several things move at once — that method change and
 * a model switch six days later overlap — so this says what followed a change, never that
 * the change caused it. An agent told "X caused Y" will act on it.
 */
import {
  getConfigAuditById,
  getCyclesByAgent,
  getTrackedItems,
} from '../db.js';
import { logger } from '../logger.js';

/** Below this, a comparison is noise, and a confident number from noise is worse than silence. */
const MIN_CYCLES_EITHER_SIDE = 3;

export interface ImpactWindow {
  cycles: number;
  completedPct: number | null;
  medianMinutes: number | null;
  costPerCycle: number | null;
  /** Rows this agent added to its tracker in the window — its actual output. */
  outputRows: number | null;
}

export interface ChangeImpact {
  auditId: string;
  capability: string;
  changedAt: string;
  reason: string | null;
  before: ImpactWindow;
  after: ImpactWindow;
  /** Plain-language lines, already resolved. Empty when nothing moved materially. */
  findings: string[];
  /** True when there were too few cycles either side to say anything. */
  insufficient: boolean;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.floor(s.length / 2)] * 10) / 10;
}

function summarise(
  cycles: Array<{
    status: string;
    started_at: string;
    ended_at?: string;
    cost: number;
  }>,
  outputRows: number | null,
): ImpactWindow {
  const durations = cycles
    .filter((c) => c.ended_at)
    .map((c) => (Date.parse(c.ended_at!) - Date.parse(c.started_at)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 0);
  const cost = cycles.reduce((s, c) => s + (c.cost ?? 0), 0);
  return {
    cycles: cycles.length,
    completedPct: cycles.length
      ? Math.round(
          (cycles.filter((c) => c.status === 'completed').length /
            cycles.length) *
            100,
        )
      : null,
    medianMinutes: median(durations),
    costPerCycle: cycles.length
      ? Math.round((cost / cycles.length) * 10000) / 10000
      : null,
    outputRows,
  };
}

/** A change of more than this fraction is worth a sentence; anything less is noise. */
const MATERIAL = 0.25;

function compare(
  label: string,
  before: number | null,
  after: number | null,
  higherIsBetter: boolean,
): string | null {
  if (before === null || after === null) return null;
  if (before === 0 && after === 0) return null;

  if (before === 0) return `${label}: 0 → ${after}`;
  const delta = (after - before) / before;
  if (Math.abs(delta) < MATERIAL) return null;

  const pct = Math.round(Math.abs(delta) * 100);
  const dir = delta > 0 ? 'up' : 'down';
  const worse = higherIsBetter ? delta < 0 : delta > 0;
  return `${label}: ${before} → ${after} (${dir} ${pct}%)${worse ? '  <-- worse' : ''}`;
}

/**
 * Compare the `window` cycles either side of a recorded change.
 *
 * Output is read from the agent's tracker rather than configured per agent type, so a new
 * kind of agent needs no wiring — an agent with no tracker simply reports null for it and
 * the other three still work.
 */
export function getChangeImpact(
  auditId: string,
  window = 7,
): ChangeImpact | null {
  const entry = getConfigAuditById(auditId);
  if (!entry) return null;

  const at = Date.parse(entry.created_at);
  // Pull generously and split, rather than two queries with fragile boundary conditions.
  const all = getCyclesByAgent(entry.agent_id, window * 6);
  const before = all
    .filter((c) => Date.parse(c.started_at) < at)
    .slice(0, window);
  const after = all
    .filter((c) => Date.parse(c.started_at) >= at)
    .slice(-window);

  // Tracker rows, split the same way. `updated_at` is the only timestamp a row carries,
  // so this counts rows TOUCHED in each window — which is the honest reading of it.
  let rowsBefore: number | null = null;
  let rowsAfter: number | null = null;
  try {
    const rows = getTrackedItems(entry.agent_id);
    if (rows.length) {
      const firstAfter = after.length
        ? Date.parse(after[after.length - 1].started_at)
        : at;
      const firstBefore = before.length
        ? Date.parse(before[before.length - 1].started_at)
        : at;
      rowsAfter = rows.filter((r) => Date.parse(r.updated_at) >= at).length;
      rowsBefore = rows.filter((r) => {
        const t = Date.parse(r.updated_at);
        return t < at && t >= firstBefore;
      }).length;
      void firstAfter;
    }
  } catch (err) {
    logger.warn(
      { agentId: entry.agent_id, err: (err as Error)?.message },
      '[change-impact] tracker read failed',
    );
  }

  const b = summarise(before, rowsBefore);
  const a = summarise(after, rowsAfter);
  const insufficient =
    before.length < MIN_CYCLES_EITHER_SIDE ||
    after.length < MIN_CYCLES_EITHER_SIDE;

  const findings = insufficient
    ? []
    : [
        compare('output rows', b.outputRows, a.outputRows, true),
        compare('completed', b.completedPct, a.completedPct, true),
        compare('median minutes', b.medianMinutes, a.medianMinutes, false),
        compare('cost per cycle', b.costPerCycle, a.costPerCycle, false),
      ].filter((x): x is string => !!x);

  return {
    auditId: entry.id,
    capability: entry.capability,
    changedAt: entry.created_at,
    reason: entry.reason,
    before: b,
    after: a,
    findings,
    insufficient,
  };
}

/**
 * Render impact for an agent's recent changes, for the self-report.
 *
 * Deliberately quiet: a change with nothing material either side prints one line saying so,
 * rather than four rows of numbers that did not move. The point is to make a REGRESSION
 * impossible to miss, and a wall of unchanged figures is how that gets missed.
 */
export function renderChangeImpacts(impacts: ChangeImpact[]): string[] {
  if (!impacts.length) return [];
  const L: string[] = ['', '## What happened after your recent changes'];

  for (const i of impacts) {
    const when = i.changedAt.slice(0, 10);
    const why = i.reason ? ` — ${i.reason.slice(0, 70)}` : '';
    if (i.insufficient) {
      L.push(`  ${when} ${i.capability}${why}`);
      L.push(`      not enough cycles either side yet to say anything`);
      continue;
    }
    L.push(`  ${when} ${i.capability}${why}`);
    if (!i.findings.length) {
      L.push('      nothing moved materially');
      continue;
    }
    for (const f of i.findings) L.push(`      ${f}`);
  }

  L.push('');
  L.push(
    '  These are what FOLLOWED each change, not what it caused — several things move at',
  );
  L.push(
    '  once. Treat a "worse" line as a reason to look, not as a proven cause.',
  );
  return L;
}
