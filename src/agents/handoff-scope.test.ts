/**
 * The recent-handoffs feed is per account.
 *
 * Found 2026-10-18 from a fresh test account on prod: GET /api/agents/handoffs/recent ran
 * `SELECT * FROM agent_handoffs` with no owner filter, so 49 of the 50 rows it returned
 * belonged to other customers' agents, payloads included. The route now passes the
 * caller's own agent ids; these tests hold the query to that.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertAgent,
  createHandoff,
  getRecentHandoffs,
} from '../db.js';
import type { AgentConfig } from '../types.js';

function agent(id: string, owner: string) {
  insertAgent({
    id,
    name: id,
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    owner_id: owner,
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'g',
      escalationRules: [],
    } as AgentConfig,
  });
}

function handoff(from: string, to: string, note: string) {
  return createHandoff({
    from_agent_id: from,
    to_agent_id: to,
    type: 'request',
    payload: JSON.stringify({ summary: note }),
    note,
    status: 'pending',
    performative: 'request',
  });
}

beforeEach(() => {
  _initTestDatabase();
  agent('a-research', 'owner-a');
  agent('a-content', 'owner-a');
  agent('b-scout', 'owner-b');
  agent('b-herald', 'owner-b');
  handoff('a-research', 'a-content', 'mine');
  handoff('b-scout', 'b-herald', 'theirs');
  handoff('b-herald', 'b-scout', 'theirs too');
});

describe('getRecentHandoffs', () => {
  it('returns only handoffs that touch the given agents', () => {
    const rows = getRecentHandoffs(['a-research', 'a-content']);
    expect(rows.map((r) => r.note)).toEqual(['mine']);
  });

  it('matches on either side of the handoff', () => {
    expect(getRecentHandoffs(['a-content'])).toHaveLength(1);
    expect(getRecentHandoffs(['b-scout'])).toHaveLength(2);
  });

  it('returns nothing for a caller with no agents, not everything', () => {
    expect(getRecentHandoffs([])).toEqual([]);
  });

  it('still honours the limit', () => {
    expect(getRecentHandoffs(['b-scout', 'b-herald'], 1)).toHaveLength(1);
  });
});
