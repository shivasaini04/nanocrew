/**
 * Whether a failed `daemonPool.run` should re-run the cycle in a one-shot container.
 *
 * Yes when the daemon itself broke — it could not start, its stdin broke, it died
 * mid-request. No when it went silent (liveness.ts) or hit a hard ceiling: re-running a
 * wedged or over-long cycle from turn zero does not un-wedge it ("timed out after" is the
 * wording from before cycles had no wall-clock limit).
 *
 * An error the agent REPORTS never reaches this: finalizeOutput is called outside the daemon
 * try. It used to be inside, so a model failure read as a broken daemon and the one-shot
 * started the whole task over on a fresh CONTAINER_TIMEOUT — Crawler a live cycle
 * (2026-09-11) did 12 minutes of work, hit a retired fallback model, re-ran from scratch
 * for 50 more minutes and timed out with nothing written.
 */
export function shouldFallBackToOneShot(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return !/timed out after|went silent|ran past its/i.test(msg);
}
