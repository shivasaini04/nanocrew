import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createUser,
  createAgent,
  getUserSecurityPosture,
  setUserSecurityPosture,
  getAgentSecurityPosture,
  SELECTABLE_SECURITY_POSTURES,
} from './db.js';
import type { Agent } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

function makeUser(id: string) {
  createUser({
    id,
    email: `${id}@test.local`,
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  return id;
}

function agentFields() {
  return {
    name: 'Ops',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
  };
}

describe('security posture', () => {
  it('defaults to auto for a user who never chose one', () => {
    const id = makeUser('u1');
    expect(getUserSecurityPosture(id)).toBe('auto');
  });

  it('defaults to auto for a user that does not exist', () => {
    expect(getUserSecurityPosture('nobody')).toBe('auto');
  });

  it('round-trips a selected posture', () => {
    const id = makeUser('u2');
    setUserSecurityPosture(id, 'dangerous');
    expect(getUserSecurityPosture(id)).toBe('dangerous');
    setUserSecurityPosture(id, 'auto');
    expect(getUserSecurityPosture(id)).toBe('auto');
  });

  it('offers all three postures now that strict routes to a human', () => {
    expect(SELECTABLE_SECURITY_POSTURES).toEqual([
      'strict',
      'auto',
      'dangerous',
    ]);
  });

  it('round-trips strict', () => {
    const id = makeUser('u5');
    setUserSecurityPosture(id, 'strict');
    expect(getUserSecurityPosture(id)).toBe('strict');
  });

  it('falls back to auto when the stored value is unrecognised', () => {
    const id = makeUser('u3');
    setUserSecurityPosture(id, 'nonsense' as 'auto');
    expect(getUserSecurityPosture(id)).toBe('auto');
  });

  it('resolves an agent posture through its owner', () => {
    const id = makeUser('u4');
    setUserSecurityPosture(id, 'dangerous');
    const agent = createAgent({ ...agentFields(), owner_id: id });
    expect(getAgentSecurityPosture(agent.id)).toBe('dangerous');
  });

  it('falls back to auto for an ownerless agent', () => {
    const agent = createAgent({ ...agentFields(), owner_id: null });
    expect(getAgentSecurityPosture(agent.id)).toBe('auto');
  });

  it('falls back to auto for an agent that does not exist', () => {
    expect(getAgentSecurityPosture('missing')).toBe('auto');
  });
});
