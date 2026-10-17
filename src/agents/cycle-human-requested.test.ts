import { beforeEach, describe, expect, it } from 'vitest';
import {
  _initTestDatabase,
  createAgent,
  createAgentCycle,
  getAgentCycleById,
} from '../db.js';

// Crawler 2026-09-11: self-heal retried a manual Round 2 and the retry was treated as a
// scheduled run — rotation said "this cycle is assigned to linkedin_jobs" and cooldowns
// refused both listing endpoints. The flag has to live on the cycle row for a retry to read.
describe('agent_cycles.human_requested', () => {
  let base: Parameters<typeof createAgentCycle>[0];
  beforeEach(() => {
    _initTestDatabase();
    const agent = createAgent({
      name: 'Crawler',
      type: 'lead_hunter',
      emoji: '🔍',
      status: 'idle',
      workspace: '/data/agents/t',
      identity_version: 1,
      config: {
        schedule: [],
        budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
        tools: [],
        goals: '',
        escalationRules: [],
      } as never,
    });
    base = {
      agent_id: agent.id,
      cycle_type: 'custom',
      status: 'running',
      started_at: '2026-09-11T00:00:00Z',
      cost: 0,
      tasks_done: 0,
    };
  });

  it('is stored for a cycle a person asked for', () => {
    const c = createAgentCycle({ ...base, human_requested: true });
    expect(getAgentCycleById(c.id)?.human_requested).toBe(1);
  });

  it('defaults to not requested', () => {
    const c = createAgentCycle({ ...base });
    expect(getAgentCycleById(c.id)?.human_requested).toBe(0);
  });
});
