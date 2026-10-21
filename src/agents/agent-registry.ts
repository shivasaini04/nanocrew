/**
 * Shared singletons for AgentService, AgentScheduler, PolicyEngine,
 * RecoveryEngine, and NotificationSink.
 *
 * Both the HTTP routes (agents.ts) and the main server loop (index.ts)
 * import from here so they share the same in-memory state.
 *
 * Self-healing wiring (Phase 6):
 *   laneEventBus ──► PolicyEngine  ──► RecoveryEngine ──► agentService.runCycle
 *                                 ──► NotificationSink ──► dashboard / webhook
 */

import path from 'path';

import { DATA_DIR } from '../config.js';
import { AgentService } from './agent-service.js';
import { AgentScheduler } from './agent-scheduler.js';
import { ChatQueue } from './chat-queue.js';
import { ToolLifecycleManager } from '../services/tool-lifecycle-manager.js';
import { NanobotCycleRunner } from './nanobot-cycle-runner.js';
import {
  laneEventBus,
  LaneFailureClass,
  type LaneEvent,
} from './lane-events.js';
import { PolicyEngine, type ActionHandler } from './policy-engine.js';
import {
  RecoveryEngine,
  FailureScenario,
  classifyFailure,
  type StepExecutor,
} from './recovery-recipes.js';
import {
  buildNotificationSink,
  type NotificationSink,
} from './notification-sink.js';
import { getSocketIO } from '../api/instances.js';
import { getAgentCycleById, getAgentInterruptFlag } from '../db.js';
import { logger } from '../logger.js';
import { canWake } from './wake-policy.js';
import type { CycleType } from '../types.js';

// ─── Core singletons ──────────────────────────────────────────────────────────

const AGENTS_DIR = path.join(DATA_DIR, 'agents');

export const agentService = new AgentService(
  AGENTS_DIR,
  new NanobotCycleRunner(),
);
export const agentScheduler = new AgentScheduler(agentService);

/** Chat messages that arrive while their agent is busy. See chat-queue.ts. */
export const chatQueue = new ChatQueue((id) =>
  agentService.isExecutingCycle(id),
);
agentService.onCycleSlotFreed((id) => chatQueue.onFree(id));
export const toolLifecycleManager = new ToolLifecycleManager();

// ─── Notification sink (lazy — needs Socket.IO which initialises after us) ────

export let notificationSink: NotificationSink | null = null;

/**
 * Run a failed cycle's task again — the self-healing retry, and (stage 64 phase 3) the
 * resume of a run a restart cut short. `note` is added to the task so the agent checks what
 * the interrupted run already did before repeating it.
 */
export async function resumeCycle(
  agentId: string,
  cycleType?: string,
  cycleId?: string,
  note?: string,
): Promise<void> {
  try {
    const agent = agentService.getAgent(agentId);
    if (!agent) return;
    if (!canWake(agent, 'recovery')) {
      logger.info(
        { agentId },
        'SelfHealing: retryCycle skipped — wake policy has recovery turned off (or agent is stopped)',
      );
      return;
    }
    // Stop sets this flag, but the retried cycle clears it on start, so without this check
    // a failure that lands after Stop quietly starts the agent again (seen live 2026-10-21).
    if (getAgentInterruptFlag(agentId)) {
      logger.info(
        { agentId },
        'SelfHealing: retryCycle skipped — the agent was stopped',
      );
      return;
    }
    const ct = (cycleType ??
      agent.config.schedule[0]?.type ??
      'custom') as CycleType;
    // Resume the original task instead of starting a blank cycle, when the
    // failed cycle had one (resume_hint mirrors extraContext at creation —
    // same field the manual "continue" chat command already reads).
    const original = cycleId ? getAgentCycleById(cycleId) : undefined;
    const resumeHint = original?.resume_hint ?? undefined;
    const task = note
      ? [resumeHint, note].filter(Boolean).join('\n\n')
      : resumeHint;
    // A retry of a cycle a person asked for is still that person's request — otherwise
    // rotation and cooldowns refuse the retry what the original was allowed to do.
    const humanRequested = !!original?.human_requested;
    // Stage 60: a run that actually reached the person's computer retries there too.
    // Without this the retry quietly moved to the cloud — seen live 2026-09-17, a
    // retried "use my browser" run asking its question again from a container.
    const laneHint =
      (original as { lane?: string } | undefined)?.lane === 'user-browser'
        ? ('local' as const)
        : undefined;
    await agentService.runCycle(
      agentId,
      ct,
      task,
      undefined,
      undefined,
      undefined,
      { humanRequested, laneHint },
    );
  } catch (err) {
    logger.warn(
      { agentId, cycleType, cycleId, err },
      'SelfHealing: retryCycle failed',
    );
  }
}

/**
 * Call once after the API server (and therefore Socket.IO) has been started.
 * Wires the self-healing pipeline: lane events → policy → recovery/notify.
 */
export function initSelfHealing(): void {
  if (notificationSink) return; // idempotent

  notificationSink = buildNotificationSink(() => getSocketIO());

  // ── StepExecutor: maps recipe steps to agentService calls ────────────────
  const stepExecutor: StepExecutor = {
    async restartAgent(agentId) {
      try {
        await agentService.stopAgent(agentId);
        await agentService.startAgent(agentId);
      } catch (err) {
        logger.warn({ agentId, err }, 'SelfHealing: restartAgent failed');
      }
    },

    async retryCycle(agentId, cycleType, cycleId) {
      await resumeCycle(agentId, cycleType, cycleId);
    },

    async notify(channel, text) {
      await notificationSink!.notify(channel, text);
    },
  };

  const recoveryEngine = new RecoveryEngine(stepExecutor);

  // ── ActionHandler: maps policy actions to agentService / recoveryEngine ───
  const actionHandler: ActionHandler = {
    async retryAgentCycle(agentId, cycleType) {
      await stepExecutor.retryCycle(agentId, cycleType);
    },

    async recoverOnce(agentId, scenario, lane) {
      await recoveryEngine.handleFailure(
        agentId,
        scenario as FailureScenario,
        lane,
      );
    },

    async notify(channel, text) {
      await notificationSink!.notify(channel, text);
    },

    blockLane(agentId, lane, reason) {
      logger.warn({ agentId, lane, reason }, 'SelfHealing: lane blocked');
      laneEventBus.emit_event({
        type: 'LaneBlocked',
        lane,
        agentId,
        reason,
        class: LaneFailureClass.Infra,
        ts: new Date().toISOString(),
      });
    },
  };

  const policyEngine = new PolicyEngine(actionHandler);

  // ── Subscribe to lane events ───────────────────────────────────────────────
  laneEventBus.onEvent(async (event: LaneEvent) => {
    const agentId =
      'agentId' in event ? ((event as any).agentId as string) : '';
    if (!agentId) return;

    // Resolve laneState for conditions that need it
    const lane = 'lane' in event ? ((event as any).lane as string) : '';
    const laneState = lane
      ? laneEventBus.getLaneState(agentId, lane)
      : undefined;

    // Route events → policy engine
    switch (event.type) {
      case 'TurnFailed':
      case 'LaneRed':
      case 'LaneBlocked':
        // Also trigger the recovery engine directly via recover_once action
        // when the failure class maps to a known scenario.
        await policyEngine.evaluate(event, laneState);

        // Additionally run the recovery recipe directly for typed failure classes
        if ('class' in event && event.class) {
          const scenario = classifyFailure(event.class as LaneFailureClass);
          const cycleId =
            'cycleId' in event
              ? ((event as any).cycleId as string | undefined)
              : undefined;
          await recoveryEngine.handleFailure(agentId, scenario, lane, cycleId);
        }
        break;

      case 'BranchStaleAgainstMain':
        // Stale branch alert rule uses `always` condition — evaluate it here
        // by creating a synthetic red event so the policy fires.
        await policyEngine.evaluate(event, laneState);
        await recoveryEngine.handleFailure(
          agentId,
          FailureScenario.StaleBranch,
          lane,
        );
        break;

      case 'TurnCompleted':
      case 'LaneGreen':
        // On success, reset attempt counters for this agent
        recoveryEngine.resetAllAttempts(agentId);
        break;
    }
  });

  logger.info(
    'SelfHealing pipeline initialised: PolicyEngine + RecoveryEngine active',
  );
}

/** Expose recovery engine attempt counts for the API / dashboard. */
export function getSelfHealingStats(): Record<string, number> | null {
  // recoveryEngine is local to initSelfHealing; expose via laneEventBus states instead
  return null; // placeholder — callers can use laneEventBus.getAllLaneStates()
}
