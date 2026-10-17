/**
 * The container's end of the real-browser lane (stage 45 doc 05, phase 3).
 *
 * An agent cycle running in a container calls these to drive the user's browser through
 * the broker. Everything below is what `RemotePage` in the nanoagent package talks to.
 *
 * AUTH, and why it is not the pattern next door. The other container callbacks
 * (`/cycles/:cycleId/steps`, `/frame`) are unauthenticated by design, with the agent and
 * cycle UUIDs as the bearer — defensible for pushing a screenshot into a live view, where
 * the worst case is a forged frame in a dashboard. It is nowhere near enough here. This
 * route moves a real mouse in a browser that is signed into the user's email and bank, so
 * it requires the per-cycle token from cycle-token.ts, the same gate self-management uses,
 * and the token is bound to one agent id.
 *
 * The scope is derived, never accepted: the caller names an agent, and the principal comes
 * from that agent's OWNER. A cycle cannot address a browser belonging to anyone else, no
 * matter what it puts in the body.
 */
import { Router } from 'express';

import { getAgent, updateAgentCycle } from '../../db.js';
import {
  browserBroker,
  derivePrincipal,
  ControllerUnavailable,
  type Capability,
  type ControllerScope,
} from '../../agents/browser-broker.js';
import {
  verifyCycleToken,
  extractCycleToken,
  resolveCycleToken,
} from '../../agents/cycle-token.js';
import { logger } from '../../logger.js';

export const browserControlDispatchRouter = Router();

/**
 * Cycles already marked as having reached the user's browser, so the promotion below is
 * one write rather than one per command.
 *
 * In-memory on purpose: it is a de-duplication cache, not state. Losing it on restart
 * costs a redundant UPDATE that writes the value already there.
 */
const promotedCycles = new Set<string>();

/**
 * Record that this cycle really drove the user's browser.
 *
 * The cycle row's `lane` used to be written once, up front, from the ROUTING decision —
 * which was the same thing as actual use only while the lane was a per-cycle property.
 * It stopped being one when `identity` moved the choice to the individual tool call: an
 * opted-in cycle that sweeps hundreds of public pages anonymously never touches that
 * browser, and was still badged "YOUR BROWSER — this cycle drove the browser on your
 * machine". A claim about someone's own machine should be earned by a command arriving,
 * which is exactly what this route is.
 *
 * Called only after a dispatch SUCCEEDS. A command that failed because nothing was
 * attached is not use.
 */
function notePromotion(token: string | undefined | null): void {
  const rec = resolveCycleToken(token);
  if (!rec?.cycleId || promotedCycles.has(rec.cycleId)) return;
  promotedCycles.add(rec.cycleId);
  // Never let bookkeeping break the command it is describing — the same rule the
  // memory-decay FK crash taught. The browser has already done the work by here.
  try {
    updateAgentCycle(rec.cycleId, { lane: 'user-browser' });
  } catch (err) {
    logger.debug(
      { err, cycleId: rec.cycleId },
      'could not mark the cycle as user-browser',
    );
  }
}

/** Same shape as self-manage.ts's gate: a live token minted for THIS agent. */
function requireCycleToken(
  req: { headers: Record<string, unknown>; body?: unknown },
  agentId: string,
): boolean {
  const token = extractCycleToken(
    req.headers.authorization as string | undefined,
    req.headers['x-cycle-token'] as string | undefined,
  );
  return verifyCycleToken(token, agentId);
}

function scopeForAgent(
  agentId: string,
  browserProfileId: string,
  controllerId: string,
): ControllerScope | null {
  const agent = getAgent(agentId);
  if (!agent?.owner_id) return null;
  return {
    principal: derivePrincipal(agent.owner_id),
    browserProfileId,
    controllerId,
  };
}

/**
 * POST /api/agents/:id/browser-control/dispatch
 * Body: { capability, payload, controllerId, browserProfileId?, toolCallId?, timeoutMs? }
 */
browserControlDispatchRouter.post(
  '/:id/browser-control/dispatch',
  async (req, res) => {
    const agentId = String(req.params.id ?? '');
    if (!requireCycleToken(req as never, agentId)) {
      logger.warn(
        { agentId },
        'browser-control dispatch rejected — invalid or expired cycle token',
      );
      res.status(401).json({ error: 'Invalid or expired cycle token' });
      return;
    }

    const {
      capability,
      payload,
      controllerId,
      browserProfileId = 'default',
      toolCallId,
      timeoutMs,
    } = (req.body ?? {}) as {
      capability?: string;
      payload?: unknown;
      controllerId?: string;
      browserProfileId?: string;
      toolCallId?: string;
      timeoutMs?: number;
    };

    if (typeof capability !== 'string' || !capability) {
      res.status(400).json({ error: 'capability is required' });
      return;
    }
    if (typeof controllerId !== 'string' || !controllerId) {
      res.status(400).json({ error: 'controllerId is required' });
      return;
    }

    const scope = scopeForAgent(agentId, browserProfileId, controllerId);
    if (!scope) {
      res.status(404).json({ error: 'Unknown agent, or agent has no owner' });
      return;
    }

    try {
      const result = await browserBroker.dispatch(
        scope,
        capability as Capability,
        payload ?? {},
        {
          toolCallId,
          // Clamped: a container asking for an hour would pin a waiter and, with it, a
          // browser the user is trying to use.
          timeoutMs: Math.min(
            Math.max(Number(timeoutMs) || 30_000, 1_000),
            120_000,
          ),
        },
      );
      notePromotion(
        extractCycleToken(
          req.headers.authorization as string | undefined,
          req.headers['x-cycle-token'] as string | undefined,
        ),
      );
      res.json({ ok: true, result });
    } catch (err) {
      // A missing controller is the normal case when nobody has connected the extension,
      // so it is a 409 rather than a 500 — the caller can act on it (tell the user to
      // connect) instead of treating it as a server fault.
      const status = err instanceof ControllerUnavailable ? 409 : 500;
      res
        .status(status)
        .json({ ok: false, error: String((err as Error).message ?? err) });
    }
  },
);

/**
 * GET /api/agents/:id/browser-control/status — is a browser connected for this agent's
 * owner, and which controller? Lets a cycle decide whether the remote lane is available
 * before it plans around it.
 */
browserControlDispatchRouter.get('/:id/browser-control/status', (req, res) => {
  const agentId = String(req.params.id ?? '');
  if (!requireCycleToken(req as never, agentId)) {
    res.status(401).json({ error: 'Invalid or expired cycle token' });
    return;
  }
  const controllerId = String(req.query.controllerId ?? '');
  const scope = controllerId
    ? scopeForAgent(
        agentId,
        String(req.query.browserProfileId ?? 'default'),
        controllerId,
      )
    : null;
  if (!scope) {
    res.json({ attached: false, online: false });
    return;
  }
  res.json({
    attached: browserBroker.isAttached(scope),
    online: browserBroker.isOnline(scope),
    // stage 52 step 3: which lane this is. RemotePage reads it once and decides
    // whether its elements can be located or must be aimed at by coordinate.
    capabilities: browserBroker.capabilitiesFor(scope),
  });
});
