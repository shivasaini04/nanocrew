/**
 * LLM key relay — model calls without model keys in the agent's container.
 *
 * Stage 64 phase 2. Until now every cycle container got the platform's provider keys
 * (OpenRouter, DeepSeek, Gemini, Groq, Kimi) as env vars and again in the stdin payload,
 * and agents run `exec` — so any agent could read every key with `env`, and a prompt
 * injection could send them anywhere. Muse and Dots both advertise the opposite: the model
 * never holds a secret.
 *
 * The container now gets, per provider, a base URL pointing here and the cycle's token in
 * place of the key. litellm reads `<PROVIDER>_API_BASE` from the env for every provider this
 * platform uses (checked in the agent image, litellm 1.103.1), so every model call —
 * including the ones code makes through litellm without going through LiteLLMProvider — comes
 * here unchanged. This handler checks the token, swaps in the real key (the owner's BYOK key
 * when they have one for that provider), and streams the provider's answer straight back.
 *
 * What an agent can still do with its token: call the same provider APIs, for as long as its
 * cycle lives (TOKEN_TTL_MS). What it can no longer do: take a key off the box, or point one
 * at any other host — the upstream for each provider is fixed below.
 */
import http from 'http';
import https from 'https';
import type { Request, Response } from 'express';

import { randomBytes } from 'crypto';

import { resolveCycleToken, TOKEN_TTL_MS } from './cycle-token.js';
import { getAgent, getUserByok } from '../db.js';
import { decryptByok } from '../byok-crypto.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

export interface RelayProvider {
  /** Origin plus path prefix; the relayed path is appended to it. Fixed — never from the request. */
  upstream: string;
  /** The platform's key for this provider (process env, then the .env file). */
  keyEnv: string;
  /** BYOK provider id this relay entry serves, when an owner brings their own key. */
  byok: string | null;
  /** Where the key goes upstream. */
  auth: 'bearer' | 'x-goog-api-key' | 'x-api-key' | 'x-subscription-token';
  /**
   * Point the client at the relay only when a key exists. For a service with a keyless
   * mode (Firecrawl), a base URL without a key would send keyless calls here, tokenless.
   */
  onlyWithKey?: boolean;
  /** Path under this provider's relay route that the client should use as its API base. */
  clientBase: string;
  /** Env vars a client reads for this provider's API base. */
  baseEnv: string[];
  /** Env vars a client reads for this provider's key — they get the cycle token instead. */
  keyVars: string[];
}

export const RELAY_PATH = '/api/relay/llm';

export const RELAY_PROVIDERS: Record<string, RelayProvider> = {
  openrouter: {
    upstream: 'https://openrouter.ai/api',
    keyEnv: 'OPENROUTER_API_KEY',
    byok: 'openrouter',
    auth: 'bearer',
    clientBase: '/v1',
    baseEnv: ['OPENROUTER_API_BASE'],
    keyVars: ['OPENROUTER_API_KEY'],
  },
  deepseek: {
    upstream: 'https://api.deepseek.com',
    keyEnv: 'DEEPSEEK_API_KEY',
    byok: 'deepseek',
    auth: 'bearer',
    clientBase: '/beta',
    baseEnv: ['DEEPSEEK_API_BASE'],
    keyVars: ['DEEPSEEK_API_KEY'],
  },
  groq: {
    upstream: 'https://api.groq.com',
    keyEnv: 'GROQ_API_KEY',
    byok: 'groq',
    auth: 'bearer',
    clientBase: '/openai/v1',
    baseEnv: ['GROQ_API_BASE'],
    keyVars: ['GROQ_API_KEY'],
  },
  moonshot: {
    upstream: 'https://api.moonshot.ai',
    keyEnv: 'MOONSHOT_KIMI_API_KEY',
    byok: null,
    auth: 'bearer',
    clientBase: '/v1',
    baseEnv: ['MOONSHOT_API_BASE'],
    keyVars: ['MOONSHOT_API_KEY', 'MOONSHOT_KIMI_API_KEY'],
  },
  // With a custom base litellm builds {base}/models/{model}:{endpoint} — no API version —
  // so the version is part of the base (live 404 on 2026-09-30 before this).
  gemini: {
    upstream: 'https://generativelanguage.googleapis.com',
    keyEnv: 'GEMINI_API_KEY',
    byok: 'gemini',
    auth: 'x-goog-api-key',
    clientBase: '/v1beta',
    baseEnv: ['GEMINI_API_BASE'],
    keyVars: ['GEMINI_API_KEY'],
  },
  anthropic: {
    upstream: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
    byok: 'anthropic',
    auth: 'x-api-key',
    clientBase: '',
    baseEnv: ['ANTHROPIC_API_BASE'],
    keyVars: ['ANTHROPIC_API_KEY'],
  },
  openai: {
    upstream: 'https://api.openai.com',
    keyEnv: 'OPENAI_API_KEY',
    byok: 'openai',
    auth: 'bearer',
    clientBase: '/v1',
    baseEnv: ['OPENAI_API_BASE', 'OPENAI_BASE_URL'],
    keyVars: ['OPENAI_API_KEY'],
  },
  // Search and fetch services (web.py, firecrawl_client.py, tinyfish_client.py). Same
  // swap; their clients read the *_BASE vars below (not litellm).
  firecrawl: {
    upstream: 'https://api.firecrawl.dev',
    keyEnv: 'FIRECRAWL_API_KEY',
    byok: null,
    auth: 'bearer',
    clientBase: '/v2',
    baseEnv: ['FIRECRAWL_API_BASE'],
    keyVars: ['FIRECRAWL_API_KEY'],
    onlyWithKey: true,
  },
  'tinyfish-search': {
    upstream: 'https://api.search.tinyfish.ai',
    keyEnv: 'TINYFISH_API_KEY',
    byok: null,
    auth: 'x-api-key',
    clientBase: '',
    baseEnv: ['TINYFISH_SEARCH_BASE'],
    keyVars: ['TINYFISH_API_KEY'],
    onlyWithKey: true,
  },
  'tinyfish-fetch': {
    upstream: 'https://api.fetch.tinyfish.ai',
    keyEnv: 'TINYFISH_API_KEY',
    byok: null,
    auth: 'x-api-key',
    clientBase: '',
    baseEnv: ['TINYFISH_FETCH_BASE'],
    keyVars: ['TINYFISH_API_KEY'],
    onlyWithKey: true,
  },
  brave: {
    upstream: 'https://api.search.brave.com',
    keyEnv: 'BRAVE_API_KEY',
    byok: null,
    auth: 'x-subscription-token',
    clientBase: '/res/v1',
    baseEnv: ['BRAVE_API_BASE'],
    keyVars: ['BRAVE_API_KEY'],
    onlyWithKey: true,
  },
};

/** On unless LLM_RELAY=off — the one-line rollback to keys-in-the-container. */
export function llmRelayEnabled(): boolean {
  return (process.env.LLM_RELAY ?? 'on').toLowerCase() !== 'off';
}

function platformKey(spec: RelayProvider): string {
  return (
    process.env[spec.keyEnv] || readEnvFile([spec.keyEnv])[spec.keyEnv] || ''
  );
}

/** The owner's own key for this provider, when they brought one. */
function byokKey(spec: RelayProvider, agentId: string): string | null {
  if (!spec.byok) return null;
  try {
    const ownerId = (getAgent(agentId) as { owner_id?: string } | null)
      ?.owner_id;
    if (!ownerId) return null;
    const bk = getUserByok(ownerId);
    if (bk.provider !== spec.byok || !bk.keyEnc) return null;
    return decryptByok(bk.keyEnc);
  } catch (err) {
    logger.warn(
      { err: String(err), agentId },
      'llm-relay: BYOK resolve failed — using the platform key',
    );
    return null;
  }
}

/** The real key a relayed call for this agent should carry, or '' when none exists. */
export function relayKeyFor(provider: string, agentId: string): string {
  const spec = RELAY_PROVIDERS[provider];
  if (!spec) return '';
  return byokKey(spec, agentId) || platformKey(spec);
}

/**
 * Container env pointing every provider at the relay. Static — safe to bake into a warm
 * daemon at start. `host` is how a container reaches the orchestrator.
 */
export function relayBaseEnv(host: string): Record<string, string> {
  const root = `${host.replace(/\/$/, '')}${RELAY_PATH}`;
  const env: Record<string, string> = { NC_LLM_RELAY: root };
  for (const [name, spec] of Object.entries(RELAY_PROVIDERS)) {
    if (spec.onlyWithKey && !platformKey(spec)) continue;
    for (const v of spec.baseEnv) env[v] = `${root}/${name}${spec.clientBase}`;
  }
  return env;
}

/**
 * The per-cycle key env: the cycle token under every key name a client reads, for each
 * provider that actually has a key (platform or the owner's). A provider with no key gets
 * nothing, exactly as before, so model selection still skips it.
 */
export function relayKeySecrets(
  agentId: string,
  cycleToken: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, spec] of Object.entries(RELAY_PROVIDERS)) {
    if (!relayKeyFor(name, agentId)) continue;
    for (const v of spec.keyVars) env[v] = cycleToken;
  }
  return env;
}

// ─── Relay-only tokens ──────────────────────────────────────────────────────────────────
//
// A swarm worker deliberately gets no cycle token: it has a shell, and a cycle token bound
// to its owner would open the owner's self-management and approval routes. It still has to
// call a model. A relay token opens the relay and nothing else — no other route consults
// this map.

const relayTokens = new Map<
  string,
  { agentId: string; runId: string; expiresAt: number }
>();

export function issueRelayToken(
  agentId: string,
  runId: string,
  ttlMs: number = TOKEN_TTL_MS,
): string {
  const now = Date.now();
  for (const [t, r] of relayTokens)
    if (r.expiresAt <= now) relayTokens.delete(t);
  const token = `rly_${randomBytes(24).toString('hex')}`;
  relayTokens.set(token, { agentId, runId, expiresAt: now + ttlMs });
  return token;
}

export function revokeRelayToken(token: string | null | undefined): void {
  if (token) relayTokens.delete(token);
}

/** Who a token speaks for at the relay: a live cycle token, or a live relay-only token. */
function relayCaller(token: string | null): { agentId: string } | null {
  const cycle = resolveCycleToken(token);
  if (cycle) return cycle;
  if (!token) return null;
  const r = relayTokens.get(token);
  return r && r.expiresAt > Date.now() ? { agentId: r.agentId } : null;
}

/** Every env name that used to carry a real provider key into a container. */
export const PROVIDER_KEY_VARS: ReadonlySet<string> = new Set(
  Object.values(RELAY_PROVIDERS).flatMap((s) => s.keyVars),
);

// ─── The handler ────────────────────────────────────────────────────────────────────────

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);
/** Request headers that carry the client's credential or identity — never forwarded. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-goog-api-key',
  'x-api-key',
  'x-subscription-token',
  'cookie',
  'x-cycle-token',
]);

const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 64 });
const firstCallLogged = new Set<string>();

function tokenFrom(req: Request, spec: RelayProvider, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const goog = req.headers['x-goog-api-key'];
  if (typeof goog === 'string' && goog) return goog;
  const xak = req.headers['x-api-key'];
  if (typeof xak === 'string' && xak) return xak;
  const xst = req.headers['x-subscription-token'];
  if (typeof xst === 'string' && xst) return xst;
  // Gemini's REST examples put the key in ?key= — accepted for that provider only.
  if (spec.auth === 'x-goog-api-key') return url.searchParams.get('key');
  return null;
}

/** Test hook: point a provider at a local fake upstream. */
let upstreamOverride: Record<string, string> = {};
export function _setRelayUpstreamForTest(
  provider: string,
  upstream: string | null,
): void {
  if (upstream) upstreamOverride[provider] = upstream;
  else delete upstreamOverride[provider];
}

/**
 * Mounted at RELAY_PATH, ahead of the JSON body parser: the body is streamed through
 * untouched, and so is the answer (model calls stream).
 */
export function llmRelayHandler(req: Request, res: Response): void {
  // req.url here is relative to the mount point: "/<provider>/<rest>?<query>".
  const m = /^\/([a-z-]+)(\/[^?]*)?(\?.*)?$/.exec(req.url);
  const name = m?.[1] ?? '';
  const spec = RELAY_PROVIDERS[name];
  if (!m || !spec) {
    res.status(404).json({ error: { message: 'relay: unknown provider' } });
    return;
  }
  // Containers reach the orchestrator directly. Anything that came through the public
  // reverse proxy carries X-Forwarded-For, and the relay is not for the internet.
  if (req.headers['x-forwarded-for']) {
    res.status(404).json({ error: { message: 'not found' } });
    return;
  }

  const base = upstreamOverride[name] ?? spec.upstream;
  const target = new URL(`${base}${m[2] ?? ''}${m[3] ?? ''}`);
  const token = tokenFrom(req, spec, target);
  const who = relayCaller(token);
  if (!who) {
    res.status(401).json({
      error: {
        message: 'relay: no live cycle token (the cycle may have ended)',
        type: 'authentication_error',
      },
    });
    return;
  }
  const key = relayKeyFor(name, who.agentId);
  if (!key) {
    res.status(503).json({
      error: {
        message: `relay: no ${name} key is configured`,
        type: 'authentication_error',
      },
    });
    return;
  }
  target.searchParams.delete('key');

  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (
      HOP_BY_HOP.has(lk) ||
      CREDENTIAL_HEADERS.has(lk) ||
      lk.startsWith('x-forwarded-')
    )
      continue;
    if (v !== undefined) headers[lk] = v;
  }
  if (spec.auth === 'bearer') headers['authorization'] = `Bearer ${key}`;
  else headers[spec.auth] = key;

  const started = Date.now();
  const client = target.protocol === 'https:' ? https : http;
  const upstreamReq = client.request(
    target,
    {
      method: req.method,
      headers,
      agent: target.protocol === 'https:' ? keepAlive : undefined,
    },
    (upRes) => {
      const outHeaders: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined)
          outHeaders[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, outHeaders);
      upRes.pipe(res);
      upRes.on('end', () => {
        const seenKey = `${who.agentId}:${name}`;
        const first = !firstCallLogged.has(seenKey);
        if (first) firstCallLogged.add(seenKey);
        // Info once per agent and provider per process — proof the path is used, without a
        // line per model call.
        logger[first ? 'info' : 'debug'](
          {
            provider: name,
            agentId: who.agentId,
            status: upRes.statusCode,
            ms: Date.now() - started,
          },
          first
            ? 'llm-relay: first relayed call for this agent and provider'
            : 'llm-relay',
        );
      });
    },
  );
  // A model call can legitimately run for minutes; only a socket idle this long is dead.
  upstreamReq.setTimeout(15 * 60_000, () =>
    upstreamReq.destroy(new Error('upstream idle timeout')),
  );
  upstreamReq.on('error', (err) => {
    logger.warn(
      { provider: name, agentId: who.agentId, err: err.message },
      'llm-relay: upstream error',
    );
    if (!res.headersSent)
      res.status(502).json({
        error: { message: `relay: ${name} unreachable (${err.message})` },
      });
    else res.destroy(err);
  });
  // The client gave up (cancelled stream, cycle killed) — stop paying for the answer.
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });
  req.pipe(upstreamReq);
}
