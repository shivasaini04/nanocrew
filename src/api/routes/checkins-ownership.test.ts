/**
 * Check-ins belong to their agent's owner, on every route that reads or answers them.
 *
 * `GET /api/agents/checkins/pending` has no `:id`, so the router.param ownership guard never
 * ran for it, and it returned every account's pending approvals to any logged-in user —
 * the dashboard fetches it on load. Found 2026-09-14. The per-agent routes were covered by
 * the guard alone; they now check inline too, like their siblings.
 */
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from 'vitest';
import express from 'express';
import os from 'os';
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';

import {
  _initTestDatabase,
  insertAgent,
  createAgentCheckin,
  getCheckinById,
} from '../../db.js';
import { AgentService, type CycleRunner } from '../../agents/agent-service.js';
import type { AgentConfig } from '../../types.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-checkins-'));
const runner: CycleRunner = {
  run: vi.fn(async () => ({ summary: 'ok', cost: 0, tasksDone: 1 })),
};
const realService = new AgentService(tmpDir, runner);

vi.mock('../../agents/agent-registry.js', () => ({
  agentService: new Proxy(
    {},
    {
      get: (_t, p) =>
        (realService as any)[p]?.bind?.(realService) ?? (realService as any)[p],
    },
  ),
  agentScheduler: {},
}));
vi.mock('../server.js', () => ({ getSocketIO: () => null }));

let server: Server;
let baseUrl: string;

const config = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'g',
  escalationRules: [],
} as unknown as AgentConfig;

beforeAll(async () => {
  const { agentsRouter } = await import('./agents.js');
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth: the caller is whoever the header names.
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user') };
    next();
  });
  app.use('/api/agents', agentsRouter);
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
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let mineId: string;
let theirsId: string;

beforeEach(() => {
  _initTestDatabase();
  for (const [id, owner] of [
    ['agent-mine', 'me'],
    ['agent-theirs', 'someone-else'],
  ] as const) {
    insertAgent({
      id,
      name: id,
      type: 'custom',
      status: 'idle',
      workspace: '/tmp/ws',
      config,
      identity_version: 1,
      created_at: '2026-08-01T00:00:00.000Z',
      owner_id: owner,
    });
  }
  mineId = createAgentCheckin({
    agent_id: 'agent-mine',
    status: 'pending',
    report_md: 'my draft',
  }).id;
  theirsId = createAgentCheckin({
    agent_id: 'agent-theirs',
    status: 'pending',
    report_md: 'their draft to a customer',
  }).id;
});

const as = (user: string, p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}/api/agents${p}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-user': user,
      ...(init.headers ?? {}),
    },
  });

describe('check-ins stay with their owner', () => {
  it("the pending list holds only my agents' check-ins", async () => {
    const rows = (await (await as('me', '/checkins/pending')).json()) as Array<{
      id: string;
    }>;
    expect(rows.map((r) => r.id)).toEqual([mineId]);
  });

  it("cannot read another account's check-ins by agent", async () => {
    for (const p of [
      '/agent-theirs/checkins',
      '/agent-theirs/checkins/pending',
      `/agent-theirs/checkins/${theirsId}`,
    ]) {
      expect((await as('me', p)).status, p).toBe(404);
    }
  });

  it("cannot answer another account's check-in", async () => {
    const res = await as('me', `/agent-theirs/checkins/${theirsId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ reply: 'approve' }),
    });
    expect(res.status).toBe(404);
    expect(getCheckinById(theirsId)!.status).toBe('pending');
  });

  it('still lets the owner read their own', async () => {
    const res = await as('someone-else', `/agent-theirs/checkins/${theirsId}`);
    expect(res.status).toBe(200);
  });
});
