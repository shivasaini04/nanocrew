/**
 * Until 2026-09-14, resolveAuxiliaryEnvVars and resolveFallbackChain never looked at an
 * agent's own config.model — an agent that explicitly picked its own model still got the
 * platform's task-type default (deepseek/deepseek-v4-flash for tool_generation) for
 * vision/classification/memory/tool-gen, and every agent's retry chain started with a
 * hardcoded deepseek entry regardless of what model the agent actually runs on.
 *
 * These tests don't assume a particular platform config on disk (loadModelConfig reads a
 * real file that varies by environment) — they assert the PRECEDENCE (agent's own choice
 * wins, deepseek drops out once something else was chosen), which holds no matter what
 * the platform defaults happen to be.
 */
import { describe, it, expect } from 'vitest';
import { modelRouter, getModelConfig } from './model-router.js';

describe('resolveAuxiliaryEnvVars', () => {
  it("uses the agent's own model for every role once it has picked one", () => {
    const vars = modelRouter.resolveAuxiliaryEnvVars({
      model: 'openrouter/z-ai/glm-5.3-flash',
    });
    expect(vars.VISION_MODEL).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(vars.NANOBOT_CLASSIFIER_MODEL).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(vars.NANOBOT_MEMORY_MODEL).toBe('openrouter/z-ai/glm-5.3-flash');
    expect(vars.NANOBOT_TOOL_GEN_MODEL).toBe('openrouter/z-ai/glm-5.3-flash');
  });

  it("the agent's general model wins even over its own per-task override — resolve()'s existing precedence, unchanged here", () => {
    const vars = modelRouter.resolveAuxiliaryEnvVars({
      model: 'openrouter/z-ai/glm-5.3-flash',
      task_models: { tool_generation: 'deepseek/deepseek-v4-pro' },
    });
    expect(vars.NANOBOT_TOOL_GEN_MODEL).toBe('openrouter/z-ai/glm-5.3-flash');
  });

  it('a per-task override DOES win once the agent has no general model of its own', () => {
    const vars = modelRouter.resolveAuxiliaryEnvVars({
      task_models: { tool_generation: 'deepseek/deepseek-v4-pro' },
    });
    expect(vars.NANOBOT_TOOL_GEN_MODEL).toBe('deepseek/deepseek-v4-pro');
  });

  it('falls through to the platform task default when the agent picked nothing at all', () => {
    const platform = getModelConfig();
    const vars = modelRouter.resolveAuxiliaryEnvVars(undefined);
    expect(vars.VISION_MODEL).toBe(
      platform.taskModels['vision'] ?? platform.defaultModel,
    );
    expect(vars.NANOBOT_TOOL_GEN_MODEL).toBe(
      platform.taskModels['tool_generation'] ?? platform.defaultModel,
    );
  });

  it("threads the owner default through to resolve()'s own precedence (Level 4, below the agent's model and any task default)", () => {
    // resolveAuxiliaryEnvVars' four task types (vision/classification/memory_distill/
    // tool_generation) always have a platform default, so they never reach the owner
    // default themselves — exercise resolve() directly with a task type that has none.
    expect(
      modelRouter.resolve(
        undefined,
        'nonexistent_task',
        'gemini/gemini-3.5-flash',
      ),
    ).toBe('gemini/gemini-3.5-flash');
    expect(
      modelRouter.resolve(
        { model: 'openrouter/z-ai/glm-5.3-flash' },
        'nonexistent_task',
        'gemini/gemini-3.5-flash',
      ),
    ).toBe('openrouter/z-ai/glm-5.3-flash');
  });
});

describe('EFFECTOR_DECISION_MODEL (stage 61 phase 2)', () => {
  it('is empty — so not passed — for an agent that did not opt in, even with its own model', () => {
    // Every founder agent has config.model set; routing this through resolve() would have
    // handed all of them a new per-step decider. Opt-in only.
    expect(
      modelRouter.resolveAuxiliaryEnvVars({
        model: 'openrouter/z-ai/glm-5.3-flash',
      }).EFFECTOR_DECISION_MODEL,
    ).toBe('');
    expect(
      modelRouter.resolveAuxiliaryEnvVars(undefined).EFFECTOR_DECISION_MODEL,
    ).toBe('');
  });

  it("carries the agent's explicit choice, regardless of its general model", () => {
    const vars = modelRouter.resolveAuxiliaryEnvVars({
      model: 'openrouter/z-ai/glm-5.3-flash',
      task_models: {
        effector_decision: 'openrouter/google/gemini-3.5-flash-lite',
      },
    });
    expect(vars.EFFECTOR_DECISION_MODEL).toBe(
      'openrouter/google/gemini-3.5-flash-lite',
    );
  });
});

describe('resolveFallbackChain', () => {
  it('drops the hardcoded deepseek entry once an agent has chosen a different model', () => {
    const chain = modelRouter
      .resolveFallbackChain({ model: 'openrouter/z-ai/glm-5.3-flash' })
      .split(',');
    expect(chain).not.toContain('deepseek/deepseek-v4-flash');
  });

  it("never lists the agent's own model as one of its own fallbacks", () => {
    const platform = getModelConfig();
    const primary = platform.fallbackChain[0]!; // whatever the platform's own chain leads with
    const chain = modelRouter
      .resolveFallbackChain({ model: primary })
      .split(',');
    expect(chain).not.toContain(primary);
  });

  it('keeps the platform default chain unchanged for an agent with no model of its own', () => {
    const platform = getModelConfig();
    expect(modelRouter.resolveFallbackChain(undefined)).toBe(
      platform.fallbackChain.join(','),
    );
    expect(modelRouter.resolveFallbackChain({})).toBe(
      platform.fallbackChain.join(','),
    );
  });
});
