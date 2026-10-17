/**
 * Apply the owner's approval rules to a just-created check-in.
 *
 * There are TWO `POST /api/agents/:id/checkins` routes: the dashboard's (agents.ts, behind
 * session auth) and the internal one containers actually reach (server.ts, mounted above
 * auth). The first version of approval rules only checked the dashboard copy, so a live
 * test's "emails to me: don't ask" rule never fired for the agent's own sends. Both routes
 * call this, so they cannot drift apart again.
 */
import { agentService } from './agent-registry.js';
import { getUserById } from '../db.js';
import {
  actionForCheckin,
  evaluateApproval,
  describeRule,
} from './approval-policy.js';
import type { AgentConfig } from '../types.js';
import { isTaintedByWorkerData } from '../swarm/taint.js';
import { logger } from '../logger.js';

export interface AutoApproval {
  autoApproved: true;
  executed: boolean;
  rule: string;
  actionResult: string;
}

/** Null when no "don't ask" rule covers it — the check-in then waits as always. */
export async function autoApproveIfRuled(
  agent: { id: string; owner_id?: string | null; config: AgentConfig },
  checkin: {
    id: string;
    status: string;
    action_type?: string | null;
    action_payload?: string | null;
  },
): Promise<AutoApproval | null> {
  if (checkin.status !== 'pending') return null;
  // Stage 57: this agent has been handed worker results (web data) recently. Anything it
  // now wants to send could have been steered by a page a worker read — ask the owner,
  // whatever "don't ask" rules say.
  if (isTaintedByWorkerData(agent.id)) {
    logger.info(
      { agentId: agent.id, checkinId: checkin.id },
      'auto-approval skipped — agent recently read worker results',
    );
    return null;
  }
  let payload: unknown = null;
  try {
    payload = checkin.action_payload
      ? JSON.parse(checkin.action_payload)
      : null;
  } catch {
    /* leave null */
  }
  const mapped = actionForCheckin(checkin.action_type, payload);
  if (!mapped) return null;
  const ownerEmail = agent.owner_id
    ? (getUserById(agent.owner_id)?.email ?? null)
    : null;
  const rule = evaluateApproval(
    agent.config.approvalRules,
    mapped.action,
    mapped.ctx,
    ownerEmail,
  );
  if (rule?.decision !== 'auto') return null;
  const label = describeRule(rule);
  const outcome = await agentService.autoApproveCheckin(
    agent.id,
    checkin.id,
    label,
  );
  return {
    autoApproved: true,
    executed: outcome.ok,
    rule: label,
    actionResult: outcome.result,
  };
}
