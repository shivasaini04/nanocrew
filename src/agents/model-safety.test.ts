/**
 * Stage 54 phase 3 — an agent may pick any model, and must not be able to brick itself.
 *
 * The allowlist this replaces was blocking a real need for a reason that was never about
 * security: in early September every agent was pointed at a free model that took 43.9s to
 * fail a one-word test, and none of them could move off it. What the allowlist was
 * actually protecting against is narrower and is covered here — a model id that does not
 * resolve fails on every future cycle, including the one the agent would need in order to
 * undo it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertAgent,
  getAgent,
  getConfigAudit,
} from '../db.js';
import {
  isModelResolutionFailure,
  recordModelWorked,
  rollbackModelIfBricked,
} from './model-safety.js';
import type { AgentConfig } from '../types.js';

const AGENT = 'agent-model-1';

function makeAgent(config: Partial<AgentConfig>) {
  insertAgent({
    id: AGENT,
    name: 'Finder',
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: new Date().toISOString(),
    owner_id: 'me',
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'g',
      escalationRules: [],
      ...config,
    } as AgentConfig,
  });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('recognising a model-resolution failure', () => {
  it('matches the errors production actually threw', () => {
    // Real summaries from agent_cycles, 2026-08-26 and after.
    for (const s of [
      'Agent container exited with code 1: or: litellm.NotFoundError: NotFoundError: Op',
      'Error calling LLM: litellm.NotFoundError',
      '"status":404,"title":"Not Found","det',
      'model_not_found',
    ]) {
      expect(isModelResolutionFailure(s), s).toBe(true);
    }
  });

  it('does not match failures that have nothing to do with the model', () => {
    for (const s of [
      'Orchestrator restarted mid-cycle',
      'FOREIGN KEY constraint failed',
      'Error calling LLM: litellm.BadRequestError: DeepseekException',
      '',
      null,
    ]) {
      expect(isModelResolutionFailure(s as string), String(s)).toBe(false);
    }
  });
});

describe('last known good model', () => {
  it('records the model a completed cycle ran on', () => {
    makeAgent({ model: 'deepseek/deepseek-v4-flash' });
    recordModelWorked(AGENT);
    expect(getAgent(AGENT)!.config.lastKnownGoodModel).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  it('is a no-op for an agent on the platform default', () => {
    makeAgent({});
    recordModelWorked(AGENT);
    expect(getAgent(AGENT)!.config.lastKnownGoodModel).toBeUndefined();
  });
});

describe('auto rollback', () => {
  it('rolls back after two consecutive resolution failures', () => {
    makeAgent({
      model: 'openrouter/does-not-exist',
      lastKnownGoodModel: 'deepseek/deepseek-v4-flash',
    });

    const back = rollbackModelIfBricked(AGENT, [
      'litellm.NotFoundError: NotFoundError',
      'litellm.NotFoundError: NotFoundError',
    ]);

    expect(back).toBe('deepseek/deepseek-v4-flash');
    expect(getAgent(AGENT)!.config.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('records the rollback so it is not a silent repair', () => {
    makeAgent({
      model: 'openrouter/does-not-exist',
      lastKnownGoodModel: 'deepseek/deepseek-v4-flash',
    });
    rollbackModelIfBricked(AGENT, [
      'litellm.NotFoundError',
      'litellm.NotFoundError',
    ]);

    const [entry] = getConfigAudit(AGENT, 5);
    expect(entry.capability).toBe('model');
    expect(entry.actor).toBe('system');
    expect(JSON.parse(entry.before_json).model).toBe(
      'openrouter/does-not-exist',
    );
    expect(JSON.parse(entry.after_json).model).toBe(
      'deepseek/deepseek-v4-flash',
    );
  });

  it('waits for two — one failure is not a pattern', () => {
    makeAgent({
      model: 'openrouter/does-not-exist',
      lastKnownGoodModel: 'deepseek/deepseek-v4-flash',
    });
    expect(rollbackModelIfBricked(AGENT, ['litellm.NotFoundError'])).toBeNull();
    expect(getAgent(AGENT)!.config.model).toBe('openrouter/does-not-exist');
  });

  it('ignores failures that are not about the model', () => {
    makeAgent({
      model: 'openrouter/does-not-exist',
      lastKnownGoodModel: 'deepseek/deepseek-v4-flash',
    });
    const back = rollbackModelIfBricked(AGENT, [
      'Orchestrator restarted mid-cycle',
      'Orchestrator restarted mid-cycle',
    ]);
    expect(back).toBeNull();
  });

  it('does nothing when there is no known good model to return to', () => {
    // Better visibly broken than moved to a model nobody has confirmed works for it.
    makeAgent({ model: 'openrouter/does-not-exist' });
    expect(
      rollbackModelIfBricked(AGENT, [
        'litellm.NotFoundError',
        'litellm.NotFoundError',
      ]),
    ).toBeNull();
  });

  it('does nothing when the known good model IS the current one', () => {
    makeAgent({ model: 'x/y', lastKnownGoodModel: 'x/y' });
    expect(
      rollbackModelIfBricked(AGENT, [
        'litellm.NotFoundError',
        'litellm.NotFoundError',
      ]),
    ).toBeNull();
  });
});
