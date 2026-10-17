import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import {
  _initTestDatabase,
  createUser,
  createAgent,
  createToolApproval,
  getToolApproval,
  getPendingToolApprovals,
  getPendingToolApprovalsByOwner,
  decideToolApproval,
  expireToolApproval,
  TOOL_APPROVAL_TTL_MS,
} from './db.js';
import type { Agent } from './types.js';

beforeEach(() => {
  _initTestDatabase();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeOwner(id: string) {
  createUser({
    id,
    email: `${id}@test.local`,
    password_hash: 'x',
    created_at: new Date().toISOString(),
  });
  return id;
}

function makeAgent(ownerId: string | null) {
  return createAgent({
    name: 'Ops',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: ownerId,
  });
}

function pending(agentId: string, tool = 'gmail_send') {
  return createToolApproval({
    agent_id: agentId,
    tool,
    reason: `${tool} acts outside the workspace`,
  });
}

describe('tool approvals', () => {
  it('starts pending and carries the context a human needs', () => {
    const agent = makeAgent(makeOwner('o1'));
    const approval = createToolApproval({
      agent_id: agent.id,
      tool: 'gmail_send',
      args_preview: '{"to":"client@corp.test"}',
      reason: 'gmail_send acts outside the workspace',
      cycle_id: 'cycle_1',
    });
    expect(approval.status).toBe('pending');
    expect(approval.tool).toBe('gmail_send');
    expect(approval.args_preview).toContain('client@corp.test');
    expect(approval.cycle_id).toBe('cycle_1');
  });

  it('records an approval decision with who made it', () => {
    const owner = makeOwner('o2');
    const approval = pending(makeAgent(owner).id);
    const decided = decideToolApproval(
      approval.id,
      'approved',
      owner,
      'go ahead',
    );
    expect(decided?.status).toBe('approved');
    expect(decided?.decided_by).toBe(owner);
    expect(decided?.note).toBe('go ahead');
    expect(decided?.decided_at).toBeTruthy();
  });

  it('refuses a second decision so a late click cannot reopen a settled call', () => {
    const owner = makeOwner('o3');
    const approval = pending(makeAgent(owner).id);
    expect(decideToolApproval(approval.id, 'denied', owner)).toBeTruthy();
    expect(decideToolApproval(approval.id, 'approved', owner)).toBeUndefined();
    expect(getToolApproval(approval.id)?.status).toBe('denied');
  });

  it('cannot approve something that already expired', () => {
    const owner = makeOwner('o4');
    const approval = pending(makeAgent(owner).id);
    expireToolApproval(approval.id);
    expect(decideToolApproval(approval.id, 'approved', owner)).toBeUndefined();
    expect(getToolApproval(approval.id)?.status).toBe('expired');
  });

  it('lapses to expired once the TTL passes, without a sweeper', () => {
    vi.useFakeTimers();
    const approval = pending(makeAgent(makeOwner('o5')).id);
    expect(getToolApproval(approval.id)?.status).toBe('pending');
    vi.setSystemTime(Date.now() + TOOL_APPROVAL_TTL_MS + 1000);
    expect(getToolApproval(approval.id)?.status).toBe('expired');
  });

  it('drops lapsed rows out of the pending list', () => {
    vi.useFakeTimers();
    const agent = makeAgent(makeOwner('o6'));
    pending(agent.id, 'gmail_send');
    expect(getPendingToolApprovals(agent.id)).toHaveLength(1);
    vi.setSystemTime(Date.now() + TOOL_APPROVAL_TTL_MS + 1000);
    expect(getPendingToolApprovals(agent.id)).toHaveLength(0);
  });

  it('returns undefined for an approval that does not exist', () => {
    expect(getToolApproval('missing')).toBeUndefined();
  });

  it('scopes the owner inbox so one client never sees another', () => {
    const a = makeOwner('owner_a');
    const b = makeOwner('owner_b');
    pending(makeAgent(a).id, 'gmail_send');
    pending(makeAgent(b).id, 'http_request');

    const inboxA = getPendingToolApprovalsByOwner(a);
    expect(inboxA).toHaveLength(1);
    expect(inboxA[0]!.tool).toBe('gmail_send');

    const inboxB = getPendingToolApprovalsByOwner(b);
    expect(inboxB).toHaveLength(1);
    expect(inboxB[0]!.tool).toBe('http_request');
  });

  it('keeps an ownerless agent out of every inbox', () => {
    const owner = makeOwner('o7');
    pending(makeAgent(null).id);
    expect(getPendingToolApprovalsByOwner(owner)).toHaveLength(0);
  });

  it('orders the inbox oldest first so the longest-blocked call is answered first', () => {
    const owner = makeOwner('o8');
    const agent = makeAgent(owner);
    const first = createToolApproval({
      agent_id: agent.id,
      tool: 'gmail_send',
      reason: 'r',
    });
    const second = createToolApproval({
      agent_id: agent.id,
      tool: 'http_request',
      reason: 'r',
    });
    const inbox = getPendingToolApprovalsByOwner(owner);
    expect(inbox.map((a) => a.id)).toEqual([first.id, second.id]);
  });
});
