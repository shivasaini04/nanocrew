/**
 * Is a model usable right now — does its provider still list it, and can the account pay?
 *
 * Stage 64 phase 3 ("stop losing runs"). In the 30 days to 2026-09-30, 5 cycles failed on a
 * model that no longer existed (an OpenRouter id gone, Groq retiring llama-3.3-70b-versatile),
 * and the platform default — deepseek/deepseek-v4-flash, direct — answers every call with 402
 * because the account has no balance. 12 agents with no model of their own run on it, and so
 * do the orchestrator's own writing jobs (check-in reports, episode logs, identity updates),
 * which have no fallback chain and fail silently.
 *
 * A background refresher asks each provider for its model list (and, where an API exists,
 * the account balance) every few hours. `modelStatus()` is a synchronous cache read, so the
 * model router can consult it on every resolve. Anything not known for certain is 'unknown'
 * and treated as usable: this check may only ever remove a failure, never add one.
 */
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export type ModelStatus = 'ok' | 'dead' | 'unknown';

interface ProviderState {
  /** Model ids the provider lists, as the provider names them. Null = could not fetch. */
  models: Set<string> | null;
  /** False = the account cannot pay (checked with the provider's balance API). Null = unknown. */
  funded: boolean | null;
  checkedAt: number;
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

interface ProviderProbe {
  keyEnv: string;
  /** Fetch the provider's model ids. */
  models(key: string, f: Fetcher): Promise<Set<string>>;
  /** Whether the account can pay, when the provider has an API for it. */
  funded?(key: string, f: Fetcher): Promise<boolean>;
  /** The provider's id for a NanoCrew model string ("openrouter/z-ai/glm" → "z-ai/glm"). */
  idOf(model: string): string;
}

async function json(
  f: Fetcher,
  url: string,
  headers: Record<string, string>,
): Promise<any> {
  const r = await f(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const stripPrefix = (model: string) => model.split('/').slice(1).join('/');

export const PROBES: Record<string, ProviderProbe> = {
  openrouter: {
    keyEnv: 'OPENROUTER_API_KEY',
    // Public — no key needed for the list.
    models: async (_k, f) =>
      new Set(
        (
          (await json(f, 'https://openrouter.ai/api/v1/models', {})).data ?? []
        ).map((m: { id: string }) => m.id),
      ),
    funded: async (k, f) => {
      const d =
        (
          await json(f, 'https://openrouter.ai/api/v1/credits', {
            authorization: `Bearer ${k}`,
          })
        ).data ?? {};
      return Number(d.total_credits ?? 0) - Number(d.total_usage ?? 0) > 0;
    },
    idOf: stripPrefix,
  },
  deepseek: {
    keyEnv: 'DEEPSEEK_API_KEY',
    models: async (k, f) =>
      new Set(
        (
          (
            await json(f, 'https://api.deepseek.com/models', {
              authorization: `Bearer ${k}`,
            })
          ).data ?? []
        ).map((m: { id: string }) => m.id),
      ),
    funded: async (k, f) =>
      (
        await json(f, 'https://api.deepseek.com/user/balance', {
          authorization: `Bearer ${k}`,
        })
      ).is_available === true,
    idOf: stripPrefix,
  },
  groq: {
    keyEnv: 'GROQ_API_KEY',
    models: async (k, f) =>
      new Set(
        (
          (
            await json(f, 'https://api.groq.com/openai/v1/models', {
              authorization: `Bearer ${k}`,
            })
          ).data ?? []
        ).map((m: { id: string }) => m.id),
      ),
    idOf: stripPrefix,
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    models: async (k, f) =>
      new Set(
        (
          (
            await json(
              f,
              'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
              { 'x-goog-api-key': k },
            )
          ).models ?? []
        ).map((m: { name: string }) => m.name.replace(/^models\//, '')),
      ),
    idOf: stripPrefix,
  },
  moonshot: {
    keyEnv: 'MOONSHOT_KIMI_API_KEY',
    models: async (k, f) =>
      new Set(
        (
          (
            await json(f, 'https://api.moonshot.ai/v1/models', {
              authorization: `Bearer ${k}`,
            })
          ).data ?? []
        ).map((m: { id: string }) => m.id),
      ),
    idOf: stripPrefix,
  },
};

const state = new Map<string, ProviderState>();
let timer: ReturnType<typeof setInterval> | null = null;
export const REFRESH_EVERY_MS = 6 * 60 * 60_000;

function platformKey(env: string): string {
  return process.env[env] || readEnvFile([env])[env] || '';
}

/** Refresh one provider. Never throws: a failed probe leaves that part 'unknown'. */
async function refreshProvider(
  name: string,
  probe: ProviderProbe,
  f: Fetcher,
): Promise<void> {
  const key = platformKey(probe.keyEnv);
  const next: ProviderState = {
    models: null,
    funded: null,
    checkedAt: Date.now(),
  };
  if (!key && name !== 'openrouter') {
    // No key at all: every model on it is unusable, and that IS certain.
    next.funded = false;
    state.set(name, next);
    return;
  }
  try {
    next.models = await probe.models(key, f);
  } catch (err) {
    logger.debug(
      { provider: name, err: String(err) },
      'model-health: model list unavailable',
    );
  }
  if (probe.funded && key) {
    try {
      next.funded = await probe.funded(key, f);
    } catch (err) {
      logger.debug(
        { provider: name, err: String(err) },
        'model-health: balance unavailable',
      );
    }
  }
  state.set(name, next);
}

/** Refresh every provider now. Exposed for boot and tests. */
export async function refreshModelHealth(f: Fetcher = fetch): Promise<void> {
  await Promise.all(
    Object.entries(PROBES).map(([n, p]) => refreshProvider(n, p, f)),
  );
  const summary = Object.fromEntries(
    [...state].map(([n, s]) => [
      n,
      {
        models: s.models ? s.models.size : null,
        funded: s.funded,
      },
    ]),
  );
  logger.info({ providers: summary }, 'model-health: refreshed');
}

export function startModelHealth(): void {
  if (timer) return;
  void refreshModelHealth();
  timer = setInterval(() => {
    void refreshModelHealth();
  }, REFRESH_EVERY_MS);
  timer.unref?.();
}

/** Usable as far as anyone can tell? Synchronous cache read; 'unknown' until a probe answered. */
export function modelStatus(model: string): ModelStatus {
  const provider = (model || '').split('/')[0];
  const probe = PROBES[provider];
  const s = state.get(provider);
  if (!probe || !s) return 'unknown';
  if (s.funded === false) return 'dead';
  if (s.models) return s.models.has(probe.idOf(model)) ? 'ok' : 'dead';
  return 'unknown';
}

/** Why a model is dead, in words for a log or a warning. */
export function deadReason(model: string): string {
  const provider = (model || '').split('/')[0];
  const s = state.get(provider);
  if (!s) return 'unknown';
  if (s.funded === false)
    return `the ${provider} account cannot pay (no balance or no key)`;
  if (s.models && !s.models.has(PROBES[provider]?.idOf(model) ?? ''))
    return `${provider} no longer lists this model`;
  return 'unknown';
}

/** Test hook. */
export function _setModelHealthForTest(
  provider: string,
  s: Partial<ProviderState> | null,
): void {
  if (!s) {
    state.delete(provider);
    return;
  }
  state.set(provider, {
    models: s.models ?? null,
    funded: s.funded ?? null,
    checkedAt: Date.now(),
  });
}
