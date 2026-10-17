/**
 * Which lane a cycle runs on, and what to do when the one it needs is not there
 * (stage 52 step 4).
 *
 * ## The gap this closes
 *
 * Before this, one flag meant two different things. `useUserBrowser: true` made the runner
 * look for an attached controller and, finding none, run in the container anyway —
 * logging "no browser is connected — running in the container" and carrying on. For an
 * agent whose job happens to be nicer in a real browser, that is right. For an agent whose
 * job is IMPOSSIBLE without the user's logged-in session, it is the worst available
 * outcome: the cycle runs, hits an auth wall, reports "no results", and bills for it.
 *
 * Nobody finds out. It is the exact failure shape recorded in
 * `reference_agent_records_are_not_evidence` and in the silent-paywall incident, where an
 * agent ran zero useful cycles for 35 hours and the records looked ordinary.
 *
 * So the two meanings are separated:
 *
 *   useUserBrowser      PREFER the user's browser; container is an acceptable fallback
 *   requireUserBrowser  the work NEEDS that browser; do not pretend without it
 *
 * ## Why "defer" and not "fail"
 *
 * A laptop being shut is not an error. It is the normal state of a laptop at 3am, which
 * is precisely when the cloud half of this product is supposed to be working. Marking the
 * cycle failed would fill the agent's history with red that means nothing, and — worse —
 * teach whoever reads it that red is noise.
 *
 * A deferred cycle costs nothing, records why it waited, and runs when the companion comes
 * back. That is what makes local-vs-cloud a scheduling detail rather than a product fork,
 * which is the whole argument in docs/research/stage52-companion/README.md.
 */

/** What the routing decided, and why. The reason is for a human, not a switch. */
export interface LaneDecision {
  /**
   * 'container' | 'user-browser' | 'defer' | 'unavailable'
   *
   * 'unavailable' is 'defer' for a person who is waiting on the answer: they picked
   * their own browser for this message and it is not connected. Deferring would leave
   * them staring at a chat that never replies, so the run says why and stops instead.
   */
  lane: 'container' | 'user-browser' | 'defer' | 'unavailable';
  /** The controller to drive, when lane is 'user-browser'. */
  controllerId?: string;
  /** Plain-English why. Shown in the cycle summary when deferred. */
  reason: string;
}

/**
 * What one particular RUN needs, overriding the agent's standing preference.
 *
 * The agent-level flags describe a habit; a single job can want the opposite. The case
 * that prompted this: an agent opted into the user's browser still has work that is
 * BETTER in the container — public scraping, where the stealth stack and the datacenter
 * IP are the point rather than an obstacle. Before this, any opted-in cycle took the
 * user's browser whether or not that helped, and the only way to change it was to
 * reconfigure the agent.
 *
 *   'local'      this run needs the user's session; defer if there is none
 *   'container'  this run should stay in the container even if a browser is attached
 *   undefined    follow the agent's configuration (the ordinary case)
 */
export type LaneHint = 'local' | 'container';

export interface LaneInputs {
  /** Prefer the user's browser when one is attached. */
  useUserBrowser?: boolean;
  /** The work is impossible without it — defer rather than run without. */
  requireUserBrowser?: boolean;
  /** This run's own need, which wins over the agent's configuration. */
  laneHint?: LaneHint;
  /** Controllers currently online for this agent's owner. */
  attachedControllerIds: readonly string[];
  /** False when the agent has no owner, so no browser could ever be found. */
  hasOwner: boolean;
  /**
   * A person is waiting on this run (a chat message). Changes what an unmet requirement
   * does: tell them now, rather than defer until a browser connects.
   */
  interactive?: boolean;
}

/**
 * The chat's browser picker, as a lane hint (stage 60 phase 1).
 *
 * The picker under the chat input is the operator deciding, per message, which browser
 * the agent may use: 'local' is the desktop app's browser, signed in as them; 'cloud' is
 * the container's. Anything else — an older dashboard that sends nothing — leaves the
 * agent's own configuration in charge, exactly as before the picker existed.
 */
export function laneHintFromChoice(choice: unknown): LaneHint | undefined {
  if (choice === 'local') return 'local';
  if (choice === 'cloud') return 'container';
  return undefined;
}

/**
 * Decide the lane. Pure: no clock, no database, no broker.
 *
 * Kept free of dependencies deliberately — this is the one piece of stage 52 whose bugs
 * are silent (a wrong answer runs the wrong lane rather than throwing), so it has to be
 * cheap to test exhaustively.
 */
export function decideLane(input: LaneInputs): LaneDecision {
  // A run that explicitly wants the container gets it, whatever the agent prefers.
  // Checked first because it is an instruction, not a preference — there is nothing
  // for the rest of the logic to weigh against it.
  if (input.laneHint === 'container') {
    return {
      lane: 'container',
      reason: 'this run asked to stay in the container',
    };
  }

  const wants =
    input.useUserBrowser === true ||
    input.requireUserBrowser === true ||
    input.laneHint === 'local';
  // A run asking for 'local' is asking for the session, not merely preferring it —
  // running without it would produce the silent auth-wall failure this module exists
  // to prevent.
  const requires =
    input.requireUserBrowser === true || input.laneHint === 'local';

  if (!wants) {
    return {
      lane: 'container',
      reason: 'agent is not configured to use the user browser',
    };
  }

  if (!input.hasOwner) {
    // No owner means no principal, so no controller can ever match. Requiring a
    // browser here would defer for ever, which is a worse answer than saying why.
    return requires
      ? {
          lane: 'defer',
          reason:
            'agent requires the user browser but has no owner to attach one',
        }
      : {
          lane: 'container',
          reason: 'agent has no owner, so no user browser could be found',
        };
  }

  const controllerId = input.attachedControllerIds[0];
  if (controllerId) {
    return {
      lane: 'user-browser',
      controllerId,
      reason: 'a browser is attached',
    };
  }

  if (requires && input.interactive && input.laneHint === 'local') {
    return {
      lane: 'unavailable',
      reason:
        "you chose This computer's browser, but the NanoCrew desktop app is not " +
        'connected. Open the desktop app (and sign in), or switch the browser ' +
        'picker under the message box to Cloud.',
    };
  }

  if (requires) {
    return {
      lane: 'defer',
      reason:
        'this agent requires the user browser and none is connected — waiting for ' +
        'the companion rather than running without the session it needs',
    };
  }

  return {
    lane: 'container',
    reason:
      'agent prefers the user browser, but none is connected — running in the container',
  };
}

/**
 * Agents whose cycle was deferred for want of a browser, so a companion connecting can
 * wake them.
 *
 * In memory on purpose. A deferral is only meaningful while this process is the one
 * holding the schedule; after a restart the ordinary scheduler retries anyway, and a
 * persisted queue would resurrect intentions the user may have changed hours ago.
 */
class DeferredForBrowser {
  private waiting = new Map<
    string,
    { principal: string; at: number; reason: string }
  >();

  /** Record that this agent wanted a browser and did not get one. */
  note(agentId: string, principal: string, reason: string): void {
    this.waiting.set(agentId, { principal, at: Date.now(), reason });
  }

  /** Agents waiting on this principal's browser. Clears them — waking is one-shot. */
  takeFor(principal: string): string[] {
    const woken: string[] = [];
    for (const [agentId, entry] of this.waiting) {
      if (entry.principal !== principal) continue;
      woken.push(agentId);
      this.waiting.delete(agentId);
    }
    return woken;
  }

  /** Drop one agent — it ran, or was reconfigured. */
  clear(agentId: string): void {
    this.waiting.delete(agentId);
  }

  isWaiting(agentId: string): boolean {
    return this.waiting.has(agentId);
  }

  size(): number {
    return this.waiting.size;
  }

  /** For diagnostics: who is waiting and since when. */
  list(): Array<{
    agentId: string;
    principal: string;
    at: number;
    reason: string;
  }> {
    return [...this.waiting].map(([agentId, e]) => ({ agentId, ...e }));
  }
}

export const deferredForBrowser = new DeferredForBrowser();
