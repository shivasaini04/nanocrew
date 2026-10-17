/**
 * Waking an agent when its browser arrives (stage 52 step 4).
 *
 * ## Why this is a registered callback and not an import
 *
 * The socket layer has no business knowing about AgentService, and importing it here
 * would close a loop: agent-service -> nanobot-cycle-runner -> local-lane-routing, and
 * browser-control-ws -> agent-service. ESM tolerates some cycles and then does not, in
 * ways that surface as an undefined import at runtime rather than a build error.
 *
 * So the direction of knowledge is inverted: whoever owns the agent service registers a
 * waker at startup, and this module holds it. The socket calls a function; it never
 * learns what is on the other end.
 *
 * ## Why an unregistered waker is not an error
 *
 * Tests, and any process that serves the browser socket without running agents, will
 * never register one. A companion attaching there should be an ordinary no-op, not a
 * crash — so the default is a function that does nothing and says so at debug level.
 */
import { logger } from '../logger.js';
import {
  localFollowups,
  type LocalFollowup,
} from '../agents/local-followups.js';

export type AgentWaker = (agentId: string) => Promise<unknown>;

let waker: AgentWaker | null = null;

/** Stage 60 phase 6: runs one queued piece of work on the user's computer. */
export type FollowupRunner = (followup: LocalFollowup) => Promise<unknown>;

let followupRunner: FollowupRunner | null = null;

export function registerFollowupRunner(fn: FollowupRunner | null): void {
  followupRunner = fn;
}

/** Run everything queued for this owner's computer. Never throws, like the waker. */
export function runFollowupsOnAttach(principal: string): number {
  if (!followupRunner) return 0;
  const due = localFollowups.takeFor(principal);
  for (const f of due) {
    void followupRunner(f).catch((err) => {
      logger.warn(
        { agentId: f.agentId, followup: f.id, err: String(err) },
        'queued work for the computer failed to start',
      );
    });
  }
  if (due.length)
    logger.info(
      { principal: principal.slice(0, 8), count: due.length },
      'computer connected — running queued work',
    );
  return due.length;
}

/**
 * Register how to wake an agent. Called once at startup by the module that owns the
 * agent service; a second call replaces the first, which is what makes it testable.
 */
export function registerAgentWaker(fn: AgentWaker | null): void {
  waker = fn;
}

/**
 * Run an agent that was deferred waiting for a browser.
 *
 * Never throws: this runs inside a socket's attach handler, and a failed wake must not
 * take down the connection that just arrived. The ordinary schedule retries anyway, so
 * the worst case of a swallowed failure is the delay we were trying to remove — not a
 * lost cycle.
 */
export async function triggerAgentOnBrowserAttach(
  agentId: string,
): Promise<void> {
  if (!waker) {
    logger.debug(
      { agentId },
      'browser attached but no agent waker is registered',
    );
    return;
  }
  try {
    await waker(agentId);
  } catch (err) {
    logger.warn(
      { agentId, err: String(err) },
      'waking a deferred agent failed',
    );
  }
}
