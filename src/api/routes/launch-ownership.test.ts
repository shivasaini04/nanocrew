import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import express from 'express';
import type { Server } from 'http';
import {
  _initTestDatabase,
  createAgentMessage,
  createPipeline,
  createProject,
  getAgent,
  getAllAgents,
  getMatchingPipelines,
  getNotifications,
  getPipeline,
  insertAgent,
  linkAgentToProject,
  setRowOwner,
  updatePipeline,
} from '../../db.js';
import type { AgentConfig } from '../../types.js';

vi.mock('../../agents/agent-registry.js', () => ({
  agentService: { getAllAgents, getAgent },
}));

let server: Server;
let baseUrl: string;
let pipelineId: string;

beforeAll(async () => {
  const [{ crewRouter }, { notificationsRouter }, { pipelinesRouter }, tools] =
    await Promise.all([
      import('./crew.js'),
      import('./notifications.js'),
      import('./pipelines.js'),
      import('./tools.js'),
    ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: req.header('x-user') ?? 'me',
      role: 'user',
    } as unknown as express.Request['user'];
    next();
  });
  app.use('/crew', crewRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/pipelines', pipelinesRouter);
  app.use('/tools', tools.default);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

const config: AgentConfig = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'test',
  escalationRules: [],
};

beforeEach(() => {
  _initTestDatabase();
  for (const [id, owner_id] of [
    ['mine', 'me'],
    ['teammate', 'me'],
    ['theirs', 'other'],
  ] as const) {
    insertAgent({
      id,
      owner_id,
      name: id,
      type: 'custom',
      status: 'idle',
      workspace: '/tmp/test',
      config,
      identity_version: 1,
      created_at: new Date().toISOString(),
    });
  }
  for (const [id, owner] of [
    ['my-project', 'me'],
    ['their-project', 'other'],
  ] as const) {
    const now = new Date().toISOString();
    createProject({
      id,
      name: id,
      chat_jid: `project:${id}`,
      status: 'active',
      created_at: now,
      updated_at: now,
    });
    setRowOwner('projects', id, owner);
  }
  linkAgentToProject('mine', 'my-project');
  linkAgentToProject('theirs', 'their-project');
  // Even inconsistent historical links must not disclose the other owner's project.
  linkAgentToProject('mine', 'their-project');
  for (const [from_agent_id, to_agent_id] of [
    ['mine', 'teammate'],
    ['theirs', 'mine'],
  ] as const) {
    createAgentMessage({
      from_agent_id,
      to_agent_id,
      subject: 'test',
      body: 'private',
    });
  }
  const pipeline = createPipeline({
    name: 'mine',
    enabled: true,
    source_agent_id: null,
    trigger_cycle_type: null,
    trigger_status: 'completed',
    target_agent_id: 'mine',
    target_cycle_type: 'custom',
    inject_output: true,
    project_id: null,
  });
  pipelineId = pipeline.id;
  setRowOwner('pipelines', pipelineId, 'me');
});

const request = (path: string, method = 'GET', body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe('release ownership boundaries', () => {
  it('returns only owned crew edges, projects and memberships', async () => {
    const res = await request('/crew/graph');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      agents: Array<{ id: string }>;
      edges: Array<{ from: string; to: string }>;
      projects: Array<{ id: string; agents: string[] }>;
    };
    expect(body.agents.map((a) => a.id).sort()).toEqual(['mine', 'teammate']);
    expect(body.edges.map((e) => [e.from, e.to])).toEqual([
      ['mine', 'teammate'],
    ]);
    expect(body.projects).toEqual([
      { id: 'my-project', name: 'my-project', agents: ['mine'] },
    ]);
  });

  it('returns empty crew data for an account with no agents', async () => {
    const res = await fetch(`${baseUrl}/crew/graph`, {
      headers: { 'x-user': 'empty' },
    });
    expect(await res.json()).toEqual({ agents: [], edges: [], projects: [] });
  });

  it('cannot create a notification for another owner', async () => {
    const res = await request('/notifications', 'POST', {
      type: 'info',
      title: 'fake',
      agent_id: 'theirs',
    });
    expect(res.status).toBe(404);
    expect(getNotifications()).toEqual([]);
  });

  it('assigns notifications without an agent to their creator', async () => {
    expect(
      (await request('/notifications', 'POST', { type: 'info', title: 'mine' }))
        .status,
    ).toBe(200);
    expect(getNotifications(50, false, 'me')).toHaveLength(1);
    expect(getNotifications(50, false, 'other')).toEqual([]);
  });

  it.each(['source_agent_id', 'target_agent_id', 'project_id'])(
    'rejects a foreign pipeline %s on create and update',
    async (field) => {
      const foreign = field === 'project_id' ? 'their-project' : 'theirs';
      const patch = { [field]: foreign };
      expect(
        (
          await request('/pipelines', 'POST', {
            name: 'bad',
            target_agent_id: 'mine',
            ...patch,
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(`/pipelines/${pipelineId}`, 'PATCH', patch)).status,
      ).toBe(404);
      expect(getPipeline(pipelineId)?.target_agent_id).toBe('mine');
    },
  );

  it('allows an owner to create and update their own pipeline', async () => {
    expect(
      (
        await request('/pipelines', 'POST', {
          name: 'ok',
          target_agent_id: 'mine',
          source_agent_id: 'teammate',
          project_id: 'my-project',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(`/pipelines/${pipelineId}`, 'PATCH', {
          target_agent_id: 'teammate',
        })
      ).status,
    ).toBe(200);
    expect(getPipeline(pipelineId)?.target_agent_id).toBe('teammate');
  });

  it('a wildcard pipeline matches only cycles owned by its creator', () => {
    expect(
      getMatchingPipelines('mine', 'custom', 'completed').map((p) => p.id),
    ).toEqual([pipelineId]);
    expect(getMatchingPipelines('theirs', 'custom', 'completed')).toEqual([]);
    expect(getMatchingPipelines('missing', 'custom', 'completed')).toEqual([]);
  });

  it('rejects foreign references in existing pipelines at execution time too', async () => {
    updatePipeline(pipelineId, { target_agent_id: 'theirs' });
    expect(getMatchingPipelines('mine', 'custom', 'completed')).toEqual([]);
    expect(
      (await request(`/pipelines/${pipelineId}/fire`, 'POST')).status,
    ).toBe(404);
    updatePipeline(pipelineId, {
      target_agent_id: 'mine',
      project_id: 'their-project',
    });
    expect(
      getMatchingPipelines('mine', 'custom', 'completed', 'their-project'),
    ).toEqual([]);
    expect(
      (await request(`/pipelines/${pipelineId}/fire`, 'POST')).status,
    ).toBe(404);
  });

  it('protects the platform-wide tool registry from non-admin users', async () => {
    expect((await request('/tools')).status).toBe(403);
    expect((await request('/tools/job/tool/promote', 'POST')).status).toBe(403);
  });
});
