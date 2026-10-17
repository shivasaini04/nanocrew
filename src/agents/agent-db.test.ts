/**
 * Milestone 1.1 — Agent Registry DB
 * Tests all 5 tables and their helper functions using the in-memory test DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  createAgent,
  getAgent,
  getAllAgents,
  updateAgentStatus,
  updateAgentLastActive,
  updateAgentConfig,
  deleteAgent,
  createAgentCycle,
  updateAgentCycle,
  getCyclesByAgent,
  getAgentCycleById,
  createAgentMemory,
  getMemoryByAgent,
  deleteAgentMemory,
  incrementMemoryUsed,
  createAgentCheckin,
  getCheckinsByAgent,
  getPendingCheckins,
  updateAgentCheckin,
  logAgentFileEvent,
  getFileEventsByCycle,
  markEpisodesDistilled,
  queueFastlane,
  insertConversationEvent,
  getConversationEvents,
  _rawDb,
  deleteUserAccount,
  createUser,
  getUserById,
  setAgentOwner,
} from '../db.js';
import type { AgentConfig } from '../types.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const defaultConfig: AgentConfig = {
  schedule: [{ type: 'lead_search', interval: '4h', enabled: true }],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: ['apollo'],
  goals: 'Find qualified SaaS leads',
  escalationRules: [],
};

function makeAgent() {
  return createAgent({
    name: 'Lead Hunter',
    type: 'lead_hunter',
    emoji: '🔍',
    status: 'idle',
    workspace: '/data/agents/test-001',
    config: defaultConfig,
    identity_version: 1,
  });
}

// ─── setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  _initTestDatabase();
});

// ─── agents table ────────────────────────────────────────────────────────────

describe('agents table', () => {
  it('createAgent returns a full Agent with id and created_at', () => {
    const agent = makeAgent();
    expect(agent.id).toBeTruthy();
    expect(agent.created_at).toBeTruthy();
    expect(agent.name).toBe('Lead Hunter');
    expect(agent.type).toBe('lead_hunter');
    expect(agent.status).toBe('idle');
  });

  it('getAgent returns the agent with config parsed from JSON', () => {
    const created = makeAgent();
    const fetched = getAgent(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.config.goals).toBe('Find qualified SaaS leads');
    expect(fetched!.config.budget.daily).toBe(5);
  });

  it('getAgent returns null for unknown id', () => {
    expect(getAgent('no-such-id')).toBeNull();
  });

  it('getAllAgents returns all created agents', () => {
    makeAgent();
    makeAgent();
    const all = getAllAgents();
    expect(all.length).toBe(2);
    // config JSON-parsed for all rows
    expect(all[0].config.goals).toBe('Find qualified SaaS leads');
  });

  it('updateAgentStatus changes status in DB', () => {
    const agent = makeAgent();
    updateAgentStatus(agent.id, 'running');
    expect(getAgent(agent.id)!.status).toBe('running');
  });

  it('updateAgentLastActive sets a non-null timestamp', () => {
    const agent = makeAgent();
    updateAgentLastActive(agent.id);
    const updated = getAgent(agent.id)!;
    expect(updated.last_active).toBeTruthy();
  });

  it('updateAgentConfig persists config changes', () => {
    const agent = makeAgent();
    const newConfig = { ...defaultConfig, goals: 'Updated goal' };
    updateAgentConfig(agent.id, newConfig);
    expect(getAgent(agent.id)!.config.goals).toBe('Updated goal');
  });

  it('deleteAgent cascades through all child tables', () => {
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0.1,
      tasks_done: 1,
    });
    createAgentMemory({
      agent_id: agent.id,
      type: 'lesson',
      content: 'test',
      relevance: 1,
      used_count: 0,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'create',
      file_path: 'leads/new.csv',
    });

    deleteAgent(agent.id);

    expect(getAgent(agent.id)).toBeNull();
    expect(getCyclesByAgent(agent.id)).toHaveLength(0);
    expect(getMemoryByAgent(agent.id)).toHaveLength(0);
    expect(getFileEventsByCycle(cycle.id)).toHaveLength(0);
  });

  it('deletes an agent that has rows in EVERY table referencing agents(id)', () => {
    // This test's older sibling above is named "cascades through all child tables" and
    // passes while covering only four of them — which is exactly how deletion stayed
    // broken. agent_episode_ledger arrived with Stage 34 and deleteAgent was never
    // updated, so deleting any agent that had ever run a cycle failed with
    // "FOREIGN KEY constraint failed".
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0.1,
      tasks_done: 1,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'create',
      file_path: 'a.csv',
    });
    createAgentMemory({
      agent_id: agent.id,
      type: 'lesson',
      content: 'x',
      relevance: 1,
      used_count: 0,
    });
    createAgentCheckin({
      agent_id: agent.id,
      status: 'pending',
      report_md: 'r',
    });
    markEpisodesDistilled(agent.id, ['2026-01-01']); // the ledger that blocked it
    queueFastlane(agent.id, 'failure');
    insertConversationEvent(`agent:${agent.id}`, {
      type: 'agent_msg',
      content: 'hi',
    });

    expect(() => deleteAgent(agent.id)).not.toThrow();
    expect(getAgent(agent.id)).toBeNull();
    // The agent's conversation log goes with it — no FK made it block, so it used to
    // linger forever after the agent was gone.
    expect(getConversationEvents(`agent:${agent.id}`)).toHaveLength(0);
  });

  it('deleteUserAccount removes a client whose agents have actually run', () => {
    // Same gap as deleteAgent, but it failed worse: the DELETE FROM agents was wrapped
    // in a silent catch, so an FK error was swallowed AFTER every child row had already
    // gone, the transaction committed, and the account delete returned ok — leaving an
    // orphaned agent stripped of its history. This is the documented "delete an account
    // entirely" admin action.
    const userId = 'user-to-delete';
    createUser({
      id: userId,
      email: 'gone@example.com',
      password_hash: 'hash',
      role: 'user',
      created_at: new Date().toISOString(),
    });
    const agent = makeAgent();
    setAgentOwner(agent.id, userId);
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0.1,
      tasks_done: 1,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'create',
      file_path: 'a.csv',
    });
    markEpisodesDistilled(agent.id, ['2026-01-01']); // the row that used to break it
    queueFastlane(agent.id, 'failure');
    insertConversationEvent(`agent:${agent.id}`, {
      type: 'agent_msg',
      content: 'hi',
    });

    const deleted = deleteUserAccount(userId);

    expect(deleted).toContain(agent.id);
    expect(getAgent(agent.id)).toBeNull(); // not orphaned
    expect(getUserById(userId)).toBeFalsy();
    expect(getConversationEvents(`agent:${agent.id}`)).toHaveLength(0);
  });

  it('is atomic — a failed delete destroys nothing', () => {
    // The bug that did real damage: five independent statements meant the first four
    // committed and only the last one failed, gutting the agent's history while
    // leaving the agent row behind — and reporting only "FOREIGN KEY constraint
    // failed", which reads like nothing happened.
    const agent = makeAgent();
    createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0.1,
      tasks_done: 1,
    });
    createAgentMemory({
      agent_id: agent.id,
      type: 'lesson',
      content: 'keep me',
      relevance: 1,
      used_count: 0,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: getCyclesByAgent(agent.id)[0].id,
      event_type: 'create',
      file_path: 'a.csv',
    });

    // Simulate the failure mode itself: a child table referencing agents(id) that
    // deleteAgent doesn't know to clean — which is precisely what agent_episode_ledger
    // was. The final DELETE FROM agents must fail.
    _rawDb().exec(
      'CREATE TABLE IF NOT EXISTS _fk_probe (agent_id TEXT NOT NULL REFERENCES agents(id))',
    );
    _rawDb()
      .prepare('INSERT INTO _fk_probe (agent_id) VALUES (?)')
      .run(agent.id);

    expect(() => deleteAgent(agent.id)).toThrow();

    // Everything survives the failure — the whole point of the transaction. Before it,
    // these three assertions all returned 0 while the agent itself stayed behind.
    expect(getAgent(agent.id)).not.toBeNull();
    expect(getCyclesByAgent(agent.id)).toHaveLength(1);
    expect(getMemoryByAgent(agent.id)).toHaveLength(1);
    expect(getFileEventsByCycle(getCyclesByAgent(agent.id)[0].id)).toHaveLength(
      1,
    );
  });
});

// ─── agent_cycles table ──────────────────────────────────────────────────────

describe('agent_cycles table', () => {
  it('createAgentCycle returns a cycle with id', () => {
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });
    expect(cycle.id).toBeTruthy();
    expect(cycle.cycle_type).toBe('lead_search');
  });

  it('getCyclesByAgent returns cycles in descending started_at order', () => {
    const agent = makeAgent();
    createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: '2026-01-01T00:00:00.000Z',
      cost: 0.05,
      tasks_done: 3,
    });
    createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'send_outreach',
      status: 'completed',
      started_at: '2026-01-02T00:00:00.000Z',
      cost: 0.1,
      tasks_done: 5,
    });
    const cycles = getCyclesByAgent(agent.id);
    expect(cycles).toHaveLength(2);
    expect(cycles[0].cycle_type).toBe('send_outreach'); // newer first
  });

  it('updateAgentCycle updates status and cost fields', () => {
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'checkin',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });

    const ended = new Date().toISOString();
    updateAgentCycle(cycle.id, {
      status: 'completed',
      ended_at: ended,
      summary: 'Found 3 leads',
      cost: 0.12,
      tasks_done: 3,
    });

    const updated = getAgentCycleById(cycle.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.cost).toBe(0.12);
    expect(updated.summary).toBe('Found 3 leads');
    expect(updated.ended_at).toBe(ended);
  });

  it('getCyclesByAgent respects limit', () => {
    const agent = makeAgent();
    for (let i = 0; i < 5; i++) {
      createAgentCycle({
        agent_id: agent.id,
        cycle_type: 'lead_search',
        status: 'completed',
        started_at: new Date().toISOString(),
        cost: 0.01,
        tasks_done: 1,
      });
    }
    expect(getCyclesByAgent(agent.id, 3)).toHaveLength(3);
  });
});

// ─── agent_memory table ──────────────────────────────────────────────────────

describe('agent_memory table', () => {
  it('createAgentMemory returns a memory entry with id and created_at', () => {
    const agent = makeAgent();
    const mem = createAgentMemory({
      agent_id: agent.id,
      type: 'lesson',
      content: 'Apollo filter saves 30% scoring time',
      relevance: 0.9,
      used_count: 0,
    });
    expect(mem.id).toBeTruthy();
    expect(mem.created_at).toBeTruthy();
    expect(mem.content).toBe('Apollo filter saves 30% scoring time');
  });

  it('getMemoryByAgent returns entries ordered by relevance DESC', () => {
    const agent = makeAgent();
    createAgentMemory({
      agent_id: agent.id,
      type: 'pattern',
      content: 'low',
      relevance: 0.2,
      used_count: 0,
    });
    createAgentMemory({
      agent_id: agent.id,
      type: 'pattern',
      content: 'high',
      relevance: 0.9,
      used_count: 0,
    });
    const all = getMemoryByAgent(agent.id);
    expect(all[0].content).toBe('high');
  });

  it('getMemoryByAgent filters by type', () => {
    const agent = makeAgent();
    createAgentMemory({
      agent_id: agent.id,
      type: 'lesson',
      content: 'L1',
      relevance: 1,
      used_count: 0,
    });
    createAgentMemory({
      agent_id: agent.id,
      type: 'failure',
      content: 'F1',
      relevance: 1,
      used_count: 0,
    });
    const lessons = getMemoryByAgent(agent.id, 'lesson');
    expect(lessons).toHaveLength(1);
    expect(lessons[0].content).toBe('L1');
  });

  it('deleteAgentMemory removes the entry', () => {
    const agent = makeAgent();
    const mem = createAgentMemory({
      agent_id: agent.id,
      type: 'win',
      content: 'Best lead ever',
      relevance: 1,
      used_count: 0,
    });
    deleteAgentMemory(mem.id);
    expect(getMemoryByAgent(agent.id)).toHaveLength(0);
  });

  it('incrementMemoryUsed increments used_count', () => {
    const agent = makeAgent();
    const mem = createAgentMemory({
      agent_id: agent.id,
      type: 'pattern',
      content: 'test',
      relevance: 1,
      used_count: 0,
    });
    incrementMemoryUsed(mem.id);
    incrementMemoryUsed(mem.id);
    const updated = getMemoryByAgent(agent.id)[0];
    expect(updated.used_count).toBe(2);
  });
});

// ─── agent_checkins table ────────────────────────────────────────────────────

describe('agent_checkins table', () => {
  it('createAgentCheckin returns a checkin with pending status', () => {
    const agent = makeAgent();
    const checkin = createAgentCheckin({
      agent_id: agent.id,
      status: 'pending',
      report_md: '# Weekly Report\n\nAll good.',
    });
    expect(checkin.id).toBeTruthy();
    expect(checkin.status).toBe('pending');
    expect(checkin.report_md).toContain('Weekly Report');
  });

  it('getCheckinsByAgent returns newest first', () => {
    const agent = makeAgent();
    createAgentCheckin({
      agent_id: agent.id,
      status: 'responded',
      report_md: 'old',
      created_at: '2026-03-10T09:00:00.000Z',
    });
    createAgentCheckin({
      agent_id: agent.id,
      status: 'pending',
      report_md: 'new',
      created_at: '2026-03-17T09:00:00.000Z',
    });
    const checkins = getCheckinsByAgent(agent.id);
    expect(checkins[0].report_md).toBe('new');
  });

  it('getPendingCheckins returns only pending across all agents', () => {
    const a1 = makeAgent();
    const a2 = makeAgent();
    createAgentCheckin({ agent_id: a1.id, status: 'pending' });
    createAgentCheckin({ agent_id: a1.id, status: 'responded' });
    createAgentCheckin({ agent_id: a2.id, status: 'pending' });
    expect(getPendingCheckins()).toHaveLength(2);
  });

  it('updateAgentCheckin transitions pending → responded', () => {
    const agent = makeAgent();
    const checkin = createAgentCheckin({
      agent_id: agent.id,
      status: 'pending',
    });
    const now = new Date().toISOString();
    updateAgentCheckin(checkin.id, {
      status: 'responded',
      user_reply: 'Great work, keep going.',
      responded_at: now,
    });
    const updated = getCheckinsByAgent(agent.id)[0];
    expect(updated.status).toBe('responded');
    expect(updated.user_reply).toBe('Great work, keep going.');
    expect(updated.responded_at).toBe(now);
  });
});

// ─── agent_file_events table ─────────────────────────────────────────────────

describe('agent_file_events table', () => {
  it('logAgentFileEvent stores a create event', () => {
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'create',
      file_path: 'leads/pipeline.json',
      diff_patch: '+[{"company":"TechCorp"}]',
    });
    const events = getFileEventsByCycle(cycle.id);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('create');
    expect(events[0].file_path).toBe('leads/pipeline.json');
    expect(events[0].diff_patch).toContain('TechCorp');
  });

  it('getFileEventsByCycle returns events in ascending timestamp order', () => {
    const agent = makeAgent();
    const cycle = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'send_outreach',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'read',
      file_path: 'pipeline.json',
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'write',
      file_path: 'sent.jsonl',
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: cycle.id,
      event_type: 'delete',
      file_path: 'old.tmp',
    });

    const events = getFileEventsByCycle(cycle.id);
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event_type)).toEqual([
      'read',
      'write',
      'delete',
    ]);
  });

  it('events for one cycle do not appear in another cycle query', () => {
    const agent = makeAgent();
    const c1 = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'completed',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });
    const c2 = createAgentCycle({
      agent_id: agent.id,
      cycle_type: 'lead_search',
      status: 'running',
      started_at: new Date().toISOString(),
      cost: 0,
      tasks_done: 0,
    });
    logAgentFileEvent({
      agent_id: agent.id,
      cycle_id: c1.id,
      event_type: 'create',
      file_path: 'a.csv',
    });

    expect(getFileEventsByCycle(c1.id)).toHaveLength(1);
    expect(getFileEventsByCycle(c2.id)).toHaveLength(0);
  });
});
