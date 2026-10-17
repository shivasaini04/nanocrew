/**
 * Graceful shutdown — a deploy stops killing runs.
 *
 * Stage 64 phase 3. Shutdown used to drain the legacy group queue for 8 s (Docker's default
 * stop window is 10 s) and then tear down every warm daemon, so every agent cycle in flight
 * died: 7 of the 29 failed cycles in the 30 days to 2026-09-30 read "Orchestrator restarted
 * mid-cycle", and on 2026-09-30 two deploys had to choose between killing benchmark runs and
 * waiting 45 minutes for a gap that never came.
 *
 * Now: on SIGTERM the scheduler stops starting cycles, and shutdown waits — up to
 * DRAIN_MAX_MS — for the ones already running. The HTTP server keeps serving meanwhile,
 * because a running cycle still calls back (model relay, check-ins, self-management). A cycle
 * still running at the deadline is cut, and after the restart a run a person asked for is
 * started again (agent-registry.ts resumeInterruptedCycle). Cycles may now run for hours or
 * days, so "wait until all are done" cannot be the rule; "wait a while, then resume" is.
 *
 * docker-compose.prod.yml gives the container stop_grace_period longer than DRAIN_MAX_MS.
 */

let draining = false;

/** True once shutdown has begun — nothing new should start. */
export function isDraining(): boolean {
  return draining;
}

export function startDraining(): void {
  draining = true;
}

/** How long a deploy waits for running cycles. Keep below stop_grace_period in compose. */
export const DRAIN_MAX_MS =
  parseInt(process.env.SHUTDOWN_DRAIN_MS || '', 10) || 10 * 60_000;

/**
 * Resolve once nothing is executing, or at `maxMs`. Returns how many were still running.
 * `countExecuting` is injected so this stays a leaf (and testable without an agent service).
 */
export async function waitForIdle(
  countExecuting: () => number,
  maxMs: number = DRAIN_MAX_MS,
  pollMs = 2000,
  onWait?: (running: number, waitedMs: number) => void,
): Promise<{ remaining: number; waitedMs: number }> {
  const start = Date.now();
  let lastReport = 0;
  for (;;) {
    const running = countExecuting();
    const waitedMs = Date.now() - start;
    if (running === 0 || waitedMs >= maxMs)
      return { remaining: running, waitedMs };
    if (onWait && waitedMs - lastReport >= 30_000) {
      lastReport = waitedMs;
      onWait(running, waitedMs);
    }
    await new Promise((r) =>
      setTimeout(r, Math.min(pollMs, Math.max(1, maxMs - waitedMs))),
    );
  }
}

// ─── After the restart ──────────────────────────────────────────────────────────────────

/** Wait this long after boot before resuming, so daemons and channels are up. */
export const RESUME_AFTER_BOOT_MS = 30_000;
/** A run older than this when it was cut is not resurrected — the orchestrator may have been down for days. */
export const RESUME_MAX_AGE_MS = 48 * 60 * 60_000;
/** Restart cuts of the same agent in this window that stop a resume — a crash loop, not a deploy. */
export const RESUME_LOOP_WINDOW_MS = 2 * 60 * 60_000;

/**
 * Should a cycle a restart cut short be started again? Only a run a person asked for (a
 * scheduled one comes round on its own), only if recent, and not when restarts are looping.
 */
export function decideResume(
  cycle: { human_requested?: number | boolean | null; started_at: string },
  recentRestartCuts: number,
  now: number = Date.now(),
): boolean {
  if (!cycle.human_requested) return false;
  if (now - Date.parse(cycle.started_at) > RESUME_MAX_AGE_MS) return false;
  return recentRestartCuts < 2;
}

/** Test hook. */
export function _resetDrainForTest(): void {
  draining = false;
}
