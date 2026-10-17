/**
 * A18 — a poisoned page cannot steer the boss into sending: once an agent has read worker
 * results, the owner's "don't ask" rules stop applying and the send waits for a person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ autoApproved: [] as string[] }));
vi.mock('../agents/agent-registry.js', () => ({
  agentService: {
    autoApproveCheckin: vi.fn(async (_a: string, id: string) => {
      h.autoApproved.push(id);
      return { ok: true, result: 'sent' };
    }),
  },
}));
vi.mock('../db.js', () => ({
  getUserById: vi.fn(() => ({ email: 'owner@example.com' })),
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import { autoApproveIfRuled } from '../agents/approval-apply.js';
import {
  markTaintedByWorkerData,
  isTaintedByWorkerData,
  noteCycleStart,
  noteCycleEnd,
  _resetTaint,
} from './taint.js';

const agent = {
  id: 'boss-1',
  owner_id: 'u1',
  config: {
    approvalRules: [
      {
        id: 'r1',
        action: 'email',
        decision: 'auto',
        createdBy: 'owner',
        createdAt: '',
      },
    ],
  } as never,
};
const checkin = {
  id: 'ck-1',
  status: 'pending',
  action_type: 'smtp_send',
  action_payload: JSON.stringify({
    to: 'someone@evil.example',
    subject: 's',
    body: 'b',
  }),
};

beforeEach(() => {
  _resetTaint();
  h.autoApproved = [];
});

describe('taint', () => {
  it("auto-approves by the owner's rule when the agent has read no worker data", async () => {
    const r = await autoApproveIfRuled(agent, checkin);
    expect(r?.autoApproved).toBe(true);
    expect(h.autoApproved).toEqual(['ck-1']);
  });

  it('holds the same send for a person once the agent has read worker results', async () => {
    markTaintedByWorkerData('boss-1');
    const r = await autoApproveIfRuled(agent, checkin);
    expect(r).toBeNull();
    expect(h.autoApproved).toEqual([]);
  });

  it('expires, and is per agent', () => {
    const t0 = Date.parse('2026-09-29T10:00:00Z');
    markTaintedByWorkerData('boss-1', t0);
    expect(isTaintedByWorkerData('boss-1', t0 + 60_000)).toBe(true);
    expect(isTaintedByWorkerData('boss-2', t0 + 60_000)).toBe(false);
    expect(isTaintedByWorkerData('boss-1', t0 + 36 * 60_000)).toBe(false);
  });

  // Cycles have had no wall-clock limit since 2026-09-30, so "35 minutes" no longer
  // outlasts the cycle that read the results.
  it('lasts until the end of a cycle that read worker results, however long it runs', () => {
    const t0 = Date.parse('2026-09-30T10:00:00Z');
    noteCycleStart('boss-1', t0);
    markTaintedByWorkerData('boss-1', t0 + 5 * 60_000);
    expect(isTaintedByWorkerData('boss-1', t0 + 3 * 60 * 60_000)).toBe(true);
    noteCycleEnd('boss-1');
    expect(isTaintedByWorkerData('boss-1', t0 + 3 * 60 * 60_000)).toBe(false);
  });

  it('covers a whole cycle woken while the agent was tainted', () => {
    const t0 = Date.parse('2026-09-30T10:00:00Z');
    markTaintedByWorkerData('boss-1', t0); // background run delivered, boss woken
    noteCycleStart('boss-1', t0 + 60_000); // the woken cycle starts
    expect(isTaintedByWorkerData('boss-1', t0 + 2 * 60 * 60_000)).toBe(true);
    noteCycleEnd('boss-1');
    expect(isTaintedByWorkerData('boss-1', t0 + 2 * 60 * 60_000)).toBe(false);
  });

  it('does not taint a cycle that started clean and read nothing', () => {
    const t0 = Date.parse('2026-09-30T10:00:00Z');
    markTaintedByWorkerData('boss-1', t0);
    noteCycleStart('boss-1', t0 + 40 * 60_000); // window already closed
    expect(isTaintedByWorkerData('boss-1', t0 + 41 * 60_000)).toBe(false);
    noteCycleEnd('boss-1');
  });
});
