/**
 * Durability of the effector's mid-cycle approval gate.
 *
 * The bug these cover: pending approvals lived only in an in-memory Map, so an
 * orchestrator restart mid-wait lost the request. The card stayed on screen with a
 * live countdown (the conversation event is in SQLite), its buttons 404'd against an
 * empty map, and the blocked agent polled until it gave up and denied.
 *
 * The safety property that must hold throughout: a decision the operator actually
 * made is never reported to the waiting agent as 'not_found', because 'not_found'
 * tells it to stop and treat the step as denied.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createAgent,
  insertEscalationApproval,
  decideEscalationApproval,
  getEscalationApproval,
  getPendingEscalationApprovals,
} from './db.js';
import type { Agent } from './types.js';

let AGENT_ID = '';

beforeEach(() => {
  _initTestDatabase();
  AGENT_ID = seedAgent();
});

function seedAgent(): string {
  return createAgent({
    name: 'Finder',
    type: 'custom' as const,
    status: 'idle' as const,
    workspace: '/workspace',
    config: {} as Agent['config'],
    identity_version: 1,
    owner_id: null,
  }).id;
}

function seedApproval(
  id: string,
  createdAt = new Date().toISOString(),
  timeoutMs = 30 * 60 * 1000,
) {
  insertEscalationApproval({
    id,
    agent_id: AGENT_ID,
    run_id: 'run-1',
    step: JSON.stringify({
      step: 0,
      action: 'click',
      target: 'Checkout',
      isDangerous: true,
    }),
    timeout_ms: timeoutMs,
    created_at: createdAt,
  });
}

describe('escalation approvals — durability', () => {
  it('survives a restart: a pending row is still readable by a fresh process', () => {
    seedApproval('ap1');

    // A restart is exactly this: the Map is gone, the table is not.
    const pending = getPendingEscalationApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe('ap1');
    expect(pending[0].status).toBe('pending');
    // The step must round-trip, or there is nothing to show the human.
    expect(JSON.parse(pending[0].step).target).toBe('Checkout');
  });

  it('records the operator decision so a later poll reads it, not not_found', () => {
    seedApproval('ap2');

    expect(decideEscalationApproval('ap2', 'approved', 'operator')).toBe(true);
    expect(getEscalationApproval('ap2')?.status).toBe('approved');
    // No longer pending, so a restart won't re-arm a timer for it.
    expect(getPendingEscalationApprovals()).toHaveLength(0);
  });

  it('refuses to overwrite an already-settled decision', () => {
    seedApproval('ap3');

    expect(decideEscalationApproval('ap3', 'approved', 'operator')).toBe(true);
    // A click racing an expiry, or a second tab, must not flip the answer the
    // agent has already acted on.
    expect(decideEscalationApproval('ap3', 'denied', 'timeout')).toBe(false);
    expect(getEscalationApproval('ap3')?.status).toBe('approved');
  });

  it('an expiry cannot overwrite an approval either', () => {
    seedApproval('ap4');

    expect(decideEscalationApproval('ap4', 'approved', 'operator')).toBe(true);
    expect(decideEscalationApproval('ap4', 'expired', 'restore')).toBe(false);
    expect(getEscalationApproval('ap4')?.status).toBe('approved');
  });

  it('leaves a row whose deadline passed while down distinguishable from a live one', () => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1h ago
    seedApproval('stale', longAgo, 30 * 60 * 1000);
    seedApproval('fresh');

    const rows = getPendingEscalationApprovals();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    const lapsed = (r: { created_at: string; timeout_ms: number }) =>
      Date.now() - new Date(r.created_at).getTime() >= r.timeout_ms;

    // restorePendingApprovals uses exactly this comparison to decide whether to
    // revive an ask or settle it as expired.
    expect(lapsed(byId.stale)).toBe(true);
    expect(lapsed(byId.fresh)).toBe(false);
  });

  it('reports an unknown id as absent, so a genuinely missing ask still fails safe', () => {
    expect(getEscalationApproval('nope')).toBeUndefined();
    expect(decideEscalationApproval('nope', 'approved', 'operator')).toBe(
      false,
    );
  });
});
