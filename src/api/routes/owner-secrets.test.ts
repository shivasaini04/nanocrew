/**
 * Stage 51 gap 2 — the owner is the session user, never the request body, so one
 * customer cannot read or write another's namespace.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'http';

const store = new Map<string, string>();
const prefix = (s: { ownerId: string }) => `owner:${s.ownerId}:`;

vi.mock('../../agents/secrets-manager.js', () => ({
  secretsManager: {
    set: (scope: { ownerId: string }, name: string, value: string) => {
      store.set(prefix(scope) + name, value);
    },
    delete: (scope: { ownerId: string }, name: string) => {
      store.delete(prefix(scope) + name);
    },
    list: (scope: { ownerId: string }) =>
      [...store.keys()]
        .filter((k) => k.startsWith(prefix(scope)))
        .map((k) => ({
          name: k.slice(prefix(scope).length),
          masked: '••••',
          createdAt: '',
        })),
  },
}));

import { ownerSecretsRouter } from './owner-secrets.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for attachUser: the user comes from a header, as the cookie would supply it.
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    if (id) (req as any).user = { id: String(id) };
    next();
  });
  app.use('/api/owner-secrets', ownerSecretsRouter);
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as any).port}/api/owner-secrets`;
});
afterAll(() => {
  server?.close();
});

const call = (method: string, user: string | null, path = '', body?: unknown) =>
  fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(user ? { 'x-test-user': user } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

describe('owner secrets route', () => {
  it('refuses a caller who is not signed in', async () => {
    expect((await call('GET', null)).status).toBe(401);
    expect(
      (await call('POST', null, '', { name: 'X', value: 'y' })).status,
    ).toBe(401);
  });

  it('stores under the session user and lists names only', async () => {
    const res = await call('POST', 'alice', '', {
      name: 'LINKEDIN_PASSWORD',
      value: 'hunter2',
    });
    expect(res.status).toBe(200);
    const list = (await (await call('GET', 'alice')).json()) as any[];
    expect(list.map((s) => s.name)).toEqual(['LINKEDIN_PASSWORD']);
    expect(JSON.stringify(list)).not.toContain('hunter2');
  });

  it("cannot see or delete another user's secrets, and a body ownerId is ignored", async () => {
    await call('POST', 'alice', '', { name: 'A_KEY', value: 'v' });
    expect((await (await call('GET', 'bob')).json()) as any[]).toEqual([]);
    await call('POST', 'bob', '', {
      name: 'B_KEY',
      value: 'v',
      ownerId: 'alice',
    });
    expect(
      ((await (await call('GET', 'alice')).json()) as any[]).map(
        (s: any) => s.name,
      ),
    ).not.toContain('B_KEY');
    await call('DELETE', 'bob', '/A_KEY');
    expect(
      ((await (await call('GET', 'alice')).json()) as any[]).map(
        (s: any) => s.name,
      ),
    ).toContain('A_KEY');
  });
});
