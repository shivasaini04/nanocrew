/**
 * Stage 57 phase 5 — what looks wrong with a run, in words an owner can act on.
 *
 * Computed from the run's own record, never from the boss's account of it. Shown in the run
 * view; the failures among them are also what the owner is notified about (service.ts).
 */
import type { Digest } from './digest.js';
import type { AttemptRow, EventRow, RunRow, TaskRow } from './store.js';

export type HealthKind =
  | 'failed_tasks'
  | 'budget'
  | 'stalled'
  | 'serial'
  | 'retries'
  | 'unverified';
export interface HealthFlag {
  kind: HealthKind;
  severity: 'problem' | 'note';
  message: string;
}

/** No event for this long while a run is live means nothing is moving: an attempt's 10 min plus checking. */
export const STALL_MS = 15 * 60_000;

/**
 * A worker still inside its lease is working, however long it has been quiet — a task may
 * ask for up to 30 minutes (spec.ts `timeout_minutes`), and a worker emits no run event
 * until it finishes. Past its lease, the reaper takes it; silence with none running is a stall.
 */
export function workerStillWithinLease(
  attempts: AttemptRow[],
  nowMs: number,
): boolean {
  return attempts.some(
    (a) => a.status === 'running' && Date.parse(a.lease_expires_at) > nowMs,
  );
}

export function runHealth(
  run: RunRow,
  tasks: TaskRow[],
  attempts: AttemptRow[],
  events: EventRow[],
  digest: Digest,
  nowMs = Date.now(),
): HealthFlag[] {
  const flags: HealthFlag[] = [];
  const c = digest.counts;
  if (c.dead > 0) {
    flags.push({
      kind: 'failed_tasks',
      severity: 'problem',
      message: `${c.dead} of ${c.total} task${c.total > 1 ? 's' : ''} failed after ${tasks
        .filter((t) => t.status === 'dead')
        .map((t) => t.attempts)
        .join('/')} attempt(s)`,
    });
  }
  if (run.status === 'budget_stopped' || run.stop_reason === 'budget') {
    flags.push({
      kind: 'budget',
      severity: 'problem',
      message: `stopped at its $${run.budget_usd.toFixed(2)} budget — ${c.cancelled} task(s) never ran`,
    });
  }
  if (run.status === 'running') {
    const last = events.length
      ? Date.parse(events[events.length - 1].at)
      : Date.parse(run.created_at);
    if (nowMs - last > STALL_MS && !workerStillWithinLease(attempts, nowMs)) {
      flags.push({
        kind: 'stalled',
        severity: 'problem',
        message: `nothing has happened for ${Math.round((nowMs - last) / 60_000)} minutes`,
      });
    }
  }
  // "Fake parallelism": several attempts, room to run them together, and yet the run took as
  // long as all of them added up.
  const ran = attempts.filter((a) => a.finished_at);
  if (
    run.finished_at &&
    ran.length >= 2 &&
    run.max_parallel >= 2 &&
    digest.sumWorkMs > 0 &&
    digest.wallMs >= 0.9 * digest.sumWorkMs
  ) {
    flags.push({
      kind: 'serial',
      severity: 'note',
      message: `ran one after another — ${Math.round(digest.wallMs / 1000)}s wall for ${Math.round(digest.sumWorkMs / 1000)}s of work`,
    });
  }
  const retried = tasks.filter((t) => t.attempts > 1);
  if (retried.length) {
    flags.push({
      kind: 'retries',
      severity: 'note',
      message: `${retried.length} task${retried.length > 1 ? 's' : ''} needed a second attempt`,
    });
  }
  if (c.unverified > 0) {
    flags.push({
      kind: 'unverified',
      severity: 'note',
      message: `${c.unverified} result${c.unverified > 1 ? 's were' : ' was'} accepted without a check`,
    });
  }
  return flags;
}
