/**
 * Global cap on concurrent `docker run` invocations across every container-lifecycle
 * path: one-shot agent cycles (container-runner.ts::runContainerAgent), warm per-agent
 * daemons (agents/daemon-pool.ts). (Persistent pool workers were the third path until
 * stage 57 removed them.)
 *
 * 2026-08-18: dockerd's own internal session healthcheck started failing fatally
 * ("transport: Error while dialing: only one connection allowed") during bursts of
 * concurrent container create/network-join activity, and Docker force-killed and
 * recreated the nanocrew-orchestrator container itself as a result — not an app crash.
 * Confirmed via journalctl: the recreated container's `Created` timestamp matched two
 * of Finder's "Orchestrator restarted mid-cycle" failures (2026-08-17) to the second,
 * with container create/delete events for both daemon and one-shot agent containers
 * clustered in the same few seconds beforehand. Each of the three spawn paths called
 * `docker run` independently with zero coordination, so nothing kept them from piling
 * up on dockerd's session at once. This throttles all three to one shared cap.
 *
 * The slot is held only through the container's create + network-join window — the
 * part that actually collided in the incident — not its whole running lifetime.
 * Holding it longer would serialize agent throughput for no reason; releasing on a
 * timer rather than on some "creation finished" signal is a deliberate approximation,
 * since Docker doesn't expose that moment to a CLI-spawning caller.
 */
import { logger } from './logger.js';

const MAX_CONCURRENT_SPAWNS = Number(
  process.env.NANOCREW_MAX_CONCURRENT_SPAWNS ?? 3,
);
const SETTLE_MS = Number(process.env.NANOCREW_SPAWN_SETTLE_MS ?? 3000);

let active = 0;
const waiters: Array<() => void> = [];

/**
 * Non-blocking fast path: grabs a slot and returns true if one is free, without ever
 * awaiting. Callers should use `if (!tryAcquireSpawnSlot()) await waitForSpawnSlot();`
 * rather than always awaiting a wrapper — several call sites spawn synchronously
 * relative to their caller (tests attach event listeners and emit on the child process
 * in the same tick `spawn()` is expected to run), and an unconditional `await`, even on
 * an already-resolved promise, still yields a microtask and reorders that.
 */
export function tryAcquireSpawnSlot(): boolean {
  if (active >= MAX_CONCURRENT_SPAWNS) return false;
  active++;
  return true;
}

/** Blocking path: resolves once a slot frees up. Only call after tryAcquireSpawnSlot() fails. */
export function waitForSpawnSlot(): Promise<void> {
  logger.debug(
    { active, cap: MAX_CONCURRENT_SPAWNS, waiting: waiters.length + 1 },
    'Container spawn throttled — waiting for a free slot',
  );
  return new Promise<void>((resolve) =>
    waiters.push(() => {
      active++;
      resolve();
    }),
  );
}

/**
 * Release a slot after the create/network-join settle window, not immediately —
 * call this right after the `docker run`/spawn call returns.
 */
export function releaseSpawnSlotAfterSettle(): void {
  const t = setTimeout(() => {
    active--;
    const next = waiters.shift();
    if (next) next();
  }, SETTLE_MS);
  t.unref?.();
}

/**
 * Test-only escape hatch. This module is a process-wide singleton, so a spawn slot
 * acquired under `vi.useFakeTimers()` never actually releases (the pending release
 * timer is abandoned on `vi.useRealTimers()`), which silently leaks slots across
 * `it()` blocks in the same file until later tests hang waiting for a slot that will
 * never free. Call this in `beforeEach`/`afterEach` in any suite that exercises a
 * real (unmocked) spawn path under fake timers.
 */
export function _resetSpawnLimiterForTesting(): void {
  active = 0;
  waiters.length = 0;
}
