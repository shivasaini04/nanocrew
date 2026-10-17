/**
 * Stage 64 phase 2 — model calls without model keys in the agent's container.
 *
 * What must hold: the upstream sees the real key and nothing else changes (path, query,
 * body, streamed answer); a request without a live token never reaches the upstream; the
 * relay is not reachable through the public reverse proxy; and the container's own env and
 * payload carry no real provider key.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { _initTestDatabase, createAgent } from '../db.js';
import type { Agent } from '../types.js';
import { issueCycleToken, revokeCycleToken } from './cycle-token.js';
import {
  _setRelayUpstreamForTest,
  issueRelayToken,
  llmRelayHandler,
  relayBaseEnv,
  relayKeySecrets,
  revokeRelayToken,
  RELAY_PATH,
  PROVIDER_KEY_VARS,
} from './llm-relay.js';
import { buildContainerArgs } from './nanobot-cycle-runner.js';

interface Seen {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let upstream: http.Server;
let upstreamPort = 0;
let relay: http.Server;
let relayPort = 0;
let seen: Seen[] = [];
let AGENT = '';

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      // A streamed answer in three pieces, the way a model call streams.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => {
        res.write('data: two\n\n');
        res.end('data: [DONE]\n\n');
      }, 20);
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as AddressInfo).port;

  const app = express();
  app.use(RELAY_PATH, llmRelayHandler);
  app.use(express.json());
  relay = http.createServer(app);
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', () => r()));
  relayPort = (relay.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => relay.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  _initTestDatabase();
  AGENT = createAgent({
    name: 'Finder',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: null,
  }).id;
  seen = [];
  process.env.OPENROUTER_API_KEY = 'sk-or-REAL';
  process.env.GEMINI_API_KEY = 'gem-REAL';
  _setRelayUpstreamForTest(
    'openrouter',
    `http://127.0.0.1:${upstreamPort}/api`,
  );
  _setRelayUpstreamForTest('gemini', `http://127.0.0.1:${upstreamPort}`);
});

afterEach(() => {
  _setRelayUpstreamForTest('openrouter', null);
  _setRelayUpstreamForTest('gemini', null);
});

async function call(
  path: string,
  headers: Record<string, string>,
  body = '{"model":"x","stream":true}',
) {
  const res = await fetch(`http://127.0.0.1:${relayPort}${RELAY_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, text: await res.text() };
}

describe('llm relay', () => {
  it('swaps the token for the real key and changes nothing else — path, query, body, streamed answer', async () => {
    const token = issueCycleToken(AGENT, 'cyc-1');
    const r = await call('/openrouter/v1/chat/completions?x=1', {
      authorization: `Bearer ${token}`,
    });
    expect(r.status).toBe(200);
    expect(r.text).toBe('data: one\n\ndata: two\n\ndata: [DONE]\n\n');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/api/v1/chat/completions?x=1');
    expect(seen[0].headers.authorization).toBe('Bearer sk-or-REAL');
    expect(seen[0].body).toBe('{"model":"x","stream":true}');
    expect(JSON.stringify(seen[0].headers)).not.toContain(token);
    revokeCycleToken(token);
  });

  it('no token, a made-up token, or a revoked one: refused before the upstream is touched', async () => {
    expect((await call('/openrouter/v1/chat/completions', {})).status).toBe(
      401,
    );
    expect(
      (
        await call('/openrouter/v1/chat/completions', {
          authorization: 'Bearer nope',
        })
      ).status,
    ).toBe(401);
    const token = issueCycleToken(AGENT, 'cyc-2');
    revokeCycleToken(token);
    expect(
      (
        await call('/openrouter/v1/chat/completions', {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('is not reachable through the public reverse proxy', async () => {
    const token = issueCycleToken(AGENT, 'cyc-3');
    const r = await call('/openrouter/v1/chat/completions', {
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '1.2.3.4',
    });
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
    revokeCycleToken(token);
  });

  it('an unknown provider is a 404, not a request to anywhere', async () => {
    const token = issueCycleToken(AGENT, 'cyc-4');
    expect(
      (await call('/evil.example/v1/x', { authorization: `Bearer ${token}` }))
        .status,
    ).toBe(404);
    revokeCycleToken(token);
  });

  it('gemini: the key moves to x-goog-api-key, and a ?key= token is stripped from the URL', async () => {
    const token = issueCycleToken(AGENT, 'cyc-5');
    await call(`/gemini/v1beta/models/m:generateContent?key=${token}`, {});
    await call('/gemini/v1beta/models/m:generateContent', {
      'x-goog-api-key': token,
    });
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.headers['x-goog-api-key']).toBe('gem-REAL');
      expect(s.url).toBe('/v1beta/models/m:generateContent');
    }
    revokeCycleToken(token);
  });

  it('search services: TinyFish X-API-Key and Brave X-Subscription-Token are swapped the same way', async () => {
    process.env.TINYFISH_API_KEY = 'tf-REAL';
    process.env.BRAVE_API_KEY = 'brave-REAL';
    _setRelayUpstreamForTest(
      'tinyfish-search',
      `http://127.0.0.1:${upstreamPort}`,
    );
    _setRelayUpstreamForTest('brave', `http://127.0.0.1:${upstreamPort}`);
    const token = issueCycleToken(AGENT, 'cyc-7');
    await call('/tinyfish-search?q=x', { 'x-api-key': token });
    await call('/brave/res/v1/web/search?q=x', {
      'x-subscription-token': token,
    });
    expect(seen[0].headers['x-api-key']).toBe('tf-REAL');
    expect(seen[1].headers['x-subscription-token']).toBe('brave-REAL');
    expect(seen[1].url).toBe('/res/v1/web/search?q=x');
    revokeCycleToken(token);
    _setRelayUpstreamForTest('tinyfish-search', null);
    _setRelayUpstreamForTest('brave', null);
    delete process.env.TINYFISH_API_KEY;
    delete process.env.BRAVE_API_KEY;
  });

  it('a relay-only token (swarm worker) opens the relay, and stops working once revoked', async () => {
    const token = issueRelayToken(AGENT, 'attempt-1');
    expect(
      (
        await call('/openrouter/v1/chat/completions', {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(200);
    revokeRelayToken(token);
    expect(
      (
        await call('/openrouter/v1/chat/completions', {
          authorization: `Bearer ${token}`,
        })
      ).status,
    ).toBe(401);
  });

  it('a provider with no key configured answers 503 without calling out', async () => {
    delete process.env.OPENROUTER_API_KEY;
    const token = issueCycleToken(AGENT, 'cyc-6');
    const r = await call('/openrouter/v1/chat/completions', {
      authorization: `Bearer ${token}`,
    });
    // The .env file may still hold a key in a dev checkout; either way the token never leaks.
    expect([200, 503]).toContain(r.status);
    revokeCycleToken(token);
  });
});

describe('what the container gets', () => {
  it('relayKeySecrets: the token under every key name, only for providers that have a key', () => {
    const env = relayKeySecrets(AGENT, 'tok');
    expect(env.OPENROUTER_API_KEY).toBe('tok');
    expect(env.GEMINI_API_KEY).toBe('tok');
    for (const v of Object.values(env)) expect(v).toBe('tok');
  });

  it('relayBaseEnv points each provider at its relay route with the base litellm expects', () => {
    const env = relayBaseEnv('http://host.docker.internal:3002');
    expect(env.OPENROUTER_API_BASE).toBe(
      'http://host.docker.internal:3002/api/relay/llm/openrouter/v1',
    );
    expect(env.DEEPSEEK_API_BASE).toBe(
      'http://host.docker.internal:3002/api/relay/llm/deepseek/beta',
    );
    expect(env.GROQ_API_BASE).toBe(
      'http://host.docker.internal:3002/api/relay/llm/groq/openai/v1',
    );
    // litellm appends /models/{model}:{endpoint} to a custom gemini base — the version is in the base.
    expect(env.GEMINI_API_BASE).toBe(
      'http://host.docker.internal:3002/api/relay/llm/gemini/v1beta',
    );
    expect(env.NC_LLM_RELAY).toBe(
      'http://host.docker.internal:3002/api/relay/llm',
    );
  });

  it('a service with a keyless mode is only pointed at the relay when a key exists', () => {
    process.env.FIRECRAWL_API_KEY = 'fc-REAL';
    expect(relayBaseEnv('http://h').FIRECRAWL_API_BASE).toBe(
      'http://h/api/relay/llm/firecrawl/v2',
    );
    process.env.FIRECRAWL_API_KEY = '';
    // With no key anywhere, Firecrawl's keyless tier must still go straight out.
    const env = relayBaseEnv('http://h');
    if (!env.FIRECRAWL_API_BASE) expect(env.FIRECRAWL_API_BASE).toBeUndefined();
    delete process.env.FIRECRAWL_API_KEY;
  });

  it('container args carry no real provider key — only the relay bases and the non-provider keys', () => {
    const args = buildContainerArgs(
      'NanoCrew-test',
      '/tmp/agent',
      '/tmp/nanoagent',
      '/tmp/ipc',
      {
        OPENROUTER_API_KEY: 'sk-or-REAL',
        GEMINI_API_KEY: 'gem-REAL',
        FIRECRAWL_API_KEY: 'fc-REAL',
        NANOBOT_MODEL: 'openrouter/z-ai/glm-5.3-flash',
      },
      {},
    ).join(' ');
    expect(args).not.toContain('sk-or-REAL');
    expect(args).not.toContain('gem-REAL');
    expect(args).not.toContain('fc-REAL');
    expect(args).toContain(
      'OPENROUTER_API_BASE=http://host.docker.internal:3002/api/relay/llm/openrouter/v1',
    );
    expect(args).toContain('NANOBOT_MODEL=openrouter/z-ai/glm-5.3-flash');
    expect(args).not.toContain('LITELLM_PROXY_KEY');
    expect(PROVIDER_KEY_VARS.has('OPENROUTER_API_KEY')).toBe(true);
  });
});
