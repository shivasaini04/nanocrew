/**
 * Stage 57 phase 5 — a run is visible only to its owner, on every route of the run view.
 * The list has no `:runId`, so it is filtered explicitly rather than by the param guard.
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
import type { Server } from 'http';

import { _initTestDatabase, insertAgent } from '../../db.js';
import { insertAttempt, insertRun, insertTask } from '../../swarm/store.js';
import type { AgentConfig } from '../../types.js';

const cancelled: string[] = [];
vi.mock('../../swarm/service.js', () => ({
  getSwarmEngine: () => ({
    cancelRun: (runId: string) => {
      cancelled.push(runId);
      return true;
    },
  }),
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const { runsRouter } = await import('./runs.js');
  const app = express();
  app.use(express.json());
  // Stand-in for requireAuth: the caller is whoever the header names.
  app.use((req, _res, next) => {
    (req as any).user = { id: req.header('x-user') };
    next();
  });
  app.use('/api/runs', runsRouter);
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

const config = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'g',
  escalationRules: [],
} as unknown as AgentConfig;

function seedRun(id: string, agentId: string, ownerUserId: string) {
  insertRun({
    id,
    owner_agent_id: agentId,
    owner_user_id: ownerUserId,
    boss_cycle_id: null,
    goal: `goal of ${id}`,
    mode: 'fanout',
    status: 'running',
    budget_usd: 0.5,
    max_parallel: 3,
    background: 1,
    trace_id: 't',
    created_at: '2026-09-29T10:00:00.000Z',
  });
  insertTask({
    id: `${id}-t0`,
    run_id: id,
    idx: 0,
    spec_json: JSON.stringify({
      objective: 'find it',
      tools: 'research',
      verifier: [{ kind: 'schema' }],
      max_attempts: 2,
    }),
    depends_on: null,
    dedupe_key: null,
    status: 'leased',
    max_attempts: 2,
    created_at: '2026-09-29T10:00:00.000Z',
  });
  insertAttempt({
    id: `${id}-t0-a1`,
    task_id: `${id}-t0`,
    run_id: id,
    n: 1,
    model: 'm',
    status: 'running',
    lease_expires_at: '2026-09-29T11:00:00.000Z',
    started_at: '2026-09-29T10:00:00.000Z',
  });
}

beforeEach(() => {
  _initTestDatabase();
  cancelled.length = 0;
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
  seedRun('run-mine', 'agent-mine', 'me');
  seedRun('run-theirs', 'agent-theirs', 'someone-else');
});

const as = (user: string, p: string, init: RequestInit = {}) =>
  fetch(`${baseUrl}/api/runs${p}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-user': user,
      ...(init.headers ?? {}),
    },
  });

describe('runs stay with their owner', () => {
  it('the list holds only my runs', async () => {
    const body = (await (await as('me', '/')).json()) as {
      runs: Array<{ id: string }>;
    };
    expect(body.runs.map((r) => r.id)).toEqual(['run-mine']);
  });

  it("cannot read, open the transcript of, or cancel another account's run", async () => {
    expect((await as('me', '/run-theirs')).status).toBe(404);
    expect(
      (await as('me', '/run-theirs/attempts/run-theirs-t0-a1/transcript'))
        .status,
    ).toBe(404);
    expect(
      (await as('me', '/run-theirs/cancel', { method: 'POST' })).status,
    ).toBe(404);
    expect(cancelled).toEqual([]);
  });

  it("cannot reach another run's attempt, or any path, through my own run", async () => {
    expect(
      (await as('me', '/run-mine/attempts/run-theirs-t0-a1/transcript')).status,
    ).toBe(404);
    expect(
      (
        await as(
          'me',
          `/run-mine/attempts/${encodeURIComponent('../../../etc')}/transcript`,
        )
      ).status,
    ).toBe(404);
  });

  it('shows the owner the run, its tasks and health', async () => {
    const res = await as('me', '/run-mine');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      run: { goal: string };
      tasks: Array<{ status: string; attempts: unknown[] }>;
      health: unknown[];
    };
    expect(body.run.goal).toBe('goal of run-mine');
    expect(body.tasks[0].status).toBe('leased');
    expect(body.tasks[0].attempts).toHaveLength(1);
    expect(Array.isArray(body.health)).toBe(true);
    expect(
      (await as('me', '/run-mine/cancel', { method: 'POST' })).status,
    ).toBe(200);
    expect(cancelled).toEqual(['run-mine']);
  });
});
