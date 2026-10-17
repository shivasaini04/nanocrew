/**
 * Stage 57 phase 5 — a held run's plan is an ordinary approval: Approve starts the run,
 * Reject cancels it (single or batch), and a comment does neither.
 */
import os from 'os';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  approved: [] as string[],
  rejected: [] as Array<[string, string]>,
}));
vi.mock('../swarm/service.js', () => ({
  getSwarmEngine: () => ({
    approvePlan: (id: string) => {
      h.approved.push(id);
      return true;
    },
    rejectPlan: (id: string, note: string) => {
      h.rejected.push([id, note]);
      return true;
    },
  }),
}));
vi.mock('../notifications.js', async (orig) => ({
  ...(await orig<any>()),
  notify: vi.fn(),
}));

import { _initTestDatabase, createAgentCheckin } from '../db.js';
import { AgentService, type CycleRunner } from './agent-service.js';

const runner: CycleRunner = {
  run: vi.fn(async () => ({ summary: 'ok', cost: 0, tasksDone: 1 })),
};
let svc: AgentService;
let agentId: string;

function planCheckin(runId: string) {
  return createAgentCheckin({
    agent_id: agentId,
    status: 'pending',
    report_md: '## Run plan',
    action_type: 'run_plan',
    action_payload: JSON.stringify({ runId, goal: 'g', budget_usd: 3 }),
    created_at: new Date().toISOString(),
  } as Parameters<typeof createAgentCheckin>[0]).id;
}

beforeEach(async () => {
  _initTestDatabase();
  h.approved = [];
  h.rejected = [];
  svc = new AgentService(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-plan-')),
    runner,
  );
  agentId = (
    await svc.createAgent({
      name: 'Boss',
      type: 'lead_hunter',
      config: {
        schedule: [],
        budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
        tools: [],
        goals: 'g',
        escalationRules: [],
      } as never,
    })
  ).id;
});

describe('run plan approvals', () => {
  it('Approve starts the run', async () => {
    await svc.processFeedback(agentId, planCheckin('run-a'), 'approve');
    expect(h.approved).toEqual(['run-a']);
    expect(h.rejected).toEqual([]);
  });

  it("Reject cancels it, with the owner's reason", async () => {
    await svc.processFeedback(
      agentId,
      planCheckin('run-b'),
      'reject: too expensive for now',
    );
    expect(h.rejected).toEqual([['run-b', 'too expensive for now']]);
    expect(h.approved).toEqual([]);
  });

  it('a comment neither starts nor cancels it', async () => {
    await svc.processFeedback(
      agentId,
      planCheckin('run-c'),
      'what would the third task find?',
    );
    expect(h.approved).toEqual([]);
    expect(h.rejected).toEqual([]);
  });
});
