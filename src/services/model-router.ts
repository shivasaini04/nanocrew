import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../config.js';
import { getAgent, getAgentDefaultModel } from '../db.js';
import { deadReason, modelStatus } from '../agents/model-health.js';
import { logger } from '../logger.js';

export interface ModelConfig {
  defaultModel: string;
  fallbackChain: string[];
  thinkingDefault: boolean;
  taskModels: Record<string, string>;
}

const CONFIG_PATH = path.join(DATA_DIR, 'model-config.json');

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  defaultModel: 'deepseek/deepseek-v4-flash',
  fallbackChain: [
    // The one funded provider on 2026-09-30, when every other entry here was dead
    // (DeepSeek direct 402, Gemini 402, Groq 404). Tried only after the agent's own
    // model has failed twice. Same entry heads the adapter's _DEFAULT_CHAIN.
    'openrouter/deepseek/deepseek-v4-flash-0731',
    'deepseek/deepseek-v4-flash',
    // Was gemini-2.0-flash, retired by Google (404). This chain is what every agent
    // falls back through, and a dead entry in it ended Crawler a live cycle
    // (2026-09-11). 3.5-flash is what litellm_config.yaml already moved to; verified
    // live the same day (generateContent 200).
    'gemini/gemini-3.5-flash',
    // llama-3.3-70b-versatile is gone from Groq (404, checked 2026-09-30).
    'groq/openai/gpt-oss-120b',
  ],
  thinkingDefault: false,
  taskModels: {
    // Cost: keep everything on the cheap flash tier by default (matches the
    // absorbed-cost pricing strategy). v4-pro was ~5x the output price; switch a
    // specific task back to it in Settings → Models only if quality demands it.
    deep_research: 'deepseek/deepseek-v4-flash',
    code_generation: 'deepseek/deepseek-v4-flash',
    tool_generation: 'deepseek/deepseek-v4-flash',
    summarization: 'deepseek/deepseek-v4-flash',
    // Has a real consumer (nanocrew_adapter.py reads NANOBOT_MEMORY_MODEL for
    // memory consolidation) — routed to the cheapest OpenRouter model.
    memory_distill: 'openrouter/inclusionai/ling-3.0-flash',
    classification: 'groq/openai/gpt-oss-120b',
    // Has a real consumer (loop.py reads VISION_MODEL) — MiMo-V2.5 is natively
    // omnimodal (text/image/audio/video) and cheaper than the prior Kimi vision model.
    vision: 'openrouter/xiaomi/mimo-v2.5',
    computer_use: 'gemini/gemini-3.5-flash',
    // These three used to be hardcoded 'deepseek/deepseek-v4-flash' literals in
    // agent-service.ts / identity-evolution.ts / agents.ts / tool-generator.ts,
    // bypassing this router entirely — changing Settings -> Models did nothing for
    // them. Same default value (no behavior change), now actually governed by it.
    // See resolveInternalModel() below, the shared entry point those files use.
    internal_writing: 'deepseek/deepseek-v4-flash', // episode logs, check-in reports, feedback extraction, seed reorg, starters
    identity_evolution: 'deepseek/deepseek-v4-flash', // IDENTITY.md LEARNED-section rewrite
    chat_onboarding: 'deepseek/deepseek-v4-flash', // onboarding Q&A + greeting (POST /:id/chat)
    tool_proposal: 'deepseek/deepseek-v4-flash', // one-time tool proposal/generation at agent-creation time
  },
};

let _config: ModelConfig | null = null;

export function loadModelConfig(): ModelConfig {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    _config = {
      ...DEFAULT_MODEL_CONFIG,
      ...parsed,
      taskModels: {
        ...DEFAULT_MODEL_CONFIG.taskModels,
        ...(parsed.taskModels ?? {}),
      },
    };
  } catch {
    _config = {
      ...DEFAULT_MODEL_CONFIG,
      taskModels: { ...DEFAULT_MODEL_CONFIG.taskModels },
    };
  }
  return _config!;
}

export function getModelConfig(): ModelConfig {
  if (!_config) return loadModelConfig();
  return _config;
}

export function saveModelConfig(config: ModelConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  _config = config;
}

export interface AgentModelSettings {
  model?: string;
  subagent_model?: string;
  task_models?: Record<string, string>;
  thinking_enabled?: boolean | null;
}

export class ModelRouter {
  /**
   * Resolve which model to use for a given agent + optional task type.
   *
   * Precedence (high → low):
   *   1. Per-agent hard override (config.model)
   *   2. Per-agent task-type map (config.task_models[taskType])
   *   3. Platform task-type defaults (platform.taskModels[taskType])
   *   4. Owner's account-level default (ownerDefaultModel) — set in Account
   *      Settings, applies to every agent that owner has that lacks its own override
   *   5. Platform global default (platform.defaultModel)
   */
  resolve(
    agentConfig: AgentModelSettings | null | undefined,
    taskType?: string,
    ownerDefaultModel?: string | null,
  ): string {
    const platform = getModelConfig();
    const chosen = this.resolveConfigured(
      agentConfig,
      taskType,
      ownerDefaultModel,
      platform,
    );
    return usableModel(chosen, [
      ownerDefaultModel,
      ...platform.fallbackChain,
      platform.defaultModel,
    ]);
  }

  /** The configured choice, before the health check — the precedence chain itself. */
  private resolveConfigured(
    agentConfig: AgentModelSettings | null | undefined,
    taskType: string | undefined,
    ownerDefaultModel: string | null | undefined,
    platform: ModelConfig,
  ): string {
    // Level 1: per-agent hard override
    if (agentConfig?.model) return agentConfig.model;

    // Level 2: per-agent task-type map
    if (taskType && agentConfig?.task_models?.[taskType]) {
      return agentConfig.task_models[taskType];
    }

    // Level 3: platform task-type defaults
    if (taskType && platform.taskModels[taskType]) {
      return platform.taskModels[taskType];
    }

    // Level 4: owner's account-level default
    if (ownerDefaultModel) return ownerDefaultModel;

    // Level 5: platform global default
    return platform.defaultModel;
  }

  /** Resolve thinking toggle for an agent. null → inherit platform default. */
  resolveThinking(agentConfig: AgentModelSettings | null | undefined): boolean {
    const platform = getModelConfig();
    if (
      agentConfig?.thinking_enabled !== undefined &&
      agentConfig.thinking_enabled !== null
    ) {
      return agentConfig.thinking_enabled;
    }
    return platform.thinkingDefault;
  }

  /**
   * Resolve all per-role auxiliary model env vars to inject into a container.
   *
   * Routed through the SAME precedence as `resolve()` — an agent's own `config.model`
   * wins over the platform's task-type default. Until 2026-09-14 this bypassed that
   * precedence entirely (`platform.taskModels[type] ?? platform.defaultModel`, never
   * looking at `agentConfig.model`), so an agent that explicitly picked its own model
   * still got the platform's hardcoded default — `tool_generation` in particular meant
   * every agent's dynamic-tool generation silently ran on deepseek regardless of what
   * model the agent was actually configured to use.
   */
  resolveAuxiliaryEnvVars(
    agentConfig: AgentModelSettings | null | undefined,
    ownerDefaultModel?: string | null,
  ): Record<string, string> {
    return {
      VISION_MODEL: this.resolve(agentConfig, 'vision', ownerDefaultModel),
      NANOBOT_CLASSIFIER_MODEL: this.resolve(
        agentConfig,
        'classification',
        ownerDefaultModel,
      ),
      NANOBOT_MEMORY_MODEL: this.resolve(
        agentConfig,
        'memory_distill',
        ownerDefaultModel,
      ),
      NANOBOT_TOOL_GEN_MODEL: this.resolve(
        agentConfig,
        'tool_generation',
        ownerDefaultModel,
      ),
      // Stage 61 phase 2: Effector's per-step decider. Explicit opt-in ONLY — not
      // routed through resolve(), whose level 1 (config.model) would hand every agent
      // with its own model a new decider. Unset → empty → not passed, and the
      // container keeps its model_router 'tool_heavy' default as before.
      EFFECTOR_DECISION_MODEL:
        agentConfig?.task_models?.effector_decision ?? '',
    };
  }

  /**
   * Comma-separated fallback chain for nanobot to read via NANOBOT_MODEL_FALLBACK_CHAIN.
   *
   * Scoped to what THIS agent actually asked for: an agent with its own `config.model`
   * drops the platform's hardcoded `deepseek/deepseek-v4-flash` entry (and any entry
   * matching its own primary model, already tried as provider[0] before this chain is
   * ever consulted) rather than silently retrying through deepseek regardless of the
   * agent's own choice. An agent with no explicit model keeps the platform default
   * chain unchanged — deepseek is a legitimate backstop when nobody picked anything.
   */
  resolveFallbackChain(agentConfig?: AgentModelSettings | null): string {
    const platform = getModelConfig();
    const primary = agentConfig?.model;
    const chain = primary
      ? platform.fallbackChain.filter(
          (m) => m !== 'deepseek/deepseek-v4-flash' && m !== primary,
        )
      : platform.fallbackChain;
    return chain.join(',');
  }

  /**
   * Model for subagents spawned via the `spawn` tool. Config-driven only — no platform
   * default, no LLM judgment call. Unset means subagents inherit the primary model,
   * unchanged from today's behavior.
   */
  resolveSubagentModel(
    agentConfig: AgentModelSettings | null | undefined,
  ): string | undefined {
    return agentConfig?.subagent_model || undefined;
  }
}

/**
 * Stage 64 phase 3: a model its provider no longer lists, or whose account cannot pay, is
 * swapped for the first candidate known to work (model-health.ts) — the owner's default, then
 * the platform fallbacks. Only a certainly-dead model is swapped, only for a certainly-good
 * one; anything uncertain runs as configured, exactly as before.
 *
 * Measured reason (30 days to 2026-09-30): 5 cycles failed on a model that no longer existed,
 * and the platform default (DeepSeek direct, no balance) failed every call it was given —
 * including the orchestrator's own check-in reports and episode logs, which have no fallback.
 */
export function usableModel(
  chosen: string,
  candidates: Array<string | null | undefined>,
): string {
  if (modelStatus(chosen) !== 'dead') return chosen;
  const swap = candidates.find(
    (c): c is string => !!c && c !== chosen && modelStatus(c) === 'ok',
  );
  if (!swap) return chosen;
  const key = `${chosen}→${swap}`;
  const now = Date.now();
  if ((lastSwapWarned.get(key) ?? 0) < now - 6 * 60 * 60_000) {
    lastSwapWarned.set(key, now);
    logger.warn(
      { configured: chosen, using: swap, reason: deadReason(chosen) },
      'model-health: configured model is unusable — running on a working one instead',
    );
  }
  return swap;
}
const lastSwapWarned = new Map<string, number>();

export const modelRouter = new ModelRouter();

/**
 * Resolve a model for an internal (non-cycle) LLM call — episode summaries, identity
 * evolution, memory distillation, onboarding chat, tool proposal — through the SAME
 * precedence chain a real cycle gets (`ModelRouter.resolve`), instead of each call
 * site hardcoding a literal model string. `agentId` threads through to both the
 * per-agent override (`config.model`/`config.task_models`) and the owner's
 * account-level default; omit it (a call with no agent yet, e.g. pre-hire) to still
 * get the platform task-type/global default rather than a raw literal.
 */
export function resolveInternalModel(
  agentId: string | undefined,
  taskType: string,
): string {
  if (!agentId) return modelRouter.resolve(undefined, taskType);
  const agent = getAgent(agentId);
  const ownerDefaultModel = getAgentDefaultModel(agentId);
  return modelRouter.resolve(
    agent?.config as AgentModelSettings | undefined,
    taskType,
    ownerDefaultModel,
  );
}
