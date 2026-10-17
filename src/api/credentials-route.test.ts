/**
 * The agent-facing credential vault route.
 *
 * This route handed back live platform provider secrets to any caller who knew an agent
 * UUID — and agent ids are not secrets, they appear in logs, socket payloads and
 * dashboard URLs. These tests pin the fix so it cannot quietly regress: the route is
 * mounted where a container can reach it (no session cookie) but answers only to a live
 * per-cycle token bound to that agent.
 *
 * The route body is reproduced here rather than imported, because it is defined inline
 * inside createApiServer() in server.ts, which cannot be constructed in a unit test
 * (it opens sockets, the DB, and the whole router graph). The token-checking logic under
 * test — extractCycleToken + verifyCycleToken — is imported for real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

import {
  issueCycleToken,
  verifyCycleToken,
  extractCycleToken,
  revokeCycleToken,
} from '../agents/cycle-token.js';

const SECRET = { api_key: 'sk-platform-secret-value' };

let server: Server;
let baseUrl: string;
let token: string;

beforeAll(async () => {
  const app = express();
  app.get('/api/agents/:id/credentials/:service', (req, res) => {
    const agentId = req.params.id as string;
    const t = extractCycleToken(
      req.headers.authorization,
      req.headers['x-cycle-token'],
    );
    if (!verifyCycleToken(t, agentId)) {
      return res.status(401).json({ error: 'Invalid or expired cycle token' });
    }
    if (agentId !== 'agent-1')
      return res.status(404).json({ error: 'Agent not found' });
    if (req.params.service !== 'apollo') {
      return res.status(404).json({
        error: `No credential stored for service '${req.params.service}'`,
      });
    }
    res.json(SECRET);
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  token = issueCycleToken('agent-1', 'cycle-1');
});

function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, { headers });
}

describe('agent credential vault route', () => {
  /** The vulnerability, stated as a test: a bare GET must not return a secret. */
  it('does not hand a platform secret to an unauthenticated caller who knows the agent id', async () => {
    const res = await get('/api/agents/agent-1/credentials/apollo');
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET.api_key);
  });

  it('rejects a bogus token', async () => {
    const res = await get('/api/agents/agent-1/credentials/apollo', {
      authorization: 'Bearer deadbeef',
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET.api_key);
  });

  /** Every running agent holds a live token, so an unbound one would expose everyone's. */
  it("rejects another agent's live token", async () => {
    const other = issueCycleToken('agent-2', 'cycle-2');
    const res = await get('/api/agents/agent-1/credentials/apollo', {
      authorization: `Bearer ${other}`,
    });
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SECRET.api_key);
  });

  it('serves the credential to the agent the token was minted for', async () => {
    const res = await get('/api/agents/agent-1/credentials/apollo', {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).api_key).toBe(SECRET.api_key);
  });

  it('accepts the X-Cycle-Token header as well as Authorization', async () => {
    const res = await get('/api/agents/agent-1/credentials/apollo', {
      'x-cycle-token': token,
    });
    expect(res.status).toBe(200);
  });

  /** The token's life is the cycle's life — afterwards the route goes quiet again. */
  it('stops serving once the cycle ends and the token is revoked', async () => {
    revokeCycleToken(token);
    const res = await get('/api/agents/agent-1/credentials/apollo', {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(401);
  });

  it('401s before 404 so an invalid token cannot probe which agents exist', async () => {
    const res = await get('/api/agents/does-not-exist/credentials/apollo');
    expect(res.status).toBe(401);
  });
});

describe('extractCycleToken', () => {
  it('reads a bearer token case-insensitively and trims it', () => {
    expect(extractCycleToken('Bearer abc123')).toBe('abc123');
    expect(extractCycleToken('bearer  abc123 ')).toBe('abc123');
  });

  it('falls back to X-Cycle-Token, and tolerates express array headers', () => {
    expect(extractCycleToken(undefined, 'abc123')).toBe('abc123');
    expect(extractCycleToken(['Bearer abc123'])).toBe('abc123');
  });

  it('returns empty string when neither header is present', () => {
    expect(extractCycleToken(undefined, undefined)).toBe('');
    expect(extractCycleToken('', '')).toBe('');
  });
});
