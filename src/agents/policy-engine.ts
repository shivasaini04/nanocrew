/**
 * Policy Engine — JSON-serializable rule DSL evaluated on every lane event.
 *
 * Ported from claw-code-main/rust/crates/runtime/src/policy_engine.rs.
 *
 * Rules are sorted by priority (higher = evaluated first). First matching rule
 * fires its action. Use a `chain` action to fire multiple actions from one rule.
 *
 * Rules ship in `.nanocrew/settings.json` under `"policy_rules"` (array).
 * The three built-in rules below are always present at the lowest priority,
 * so user rules always take precedence.
 */

import { logger } from '../logger.js';
import type { LaneEvent, LaneFailureClass, LaneState } from './lane-events.js';

// ─── Condition DSL ────────────────────────────────────────────────────────────

export type PolicyCondition =
  | { kind: 'and'; conditions: PolicyCondition[] }
  | { kind: 'or'; conditions: PolicyCondition[] }
  | { kind: 'not'; condition: PolicyCondition }
  | { kind: 'always' }
  | { kind: 'event_is'; type: LaneEvent['type'] }
  | { kind: 'lane_red'; lane?: string }
  | { kind: 'lane_green'; lane?: string }
  | { kind: 'lane_blocked'; lane?: string }
  | { kind: 'failure_class_is'; class: LaneFailureClass }
  | { kind: 'red_streak_gte'; n: number }
  | { kind: 'timed_out_since'; ms: number } // lane has been red for >= ms
  | { kind: 'agent_is'; agentId: string };

// ─── Action DSL ───────────────────────────────────────────────────────────────

export type PolicyAction =
  | { kind: 'retry_cycle'; cycleType?: string }
  | { kind: 'recover_once'; scenario: string }
  | { kind: 'escalate'; to: string; message: string }
  | { kind: 'notify'; channel: string; text: string }
  | { kind: 'block_lane'; reason: string }
  | { kind: 'chain'; actions: PolicyAction[] }
  | { kind: 'log'; message: string };

// ─── Rule ─────────────────────────────────────────────────────────────────────

export interface PolicyRule {
  name: string;
  /** Higher priority rules are evaluated first. Default: 0. */
  priority: number;
  when: PolicyCondition;
  then: PolicyAction;
  /** If false this rule is loaded but skipped. Default: true. */
  enabled?: boolean;
}

// ─── Action handler interface ─────────────────────────────────────────────────

export interface ActionHandler {
  retryAgentCycle(agentId: string, cycleType?: string): Promise<void>;
  recoverOnce(agentId: string, scenario: string, lane: string): Promise<void>;
  notify(channel: string, text: string): Promise<void>;
  blockLane(agentId: string, lane: string, reason: string): void;
}

// ─── Evaluation context ───────────────────────────────────────────────────────

interface EvalCtx {
  event: LaneEvent;
  laneState: LaneState | undefined;
  agentId: string;
  lane: string;
  nowMs: number;
}

// ─── PolicyEngine ─────────────────────────────────────────────────────────────

export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private handler: ActionHandler;

  constructor(handler: ActionHandler, initialRules: PolicyRule[] = []) {
    this.handler = handler;
    this.loadRules([...DEFAULT_RULES, ...initialRules]);
  }

  /** Replace / extend the rule set. Rules are re-sorted by priority desc. */
  loadRules(rules: PolicyRule[]): void {
    this.rules = [...rules].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0),
    );
    logger.info({ count: this.rules.length }, 'PolicyEngine: rules loaded');
  }

  /** Append additional rules (e.g., from settings reload). */
  addRules(rules: PolicyRule[]): void {
    this.loadRules([...this.rules, ...rules]);
  }

  /**
   * Evaluate all rules against the event + current lane state.
   * The first enabled matching rule fires; subsequent rules are skipped.
   */
  async evaluate(
    event: LaneEvent,
    laneState: LaneState | undefined,
  ): Promise<void> {
    const agentId =
      'agentId' in event ? ((event as any).agentId as string) : '';
    const lane = 'lane' in event ? ((event as any).lane as string) : '';

    const ctx: EvalCtx = {
      event,
      laneState,
      agentId,
      lane,
      nowMs: Date.now(),
    };

    for (const rule of this.rules) {
      if (rule.enabled === false) continue;
      if (!this._evalCondition(rule.when, ctx)) continue;

      logger.info(
        { rule: rule.name, agentId, lane },
        'PolicyEngine: rule matched',
      );
      try {
        await this._runAction(rule.then, ctx);
      } catch (err) {
        logger.warn({ rule: rule.name, err }, 'PolicyEngine: action error');
      }
      break; // first match wins
    }
  }

  // ── Condition evaluator ───────────────────────────────────────────────────

  private _evalCondition(cond: PolicyCondition, ctx: EvalCtx): boolean {
    switch (cond.kind) {
      case 'always':
        return true;

      case 'event_is':
        return ctx.event.type === cond.type;

      case 'and':
        return cond.conditions.every((c) => this._evalCondition(c, ctx));

      case 'or':
        return cond.conditions.some((c) => this._evalCondition(c, ctx));

      case 'not':
        return !this._evalCondition(cond.condition, ctx);

      case 'lane_red': {
        const st = ctx.laneState;
        const laneMatch = !cond.lane || cond.lane === ctx.lane;
        return laneMatch && st?.currentStatus === 'red';
      }

      case 'lane_green': {
        const st = ctx.laneState;
        const laneMatch = !cond.lane || cond.lane === ctx.lane;
        return laneMatch && st?.currentStatus === 'green';
      }

      case 'lane_blocked': {
        const st = ctx.laneState;
        const laneMatch = !cond.lane || cond.lane === ctx.lane;
        return laneMatch && st?.currentStatus === 'blocked';
      }

      case 'failure_class_is':
        return ctx.laneState?.failureClass === cond.class;

      case 'red_streak_gte':
        return (ctx.laneState?.redStreak ?? 0) >= cond.n;

      case 'timed_out_since': {
        const lastRedAt = ctx.laneState?.lastRedAt;
        if (!lastRedAt) return false;
        return ctx.nowMs - Date.parse(lastRedAt) >= cond.ms;
      }

      case 'agent_is':
        return ctx.agentId === cond.agentId;

      default:
        return false;
    }
  }

  // ── Action runner ─────────────────────────────────────────────────────────

  private async _runAction(action: PolicyAction, ctx: EvalCtx): Promise<void> {
    switch (action.kind) {
      case 'log':
        logger.info(
          { agentId: ctx.agentId, lane: ctx.lane },
          `Policy: ${action.message}`,
        );
        break;

      case 'retry_cycle':
        await this.handler.retryAgentCycle(ctx.agentId, action.cycleType);
        break;

      case 'recover_once':
        await this.handler.recoverOnce(ctx.agentId, action.scenario, ctx.lane);
        break;

      case 'escalate':
        await this.handler.notify(action.to, action.message);
        break;

      case 'notify':
        await this.handler.notify(action.channel, action.text);
        break;

      case 'block_lane':
        this.handler.blockLane(ctx.agentId, ctx.lane, action.reason);
        break;

      case 'chain':
        for (const sub of action.actions) {
          await this._runAction(sub, ctx);
        }
        break;
    }
  }
}

// ─── Built-in default rules ───────────────────────────────────────────────────

/**
 * Three built-in rules at the lowest priority tier (0–10).
 * User rules should use priority >= 100 to override these.
 */
export const DEFAULT_RULES: PolicyRule[] = [
  {
    name: 'retry-on-prompt-misdelivery',
    priority: 10,
    enabled: true,
    when: {
      kind: 'and',
      conditions: [
        { kind: 'lane_red' },
        {
          kind: 'failure_class_is',
          class: 'PromptDelivery' as LaneFailureClass,
        },
        { kind: 'not', condition: { kind: 'red_streak_gte', n: 2 } },
      ],
    },
    then: {
      kind: 'chain',
      actions: [
        {
          kind: 'log',
          message: 'Auto-retrying cycle after PromptDelivery failure',
        },
        { kind: 'retry_cycle' },
      ],
    },
  },

  {
    name: 'escalate-after-three-consecutive-failures',
    priority: 5,
    enabled: true,
    when: {
      kind: 'and',
      conditions: [{ kind: 'lane_red' }, { kind: 'red_streak_gte', n: 3 }],
    },
    then: {
      kind: 'chain',
      actions: [
        {
          kind: 'notify',
          channel: 'dashboard',
          text: 'Agent has failed 3+ consecutive cycles — manual review needed.',
        },
        { kind: 'log', message: 'Escalated after red streak >= 3' },
      ],
    },
  },

  {
    name: 'alert-stale-branch',
    priority: 8,
    enabled: true,
    // Must name its event: `always` matched every lane event, so this priority-8 rule fired
    // on each failed cycle and pre-empted 'escalate-after-three-consecutive-failures'.
    when: { kind: 'event_is', type: 'BranchStaleAgainstMain' },
    then: {
      kind: 'notify',
      channel: 'dashboard',
      text: 'Agent branch is stale against main — consider rebasing.',
    },
  },
];
