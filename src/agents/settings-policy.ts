/**
 * Which keys of an agent's own .nanocrew/settings.json actually take effect.
 *
 * Stage 55 phase 1. That file sits inside the agent's `allowed_dir`, so its own
 * `write_file` can create it — verified 2026-09-08 by resolving the path inside the real
 * agent image. And the loop feeds it into `build_permission_policy()`,
 * `build_hook_runner()` and `mcp_servers`. So before this, any agent could write one JSON
 * file and get `danger_full_access`, a shell command on every tool call, and arbitrary
 * subprocesses, from its next cycle. No grant, no audit row, no notification.
 *
 * No agent had found it. But stage 54 had just spent a day telling agents to look at
 * themselves and change whatever is stopping them, which makes an undiscovered escalation
 * path a poor thing to leave lying around.
 *
 * The fix is to govern rather than block: the settings mechanism is genuinely useful and
 * phase 4 opens part of it on purpose.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

import {
  getAgent,
  recordConfigAudit,
  getRouterState,
  setRouterState,
} from '../db.js';
import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { notify } from '../notifications.js';

/**
 * Settings every agent controls for itself. Anything absent is owner-only (see below).
 * These used to need a grant each; per-agent grants were removed on 2026-09-14.
 */
const AGENT_SETTINGS = ['compaction', 'telemetry', 'tools'];

/**
 * `model` is deliberately absent, even though every agent may change its own model.
 *
 * The settings file would be a SECOND path to the same field, and the two are not
 * equivalent: `POST /self/model` probes the model before committing and records
 * lastKnownGoodModel so a broken choice auto-rolls-back after two failed cycles. The
 * settings file has neither. An agent taking the file route would bypass the exact
 * protections that made "any model id" safe to allow in the first place.
 *
 * One governed path per capability. Spotted during the stage 55 rollout, when the policy
 * for a default-grant agent resolved to ["model"] and it was not obvious why it should.
 */

/**
 * Keys that stay owner-only permanently, with the reason attached because a future reader
 * will otherwise assume they were simply forgotten.
 *
 * These are not self-management. They are "execute arbitrary code as this container",
 * which is a different capability wearing the same file:
 *
 *   permissions  - the security posture itself; danger_full_access lives here
 *   hooks        - a shell command run on every tool call
 *   mcp_servers  - arbitrary stdio subprocesses at startup
 */
export const OWNER_ONLY_SETTINGS = [
  'permissions',
  'hooks',
  'mcp_servers',
] as const;

/**
 * The settings keys this agent's cycle may use, or null for "no policy".
 *
 * Null means the container applies the file as it always has. That is the right default
 * for an agent nobody has configured — but note the policy is sent for EVERY agent, so
 * null here only happens if the agent has vanished.
 */
export function resolveSettingsPolicy(agentId: string): string[] | null {
  if (!getAgent(agentId)) return null;
  return [...AGENT_SETTINGS].sort();
}

/**
 * Notice an agent editing its own settings file, whatever the policy then does with it.
 *
 * The policy stops disallowed keys taking effect; it does not tell anyone they were
 * attempted. An agent writing `permissions.mode: "danger_full_access"` is an agent trying
 * to escalate, and that is worth a row even though the attempt fails — arguably more so.
 *
 * Called at cycle start, cheap: one stat + read of a file that usually does not exist.
 */
export function auditSettingsFileChange(agentId: string): void {
  const file = path.join(
    DATA_DIR,
    'agents',
    agentId,
    '.nanocrew',
    'settings.json',
  );
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf-8');
  } catch {
    current = ''; // no file is the normal case
  }

  const hash = current
    ? createHash('sha256').update(current).digest('hex').slice(0, 16)
    : '';
  const previous = getRouterState(`settings-hash:${agentId}`) ?? '';
  if (hash === previous) return;

  setRouterState(`settings-hash:${agentId}`, hash);
  // First sighting of an absent file is not news.
  if (!previous && !hash) return;

  let parsed: Record<string, unknown> = {};
  try {
    parsed = current ? JSON.parse(current) : {};
  } catch {
    parsed = { '<unparseable>': true };
  }
  const keys = Object.keys(parsed);
  const blocked = keys.filter((k) =>
    (OWNER_ONLY_SETTINGS as readonly string[]).includes(k),
  );

  recordConfigAudit({
    agentId,
    capability: 'runtime',
    actor: 'agent',
    before: { settingsHash: previous || null },
    after: { settingsHash: hash || null, keys },
    reason: hash
      ? `Wrote .nanocrew/settings.json (${keys.join(', ') || 'empty'})`
      : 'Removed .nanocrew/settings.json',
  });

  if (blocked.length) {
    // Loud, because this is the one that matters: the keys are refused by the policy,
    // but an agent reaching for them is a fact the owner should hear about the day it
    // happens rather than in a weekly digest.
    const agent = getAgent(agentId);
    notify(
      'agent_alert',
      `${agent?.name ?? agentId} tried to change its own security settings`,
      `It wrote ${blocked.join(', ')} into .nanocrew/settings.json. Those keys are owner-only ` +
        `and were NOT applied — but it asked for them, which is worth knowing. ` +
        `Its History tab has the full diff.`,
      agentId,
    );
    logger.warn(
      { agentId, blocked },
      '[settings-policy] agent attempted an owner-only settings key',
    );
  }
}
