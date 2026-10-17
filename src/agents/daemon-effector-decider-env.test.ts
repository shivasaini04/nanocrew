/**
 * Stage 61 phase 2, found live 2026-09-20: the warm-daemon path passed no auxiliary model
 * env, so an agent's opt-in Effector decider (config.task_models.effector_decision) never
 * reached a daemon cycle — the live test agent kept deciding on gemini-3.6-flash. The
 * daemon now receives EFFECTOR_DECISION_MODEL, and only when the agent set it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { buildContainerArgs } from './nanobot-cycle-runner.js';
import { modelRouter } from '../services/model-router.js';

function daemonArgs(extra?: Record<string, string>): string[] {
  return buildContainerArgs(
    'NanoCrew-daemon-test',
    '/tmp/agent',
    '/tmp/nanoagent',
    '/tmp/ipc',
    {},
    {},
    undefined,
    undefined,
    'openrouter/z-ai/glm-5.3-flash',
    undefined,
    undefined,
    'agent-1',
    true,
    undefined,
    undefined,
    undefined,
    undefined,
    extra,
  );
}

describe('daemon Effector decider env', () => {
  beforeAll(() => {
    _initTestDatabase();
  });

  it('passes the opt-in decider to a daemon', () => {
    const aux = modelRouter.resolveAuxiliaryEnvVars({
      model: 'openrouter/z-ai/glm-5.3-flash',
      task_models: {
        effector_decision: 'openrouter/google/gemini-3.5-flash-lite',
      },
    });
    const args = daemonArgs({
      EFFECTOR_DECISION_MODEL: aux.EFFECTOR_DECISION_MODEL ?? '',
    });
    expect(args).toContain(
      'EFFECTOR_DECISION_MODEL=openrouter/google/gemini-3.5-flash-lite',
    );
  });

  it('passes nothing for an agent that did not opt in', () => {
    const aux = modelRouter.resolveAuxiliaryEnvVars({
      model: 'openrouter/z-ai/glm-5.3-flash',
    });
    const args = daemonArgs({
      EFFECTOR_DECISION_MODEL: aux.EFFECTOR_DECISION_MODEL ?? '',
    });
    expect(args.some((a) => a.startsWith('EFFECTOR_DECISION_MODEL'))).toBe(
      false,
    );
  });

  it('still passes no other auxiliary model to a daemon (unchanged behaviour)', () => {
    const args = daemonArgs({ EFFECTOR_DECISION_MODEL: '' });
    for (const k of [
      'NANOBOT_CLASSIFIER_MODEL',
      'NANOBOT_MEMORY_MODEL',
      'NANOBOT_TOOL_GEN_MODEL',
    ]) {
      expect(args.some((a) => a.startsWith(`${k}=`))).toBe(false);
    }
  });
});
