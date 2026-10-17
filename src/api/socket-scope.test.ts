/**
 * Socket scoping — which user's room a broadcast is delivered to.
 *
 * This module's fallback is "underivable → admins only", which is the right security
 * default but makes a missing case FAIL SILENTLY: the event still emits, no error is
 * logged, and only non-admin clients notice — by never receiving live updates. That's
 * exactly how `conversation:event` shipped broken to prod while working perfectly for
 * the admin who tested it.
 *
 * So every event family the app broadcasts gets a case here, and each asserts the
 * OWNER — not merely "not null" — because routing to the wrong user's room would be a
 * cross-tenant leak.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ownerForEvent } from './socket-scope.js';
import {
  _initTestDatabase,
  createAgent,
  createProject,
  setAgentOwner,
  setRowOwner,
} from '../db.js';
import type { AgentConfig } from '../types.js';

const config: AgentConfig = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'g',
  escalationRules: [],
};

let agentId: string;
let projectId: string;
const OWNER = 'user-owner-1';

beforeEach(() => {
  _initTestDatabase();
  const agent = createAgent({
    name: 'A',
    type: 'custom',
    emoji: '🤖',
    status: 'idle',
    workspace: '/w',
    config,
    identity_version: 1,
  });
  agentId = agent.id;
  setAgentOwner(agentId, OWNER);

  projectId = 'proj_1';
  createProject({
    id: projectId,
    name: 'P',
    chat_jid: `project:${projectId}`,
    status: 'active',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  setRowOwner('projects', projectId, OWNER);
});

describe('ownerForEvent — conversation:event (Stage 35)', () => {
  it('routes an agent conversation to the agent OWNER, not to admins', () => {
    // The bug: with no `conversation:` case this returned null, so the emit went to
    // the admins room and every non-admin client saw nothing live — their chat only
    // appeared on reload, via REST.
    expect(
      ownerForEvent('conversation:event', {
        conversation: `agent:${agentId}`,
        seq: 1,
      }),
    ).toBe(OWNER);
  });

  it('routes a project conversation to the project owner', () => {
    expect(
      ownerForEvent('conversation:event', {
        conversation: `project:${projectId}`,
        seq: 1,
      }),
    ).toBe(OWNER);
  });

  it('falls back to operator-only for an unknown conversation, never a broadcast', () => {
    expect(
      ownerForEvent('conversation:event', {
        conversation: 'agent:does-not-exist',
      }),
    ).toBeNull();
    expect(
      ownerForEvent('conversation:event', { conversation: 'dash:default' }),
    ).toBeNull();
    expect(ownerForEvent('conversation:event', {})).toBeNull();
  });
});

describe('ownerForEvent — the other event families still resolve', () => {
  it('agent:* by agentId', () => {
    expect(ownerForEvent('agent:status_changed', { agentId })).toBe(OWNER);
  });

  it('chat:* by chatJid, agent and project', () => {
    expect(ownerForEvent('chat:message', { chatJid: `agent:${agentId}` })).toBe(
      OWNER,
    );
    expect(
      ownerForEvent('chat:activity', { chatJid: `project:${projectId}` }),
    ).toBe(OWNER);
  });

  it('project:* by projectId', () => {
    expect(ownerForEvent('project:opened', { projectId })).toBe(OWNER);
  });

  it('infra events stay operator-only', () => {
    expect(ownerForEvent('container_stats', {})).toBeNull();
    expect(ownerForEvent('worker:log:relay', {})).toBeNull();
  });

  it('never throws on a malformed payload — a bad emit must not take the server down', () => {
    expect(() => ownerForEvent('conversation:event', null)).not.toThrow();
    expect(() => ownerForEvent('agent:x', { agentId: 42 })).not.toThrow();
  });
});
