/**
 * Recovery Recipes — named strategies for recovering from known failure scenarios.
 *
 * Ported from claw-code-main/rust/crates/runtime/src/recovery_recipes.rs.
 *
 * Division of responsibility:
 *   Recipes — *what to try* when a specific thing breaks.
 *   Policies — *when to run* which recipe given current swarm state.
 *
 * Attempt tracking prevents infinite recovery loops: a worker that fails the
 * same way N times needs human attention, not more automation.
 */

import { logger } from '../logger.js';
import { laneEventBus, LaneFailureClass, ts as now } from './lane-events.js';

// ─── Failure scenarios ────────────────────────────────────────────────────────

export enum FailureScenario {
  TrustPromptUnresolved = 'TrustPromptUnresolved',
  PromptMisdelivery = 'PromptMisdelivery',
  StaleBranch = 'StaleBranch',
  McpHandshakeFailure = 'McpHandshakeFailure',
  PartialPluginStartup = 'PartialPluginStartup',
  ProviderFailure = 'ProviderFailure',
  ToolRuntime = 'ToolRuntime',
  Infra = 'Infra',
}

/** Map LaneFailureClass → FailureScenario for automatic classification. */
export function classifyFailure(
  cls: LaneFailureClass | null | undefined,
): FailureScenario {
  switch (cls) {
    case LaneFailureClass.PromptDelivery:
      return FailureScenario.PromptMisdelivery;
    case LaneFailureClass.TrustGate:
      return FailureScenario.TrustPromptUnresolved;
    case LaneFailureClass.BranchDivergence:
      return FailureScenario.StaleBranch;
    case LaneFailureClass.McpHandshake:
      return FailureScenario.McpHandshakeFailure;
    case LaneFailureClass.McpStartup:
      return FailureScenario.PartialPluginStartup;
    case LaneFailureClass.GatewayRouting:
      return FailureScenario.ProviderFailure;
    case LaneFailureClass.ToolRuntime:
      return FailureScenario.ToolRuntime;
    case LaneFailureClass.ModelProvider:
      return FailureScenario.ProviderFailure;
    case LaneFailureClass.Infra:
      return FailureScenario.Infra;
    default:
      return FailureScenario.Infra;
  }
}

// ─── Recovery steps ───────────────────────────────────────────────────────────

export type RecoveryStep =
  | { kind: 'restart_agent' }
  | { kind: 'retry_cycle'; cycleType?: string }
  | { kind: 'notify'; channel: string; text: string }
  | { kind: 'log'; message: string }
  | { kind: 'reload_config' };

// ─── Escalation policy ────────────────────────────────────────────────────────

export type EscalationPolicy = 'alert_human' | 'log_and_continue' | 'abort';

// ─── Recipe ───────────────────────────────────────────────────────────────────

export interface RecoveryRecipe {
  scenario: FailureScenario;
  steps: RecoveryStep[];
  maxAttempts: number;
  escalationPolicy: EscalationPolicy;
}

// ─── Default recipes ──────────────────────────────────────────────────────────

export const DEFAULT_RECIPES: RecoveryRecipe[] = [
  {
    scenario: FailureScenario.PromptMisdelivery,
    maxAttempts: 2,
    escalationPolicy: 'alert_human',
    steps: [
      { kind: 'log', message: 'PromptMisdelivery: retrying cycle' },
      { kind: 'retry_cycle' },
    ],
  },
  {
    scenario: FailureScenario.StaleBranch,
    maxAttempts: 1,
    escalationPolicy: 'alert_human',
    steps: [
      {
        kind: 'notify',
        channel: 'dashboard',
        text: 'Branch is stale — agent paused pending rebase.',
      },
      { kind: 'log', message: 'StaleBranch: notified, awaiting manual rebase' },
    ],
  },
  {
    scenario: FailureScenario.McpHandshakeFailure,
    maxAttempts: 3,
    escalationPolicy: 'log_and_continue',
    steps: [
      { kind: 'log', message: 'McpHandshakeFailure: retrying cycle' },
      { kind: 'retry_cycle' },
    ],
  },
  {
    scenario: FailureScenario.ProviderFailure,
    maxAttempts: 3,
    escalationPolicy: 'alert_human',
    steps: [
      {
        kind: 'log',
        message: 'ProviderFailure: retrying cycle after provider error',
      },
      { kind: 'retry_cycle' },
    ],
  },
  {
    scenario: FailureScenario.ToolRuntime,
    maxAttempts: 2,
    escalationPolicy: 'log_and_continue',
    steps: [
      { kind: 'log', message: 'ToolRuntime: retrying cycle' },
      { kind: 'retry_cycle' },
    ],
  },
  {
    scenario: FailureScenario.Infra,
    maxAttempts: 1,
    escalationPolicy: 'alert_human',
    steps: [
      {
        kind: 'notify',
        channel: 'dashboard',
        text: 'Infrastructure failure — agent needs manual restart.',
      },
      { kind: 'log', message: 'Infra failure: notified operator' },
    ],
  },
  {
    scenario: FailureScenario.TrustPromptUnresolved,
    maxAttempts: 1,
    escalationPolicy: 'alert_human',
    steps: [
      {
        kind: 'notify',
        channel: 'dashboard',
        text: 'Agent requires trust approval to proceed.',
      },
      {
        kind: 'log',
        message: 'TrustPromptUnresolved: awaiting human approval',
      },
    ],
  },
];

// ─── Step executor interface ──────────────────────────────────────────────────

export interface StepExecutor {
  restartAgent(agentId: string): Promise<void>;
  /**
   * cycleId, when known, identifies the FAILED cycle being retried — lets the
   * executor look up its resume_hint so the retry continues the original task
   * instead of starting a blank one. Absent for scheduled cycles that had no
   * extraContext to begin with.
   */
  retryCycle(
    agentId: string,
    cycleType?: string,
    cycleId?: string,
  ): Promise<void>;
  notify(channel: string, text: string): Promise<void>;
}

// ─── RecoveryEngine ───────────────────────────────────────────────────────────

export class RecoveryEngine {
  /** attempt count keyed by `${agentId}:${scenario}` */
  private attempts = new Map<string, number>();
  private recipes: Map<FailureScenario, RecoveryRecipe>;
  private executor: StepExecutor;

  constructor(
    executor: StepExecutor,
    recipes: RecoveryRecipe[] = DEFAULT_RECIPES,
  ) {
    this.executor = executor;
    this.recipes = new Map(recipes.map((r) => [r.scenario, r]));
  }

  /** Add or replace a recipe at runtime (e.g., from settings). */
  addRecipe(recipe: RecoveryRecipe): void {
    this.recipes.set(recipe.scenario, recipe);
  }

  /**
   * Handle a failure for the given agent + scenario.
   * Tracks attempt count; escalates when maxAttempts is exceeded.
   */
  async handleFailure(
    agentId: string,
    scenario: FailureScenario | string,
    lane: string,
    cycleId?: string,
  ): Promise<void> {
    const key = `${agentId}:${scenario}`;
    const count = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, count);

    const recipe = this.recipes.get(scenario as FailureScenario);
    if (!recipe) {
      logger.warn(
        { agentId, scenario },
        'RecoveryEngine: no recipe for scenario',
      );
      return;
    }

    logger.info(
      { agentId, scenario, attempt: count, maxAttempts: recipe.maxAttempts },
      'RecoveryEngine: handling failure',
    );

    if (count > recipe.maxAttempts) {
      await this._escalate(agentId, scenario as FailureScenario, lane, recipe);
      return;
    }

    for (const step of recipe.steps) {
      await this._runStep(step, agentId, lane, cycleId);
    }
  }

  /** Reset attempt counter for an agent+scenario (call on success). */
  resetAttempts(agentId: string, scenario: FailureScenario): void {
    this.attempts.delete(`${agentId}:${scenario}`);
  }

  /** Reset all attempt counters for an agent (e.g., on agent restart). */
  resetAllAttempts(agentId: string): void {
    for (const key of [...this.attempts.keys()]) {
      if (key.startsWith(`${agentId}:`)) this.attempts.delete(key);
    }
  }

  /** Return current attempt counts (for dashboard / telemetry). */
  getAttemptCounts(): Record<string, number> {
    return Object.fromEntries(this.attempts);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _runStep(
    step: RecoveryStep,
    agentId: string,
    lane: string,
    cycleId?: string,
  ): Promise<void> {
    switch (step.kind) {
      case 'restart_agent':
        logger.info({ agentId }, 'RecoveryEngine: restarting agent');
        await this.executor.restartAgent(agentId);
        laneEventBus.emit_event({
          type: 'WorkerStateChanged',
          agentId,
          from: 'Failed' as any,
          to: 'Spawning' as any,
          ts: now(),
        });
        break;

      case 'retry_cycle':
        logger.info({ agentId, lane }, 'RecoveryEngine: retrying cycle');
        await this.executor.retryCycle(
          agentId,
          step.cycleType ?? lane,
          cycleId,
        );
        break;

      case 'notify':
        await this.executor.notify(step.channel, step.text);
        break;

      case 'log':
        logger.info({ agentId, lane }, `RecoveryEngine: ${step.message}`);
        break;

      case 'reload_config':
        logger.info(
          { agentId },
          'RecoveryEngine: reload_config step (no-op in this runtime)',
        );
        break;
    }
  }

  private async _escalate(
    agentId: string,
    scenario: FailureScenario,
    lane: string,
    recipe: RecoveryRecipe,
  ): Promise<void> {
    const message = `Agent ${agentId} — scenario ${scenario} exceeded max attempts (${recipe.maxAttempts}). Manual intervention required.`;
    logger.warn(
      { agentId, scenario, lane, escalationPolicy: recipe.escalationPolicy },
      message,
    );

    switch (recipe.escalationPolicy) {
      case 'alert_human':
        await this.executor.notify('dashboard', message);
        laneEventBus.emit_event({
          type: 'LaneBlocked',
          lane,
          agentId,
          reason: message,
          class: LaneFailureClass.Infra,
          ts: now(),
        });
        break;

      case 'log_and_continue':
        logger.warn(
          { agentId, scenario },
          'RecoveryEngine: max attempts exceeded — continuing',
        );
        break;

      case 'abort':
        laneEventBus.emit_event({
          type: 'LaneRed',
          lane,
          agentId,
          details: message,
          class: LaneFailureClass.Infra,
          ts: now(),
        });
        break;
    }
  }
}
