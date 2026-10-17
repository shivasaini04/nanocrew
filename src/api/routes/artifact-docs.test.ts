/**
 * Stage 58 — what an agent's HTML page remembers is keyed by the FILE, so it is the same
 * page wherever the owner opens it. The first design keyed it to a separately approved
 * copy, and the file the owner actually opened had nowhere to save (reset on reload).
 *
 * requireAuth lives in server.ts, so this stands a minimal substitute that sets req.user
 * from a header — the router's own ownership check is what's under test.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'http';

import {
  _initTestDatabase,
  createAgent,
  createUser,
  deleteAgent,
  upsertArtifactDoc,
  listArtifactDocs,
} from '../../db.js';
import { artifactDocsRouter, normaliseArtifactPath } from './artifact-docs.js';
import type { Agent } from '../../types.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    const uid = req.header('x-test-user');
    if (uid) (req as any).user = { id: uid };
    next();
  });
  app.use('/api', artifactDocsRouter);
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
  _initTestDatabase();
});

function setup() {
  createUser({
    id: 'owner',
    email: 'owner@test.local',
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  createUser({
    id: 'stranger',
    email: 'stranger@test.local',
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  return createAgent({
    name: 'Mechanic',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: 'owner',
  });
}

const headers = (user: string | null) => ({
  'content-type': 'application/json',
  ...(user ? { 'x-test-user': user } : {}),
});

const url = (agentId: string, path: string, doc?: string) =>
  `${baseUrl}/api/agents/${agentId}/artifact-docs${doc ? `/${doc}` : ''}?path=${encodeURIComponent(path)}`;

describe('normaliseArtifactPath', () => {
  it('maps the three ways the same file is named to one key', () => {
    // a write_file step, the emit_artifact manifest, and the files API
    expect(
      normaliseArtifactPath('/workspace/group/workspace/checklist.html'),
    ).toBe('checklist.html');
    expect(normaliseArtifactPath('workspace/checklist.html')).toBe(
      'checklist.html',
    );
    expect(normaliseArtifactPath('checklist.html')).toBe('checklist.html');
    expect(normaliseArtifactPath('reports/q3.html')).toBe('reports/q3.html');
  });

  it('refuses a path that climbs out, and a missing one', () => {
    expect(normaliseArtifactPath('../other-agent/x.html')).toBeNull();
    expect(normaliseArtifactPath('')).toBeNull();
    expect(normaliseArtifactPath(undefined)).toBeNull();
  });
});

describe('artifact docs', () => {
  it('a tick saved from one place is there when the page is opened from another', async () => {
    const agent = setup();
    const put = await fetch(
      url(
        agent.id,
        '/workspace/group/workspace/checklist.html',
        'tire-pressure',
      ),
      {
        method: 'PUT',
        headers: headers('owner'),
        body: JSON.stringify({ data: { checked: true } }),
      },
    );
    expect(put.status).toBe(200);

    const list = (await (
      await fetch(url(agent.id, 'checklist.html'), {
        headers: headers('owner'),
      })
    ).json()) as any;
    expect(list.docs).toEqual([
      {
        id: 'tire-pressure',
        data: { checked: true },
        updatedAt: expect.any(String),
      },
    ]);
  });

  it('two different files keep separate state', async () => {
    const agent = setup();
    await fetch(url(agent.id, 'a.html', 'x'), {
      method: 'PUT',
      headers: headers('owner'),
      body: JSON.stringify({ data: 1 }),
    });
    const other = (await (
      await fetch(url(agent.id, 'b.html'), { headers: headers('owner') })
    ).json()) as any;
    expect(other.docs).toEqual([]);
  });

  it('a doc never written reads as null, not an error', async () => {
    const agent = setup();
    const res = await fetch(url(agent.id, 'a.html', 'nope'), {
      headers: headers('owner'),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data).toBeNull();
  });

  it('delete removes one doc', async () => {
    const agent = setup();
    await fetch(url(agent.id, 'a.html', 'x'), {
      method: 'PUT',
      headers: headers('owner'),
      body: JSON.stringify({ data: 1 }),
    });
    await fetch(url(agent.id, 'a.html', 'x'), {
      method: 'DELETE',
      headers: headers('owner'),
    });
    const list = (await (
      await fetch(url(agent.id, 'a.html'), { headers: headers('owner') })
    ).json()) as any;
    expect(list.docs).toEqual([]);
  });

  it('someone else gets 404 for reads and writes — never confirms the agent exists', async () => {
    const agent = setup();
    expect(
      (await fetch(url(agent.id, 'a.html'), { headers: headers('stranger') }))
        .status,
    ).toBe(404);
    expect(
      (
        await fetch(url(agent.id, 'a.html', 'x'), {
          method: 'PUT',
          headers: headers('stranger'),
          body: JSON.stringify({ data: 1 }),
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(url(agent.id, 'a.html'), { headers: headers(null) })).status,
    ).toBe(404);
  });

  it('a request without a file path is refused', async () => {
    const agent = setup();
    const res = await fetch(`${baseUrl}/api/agents/${agent.id}/artifact-docs`, {
      headers: headers('owner'),
    });
    expect(res.status).toBe(400);
  });

  it('refuses an oversized document', async () => {
    const agent = setup();
    const res = await fetch(url(agent.id, 'a.html', 'big'), {
      method: 'PUT',
      headers: headers('owner'),
      body: JSON.stringify({ data: 'x'.repeat(300 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});

describe('deleting an agent', () => {
  it('still works when its pages have saved state (artifact_docs references agents)', () => {
    const agent = setup();
    upsertArtifactDoc(agent.id, 'a.html', 'x', '1');
    expect(() => deleteAgent(agent.id)).not.toThrow();
    expect(listArtifactDocs(agent.id, 'a.html')).toEqual([]);
  });
});
