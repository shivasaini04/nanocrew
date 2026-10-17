/**
 * Stage 59 — the one place that decides whether an event may start an agent.
 *
 * See the `WakeSource`/`wakePolicy` doc comment in `types.ts` for why this exists. This
 * module is deliberately tiny: `canWake` is meant to be called from every non-owner,
 * non-scheduler call site that can fire `runCycle`, so the logic it holds needs to be the
 * same logic every one of those sites would otherwise reimplement slightly differently.
 */

import { DEFAULT_WAKE_POLICY, type WakeSource } from '../types.js';

export type { WakeSource };

interface WakeableAgent {
  status?: string;
  config?: { wakePolicy?: Partial<Record<WakeSource, boolean>> };
}

export function getWakePolicy(
  agent: WakeableAgent,
): Record<WakeSource, boolean> {
  return { ...DEFAULT_WAKE_POLICY, ...(agent.config?.wakePolicy ?? {}) };
}

/**
 * `stopped` is a hard floor, not a policy choice: only the owner restarts a stopped agent,
 * the same rule every existing guard site already enforced before this file existed. A
 * per-source policy can turn a trigger off but can never turn `stopped` back on.
 */
export function canWake(agent: WakeableAgent, source: WakeSource): boolean {
  if (agent.status === 'stopped') return false;
  return getWakePolicy(agent)[source];
}
