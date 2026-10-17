/**
 * Stage 54 phase 1 — the digest that makes the audit table useful.
 *
 * A trail nobody reads is not a safety net. These pin the two properties that decide
 * whether this one gets read: it stays quiet when there is nothing to say, and a change
 * that removed a lot of content leads it no matter how quiet the day was.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertAgent,
  recordConfigAudit,
  getNotifications,
} from '../db.js';
import { runConfigAuditDigest } from './config-audit-digest.js';
import type { AgentConfig } from '../types.js';

const OWNER = 'owner-1111';
const AGENT = 'agent-2222';

const baseConfig = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'g',
  escalationRules: [],
} as AgentConfig;

beforeEach(() => {
  _initTestDatabase();
  insertAgent({
    id: AGENT,
    name: 'Crawler',
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    config: baseConfig,
    identity_version: 1,
    created_at: new Date().toISOString(),
    owner_id: OWNER,
  });
});

function digestBodies(): string[] {
  return getNotifications(50)
    .filter((n) => n.type === 'config_audit_digest')
    .map((n) => `${n.title}\n${n.body}`);
}

describe('config audit digest', () => {
  it('says nothing when nothing changed', () => {
    expect(runConfigAuditDigest(24)).toBe(0);
    expect(digestBodies()).toHaveLength(0);
  });

  it("ignores the owner's own edits — you already know what you did", () => {
    recordConfigAudit({
      agentId: AGENT,
      capability: 'budget',
      actor: 'owner',
      before: { budget: { daily: 5 } },
      after: { budget: { daily: 9 } },
      reason: 'Edited from the dashboard',
    });
    expect(runConfigAuditDigest(24)).toBe(0);
  });

  it('reports what the agent changed on its own', () => {
    recordConfigAudit({
      agentId: AGENT,
      capability: 'status',
      actor: 'agent',
      cycleId: 'c1',
      before: { status: 'paused' },
      after: { status: 'running' },
      reason: 'resuming the sweep rotation',
    });
    expect(runConfigAuditDigest(24)).toBe(1);

    const [body] = digestBodies();
    expect(body).toContain('Crawler');
    expect(body).toContain('1 self-change');
    expect(body).toContain('status');
  });

  it('leads with a change that removed a lot of content', () => {
    // The 2026-08-28 shape: a large prompt replaced by almost nothing.
    recordConfigAudit({
      agentId: AGENT,
      capability: 'identity',
      actor: 'system',
      before: { identity: 'x'.repeat(4800) },
      after: { identity: '' },
      reason: 'self_improve evolution to v3',
    });
    // Plus an ordinary change on the same day, to prove the loud one still leads.
    recordConfigAudit({
      agentId: AGENT,
      capability: 'model',
      actor: 'agent',
      before: { model: 'a' },
      after: { model: 'b' },
      reason: 'faster model',
    });

    expect(runConfigAuditDigest(24)).toBe(1);
    const [body] = digestBodies();

    expect(body).toContain('removed content — review');
    expect(body).toContain('identity');
    expect(body).toMatch(/−[\d,]+ bytes/);
    // and the quiet change is still listed
    expect(body).toContain('All changes:');
  });

  it('only reports changes inside its window', () => {
    recordConfigAudit({
      agentId: AGENT,
      capability: 'status',
      actor: 'agent',
      before: { status: 'paused' },
      after: { status: 'running' },
    });

    // A negative window starts in the future, so the row just written is outside it.
    // (A zero-hour window starts exactly now and would race the row's own timestamp —
    // the boundary is inclusive, which is correct and not what this is testing.)
    expect(runConfigAuditDigest(-1)).toBe(0);

    // The same row is inside a normal window.
    expect(runConfigAuditDigest(24)).toBe(1);
  });
});
