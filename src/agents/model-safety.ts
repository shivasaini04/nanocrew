/**
 * Keeping an agent from bricking itself on a model that does not answer.
 *
 * Stage 54 phase 3. An agent may now set any model id, not just one from the platform's
 * configured list — the old allowlist was blocking a real need (the free model every agent
 * was pointed at in early September took 43.9s to fail a one-word test, and the agents had
 * no way to move off it) for a reason that was never about security.
 *
 * What it WAS about is real, and is handled here instead. From the route it replaced:
 *
 *   "A model id the proxy has never heard of does not fail here, it fails on every future
 *    cycle — and an agent that has broken its own model cannot run a cycle to fix it."
 *
 * So: probe before committing, and roll back automatically if cycles start dying on model
 * resolution. Two consecutive failures is enough — this is not a rare class of error. On
 * 2026-08-26 alone, 24 cycles died on litellm.NotFoundError.
 */
import { getAgent, updateAgentFields, recordConfigAudit } from '../db.js';
import { logger } from '../logger.js';
import { notify } from '../notifications.js';
import type { AgentConfig } from '../types.js';

/** Consecutive model-resolution failures before an agent is put back on what worked. */
const ROLLBACK_AFTER = 2;

/** Errors that mean "this model id does not resolve", as opposed to a bad request. */
const RESOLUTION_ERROR =
  /NotFoundError|model_not_found|does not exist|unknown model|no such model|404/i;

export function isModelResolutionFailure(
  summary: string | null | undefined,
): boolean {
  return !!summary && RESOLUTION_ERROR.test(summary);
}

/**
 * Ask a model to answer, cheaply, through the same gateway a cycle would use.
 *
 * Turns a bricking into a 422. Returns true when the model is unreachable but for a
 * reason that is not the model's fault — a gateway that is down should not stop an agent
 * configuring itself, and the auto-rollback below is the backstop for that case.
 */
export async function probeModel(
  modelId: string,
  timeoutMs = 20_000,
): Promise<boolean> {
  const proxyUrl = process.env.LITELLM_PROXY_URL;
  const proxyKey = process.env.LITELLM_PROXY_KEY;
  if (!proxyUrl || !proxyKey) {
    logger.warn(
      { modelId },
      '[model-safety] no proxy configured — cannot probe, allowing',
    );
    return true;
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${proxyUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${proxyKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'ok' }],
        max_tokens: 1,
      }),
      signal: ctl.signal,
    });
    if (res.ok) return true;

    // 404/400 from the gateway is the model itself being unknown — the case worth
    // blocking. A 5xx or a rate limit is the gateway having a moment, and blocking on
    // that would make model changes fail for reasons the agent cannot act on.
    const body = await res.text().catch(() => '');
    const unknown =
      res.status === 404 || (res.status === 400 && RESOLUTION_ERROR.test(body));
    if (unknown) {
      logger.info(
        { modelId, status: res.status },
        '[model-safety] probe says this model does not exist',
      );
      return false;
    }
    logger.warn(
      { modelId, status: res.status },
      '[model-safety] probe inconclusive — allowing, rollback is the backstop',
    );
    return true;
  } catch (err) {
    logger.warn(
      { modelId, err: err instanceof Error ? err.message : String(err) },
      '[model-safety] probe failed — allowing',
    );
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/** Remember a model that has demonstrably worked, so there is something to roll back TO. */
export function recordModelWorked(agentId: string): void {
  try {
    const agent = getAgent(agentId);
    if (!agent) return;
    const current = agent.config.model;
    if (!current || agent.config.lastKnownGoodModel === current) return;
    updateAgentFields(agentId, {
      config: { ...agent.config, lastKnownGoodModel: current } as AgentConfig,
    });
  } catch (err) {
    logger.warn(
      { agentId, err: err instanceof Error ? err.message : String(err) },
      '[model-safety] could not record last-known-good',
    );
  }
}

/**
 * Put an agent back on its last working model after repeated resolution failures.
 *
 * Called from the cycle-failure path with the recent failure summaries, newest first.
 * Returns the model rolled back to, or null if nothing was done.
 */
export function rollbackModelIfBricked(
  agentId: string,
  recentFailures: string[],
): string | null {
  const consecutive = recentFailures.slice(0, ROLLBACK_AFTER);
  if (
    consecutive.length < ROLLBACK_AFTER ||
    !consecutive.every(isModelResolutionFailure)
  )
    return null;

  const agent = getAgent(agentId);
  if (!agent) return null;

  const broken = agent.config.model;
  const good = agent.config.lastKnownGoodModel;
  // Nothing to go back to, or already there. Better to leave it visibly broken than to
  // guess at a model nobody has confirmed works for this agent.
  if (!good || good === broken) return null;

  updateAgentFields(agentId, {
    config: { ...agent.config, model: good } as AgentConfig,
  });
  recordConfigAudit({
    agentId,
    capability: 'model',
    actor: 'system',
    before: { model: broken ?? null },
    after: { model: good },
    reason: `${ROLLBACK_AFTER} consecutive cycles failed to resolve "${broken}" — rolled back to the last model that worked`,
  });
  notify(
    'agent_alert',
    `${agent.name} was rolled back to a working model`,
    `Its last ${ROLLBACK_AFTER} cycles failed because "${broken}" could not be resolved. ` +
      `It is now on "${good}", which is the last model it completed a cycle on.`,
    agentId,
  );
  logger.warn(
    { agentId, broken, good },
    '[model-safety] rolled an agent back to its last known good model',
  );
  return good;
}
