/**
 * Stage 57 — "results are data, never instructions" (docs 17 §1).
 *
 * A worker reads untrusted pages; its result reaches the boss, which can send email and
 * holds private data. A poisoned page → a worker's result → the boss acting on it is the
 * prompt-infection path. So once an agent has been handed worker results, its "don't ask"
 * approval rules stop applying for a while: anything it wants to send, change or click
 * waits for a person, whatever the owner's auto-approve rules say.
 *
 * Coarser than CaMeL's per-value provenance on purpose — a whole-cycle taint needs no
 * change to every tool, and it errs toward asking.
 *
 * Two parts. A fixed window from the moment of reading covers turns that are not cycles
 * (chat) and the gap before a woken cycle starts. And a cycle that is running while the
 * agent is tainted stays tainted until it ends — it was 35 minutes flat, "past the longest
 * cycle", until 2026-09-30 removed the wall-clock limit on cycles (agents/liveness.ts).
 * A three-hour cycle that read worker results in minute five would otherwise have its
 * owner's auto-approve rules back by minute forty.
 */
const TAINT_MS = 35 * 60_000;
const taintedUntil = new Map<string, number>();
const inCycle = new Set<string>();
const taintedForCycle = new Set<string>();

function windowOpen(agentId: string, now: number): boolean {
  const until = taintedUntil.get(agentId);
  if (until === undefined) return false;
  if (until <= now) {
    taintedUntil.delete(agentId);
    return false;
  }
  return true;
}

export function markTaintedByWorkerData(
  agentId: string,
  now = Date.now(),
): void {
  taintedUntil.set(
    agentId,
    Math.max(taintedUntil.get(agentId) ?? 0, now + TAINT_MS),
  );
  if (inCycle.has(agentId)) taintedForCycle.add(agentId);
}

export function isTaintedByWorkerData(
  agentId: string,
  now = Date.now(),
): boolean {
  return taintedForCycle.has(agentId) || windowOpen(agentId, now);
}

/** A cycle is starting. If the agent is tainted now, the whole cycle is. */
export function noteCycleStart(agentId: string, now = Date.now()): void {
  inCycle.add(agentId);
  if (windowOpen(agentId, now)) taintedForCycle.add(agentId);
}

/** The cycle ended. What remains is whatever is left of the fixed window. */
export function noteCycleEnd(agentId: string): void {
  inCycle.delete(agentId);
  taintedForCycle.delete(agentId);
}

/** Test-only. */
export function _resetTaint(): void {
  taintedUntil.clear();
  inCycle.clear();
  taintedForCycle.clear();
}
