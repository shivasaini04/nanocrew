/**
 * Daily digest of what your agents changed about themselves.
 *
 * The reading half of stage 54 phase 1. A table nobody looks at is not a safety net, and
 * the two failures this phase exists to catch were both invisible for over a week — not
 * because nothing recorded them, but because nothing surfaced them.
 *
 * **A digest, deliberately, not a per-change alert.** Six agents changing settings freely
 * produce real volume, and an alert stream that fires thirty times a day gets muted — at
 * which point you are back where you started, except now it feels like coverage. One
 * notification a day, listing everything, is the version that keeps getting read.
 *
 * The exception is the loud line: a change that removed a lot of content leads the digest
 * regardless of how quiet the day was. That is the shape of the 2026-08-28 prompt loss,
 * and it is the one thing worth interrupting for.
 */
import {
  getAllAgents,
  getConfigAuditByOwner,
  createNotification,
} from '../db.js';
import { logger } from '../logger.js';
import { findWaitingCycles, renderWaitingCycles } from './waiting-cycles.js';

/** How much smaller a change has to make something before it leads the digest. */
const SHRINK_ALERT_BYTES = 200;

/** Capabilities worth naming individually in the summary line. */
const NOTABLE = new Set(['identity', 'status', 'budget']);

function sizeDelta(beforeJson: string, afterJson: string): number {
  return afterJson.length - beforeJson.length;
}

/**
 * Build and post one digest per owner for the last `hours`.
 *
 * Returns the number of notifications created, so the caller (and a test) can tell
 * "nothing happened" from "it did not run".
 */
export function runConfigAuditDigest(hours = 24): number {
  const since = new Date(Date.now() - hours * 3600_000).toISOString();
  const owners = new Set(
    getAllAgents()
      .map((a) => a.owner_id)
      .filter((o): o is string => !!o),
  );

  // One graph for the whole platform; each owner sees only cycles among its own agents
  // by construction, since a handoff can only exist between two agents of one owner.
  let waitingCycles: ReturnType<typeof findWaitingCycles> = [];
  try {
    waitingCycles = findWaitingCycles();
    if (waitingCycles.length > 0) {
      logger.warn(
        { cycles: waitingCycles.map((c) => c.path.join(' -> ')) },
        '[audit-digest] agents are waiting on each other',
      );
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      '[audit-digest] waiting-cycle scan failed',
    );
  }

  let sent = 0;
  for (const ownerId of owners) {
    let rows;
    try {
      rows = getConfigAuditByOwner(ownerId, since);
    } catch (err) {
      logger.error(
        { ownerId, err: err instanceof Error ? err.message : String(err) },
        '[audit-digest] query failed',
      );
      continue;
    }
    if (rows.length === 0 && waitingCycles.length === 0) continue;

    // Owner edits are not news — you already know what you did. Report what the
    // agents and the platform did on their own.
    const selfMade = rows.filter(
      (r) => r.actor === 'agent' || r.actor === 'system',
    );
    // A deadlock is reportable on its own. Skipping a quiet owner would hide exactly
    // the case this check exists for: agents stuck waiting are agents changing nothing.
    if (selfMade.length === 0 && waitingCycles.length === 0) continue;

    const shrinks = selfMade.filter(
      (r) => sizeDelta(r.before_json, r.after_json) <= -SHRINK_ALERT_BYTES,
    );
    const byAgent = new Map<string, number>();
    for (const r of selfMade)
      byAgent.set(r.agent_name, (byAgent.get(r.agent_name) ?? 0) + 1);

    const caps = [...new Set(selfMade.map((r) => r.capability))];
    const notable = caps.filter((c) => NOTABLE.has(c));

    const deadlocks = renderWaitingCycles(waitingCycles);

    // A deadlock outranks a shrink, and both outrank a routine count. An owner whose
    // agents are stuck waiting on each other should not read "3 self-changes" as the
    // headline of the message that tells them so.
    const title =
      waitingCycles.length > 0
        ? `${waitingCycles.length} pair${waitingCycles.length === 1 ? '' : 's'} of agents waiting on each other`
        : shrinks.length > 0
          ? `${shrinks.length} change${shrinks.length === 1 ? '' : 's'} removed content — review`
          : `${selfMade.length} self-change${selfMade.length === 1 ? '' : 's'} across ${byAgent.size} agent${byAgent.size === 1 ? '' : 's'}`;

    const lines: string[] = [];
    if (shrinks.length > 0) {
      lines.push('Removed content:');
      for (const r of shrinks) {
        const d = Math.abs(
          sizeDelta(r.before_json, r.after_json),
        ).toLocaleString();
        lines.push(
          `  ${r.agent_name} · ${r.capability} · −${d} bytes · ${r.reason ?? 'no reason given'}`,
        );
      }
      lines.push('');
    }
    // Stage 56 — agents waiting on each other. Reported here rather than in its own
    // notification because it belongs with "what did the crew do on its own", and
    // because a deadlock is precisely the kind of thing that is invisible unless
    // something goes looking: both sides read healthy.
    if (deadlocks) {
      lines.push(deadlocks, '');
    }

    if (selfMade.length > 0) {
      lines.push('All changes:');
      for (const [name, n] of byAgent) lines.push(`  ${name}: ${n}`);
    }
    if (notable.length) lines.push('', `Touched: ${notable.join(', ')}`);
    lines.push(
      '',
      'Open an agent and its History tab to see the diff or revert.',
    );

    try {
      createNotification({
        type: 'config_audit_digest',
        title,
        body: lines.join('\n'),
        agent_id: null,
        meta: {
          ownerId,
          windowHours: hours,
          total: selfMade.length,
          shrinks: shrinks.length,
          entryIds: selfMade.slice(0, 50).map((r) => r.id),
        },
      });
      sent++;
    } catch (err) {
      logger.error(
        { ownerId, err: err instanceof Error ? err.message : String(err) },
        '[audit-digest] notification failed',
      );
    }
  }

  logger.info(
    { owners: owners.size, notifications: sent, windowHours: hours },
    '[audit-digest] run complete',
  );
  return sent;
}
