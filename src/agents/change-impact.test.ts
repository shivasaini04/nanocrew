/**
 * Stage 55 phase 2 — did the change help?
 *
 * Built around the real case: Crawler changed sourcing method on 2026-08-22, ran ~200
 * cycles on the new one, and concluded it was working. Nothing compared before to after.
 *
 * The two properties that decide whether this is useful rather than noise: a real collapse
 * is impossible to miss, and too little data says so instead of producing a number.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertAgent,
  recordConfigAudit,
  createAgentCycle,
  upsertTrackedItem,
} from '../db.js';
import { getChangeImpact, renderChangeImpacts } from './change-impact.js';
import type { AgentConfig } from '../types.js';

const AGENT = 'agent-impact-1';
const DAY = 86_400_000;
const CHANGE_AT = new Date('2026-08-22T12:00:00.000Z');

function makeAgent() {
  insertAgent({
    id: AGENT,
    name: 'Crawler',
    type: 'custom',
    status: 'idle',
    workspace: '/tmp/ws',
    identity_version: 1,
    created_at: new Date(CHANGE_AT.getTime() - 30 * DAY).toISOString(),
    owner_id: 'me',
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'g',
      escalationRules: [],
    } as AgentConfig,
  });
}

/** n cycles offset days from the change, each `mins` long and costing `cost`. */
function cycles(
  n: number,
  offsetDays: number,
  opts: { mins?: number; cost?: number; failed?: number } = {},
) {
  const { mins = 4, cost = 0.05, failed = 0 } = opts;
  for (let i = 0; i < n; i++) {
    const start = new Date(
      CHANGE_AT.getTime() + offsetDays * DAY + i * 3600_000,
    );
    createAgentCycle({
      agent_id: AGENT,
      cycle_type: 'lead_search',
      status: i < failed ? 'failed' : 'completed',
      started_at: start.toISOString(),
      ended_at: new Date(start.getTime() + mins * 60_000).toISOString(),
      cost,
      tasks_done: 1,
    });
  }
}

/** n tracker rows touched offset days from the change. */
function rows(n: number, offsetDays: number, prefix: string) {
  for (let i = 0; i < n; i++) {
    upsertTrackedItem(
      AGENT,
      'Leads',
      `${prefix}-${i}`,
      'qualified',
      { handle: `${prefix}-${i}` },
      'test',
      new Date(
        CHANGE_AT.getTime() + offsetDays * DAY + i * 60_000,
      ).toISOString(),
    );
  }
}

function theChange(): string {
  return recordConfigAudit({
    agentId: AGENT,
    capability: 'schedule',
    actor: 'agent',
    before: { method: 'linkedin_jobs' },
    after: { method: 'serper scripts' },
    reason: 'switching sourcing method',
    createdAt: CHANGE_AT.toISOString(),
  })!;
}

beforeEach(() => {
  _initTestDatabase();
  makeAgent();
});

describe('a change that made things worse', () => {
  it('shows the output collapse Crawler could not see', () => {
    cycles(7, -3);
    rows(18, -3, 'before');
    const id = theChange();
    cycles(7, 1);
    rows(1, 1, 'after');

    const impact = getChangeImpact(id)!;
    expect(impact.insufficient).toBe(false);
    expect(impact.before.outputRows).toBe(18);
    expect(impact.after.outputRows).toBe(1);

    const output = impact.findings.find((f) => f.startsWith('output rows'));
    expect(output).toBeDefined();
    expect(output).toContain('worse');
  });

  it('reports a cost fall as an improvement, not a regression', () => {
    // The 08-22 change did cut cost by ~94%. Cheaper is better; that must not read as a
    // problem, or every genuine saving looks like damage.
    cycles(7, -3, { cost: 0.6 });
    const id = theChange();
    cycles(7, 1, { cost: 0.02 });

    const cost = getChangeImpact(id)!.findings.find((f) =>
      f.startsWith('cost per cycle'),
    );
    expect(cost).toBeDefined();
    expect(cost).not.toContain('worse');
  });

  it('flags a slowdown as worse', () => {
    cycles(7, -3, { mins: 4 });
    const id = theChange();
    cycles(7, 1, { mins: 38 }); // Mailer's real number

    const dur = getChangeImpact(id)!.findings.find((f) =>
      f.startsWith('median minutes'),
    );
    expect(dur).toContain('worse');
  });
});

describe('when it cannot say anything', () => {
  it('says so rather than producing a number from two cycles', () => {
    cycles(2, -1);
    const id = theChange();
    cycles(2, 1);

    const impact = getChangeImpact(id)!;
    expect(impact.insufficient).toBe(true);
    expect(impact.findings).toEqual([]);
    expect(renderChangeImpacts([impact]).join('\n')).toContain(
      'not enough cycles',
    );
  });

  it('stays quiet when nothing moved materially', () => {
    cycles(7, -3);
    const id = theChange();
    cycles(7, 1);

    const impact = getChangeImpact(id)!;
    expect(impact.findings).toEqual([]);
    expect(renderChangeImpacts([impact]).join('\n')).toContain(
      'nothing moved materially',
    );
  });
});

describe('how it is worded', () => {
  it('never claims the change caused the outcome', () => {
    cycles(7, -3);
    rows(18, -3, 'before');
    const id = theChange();
    cycles(7, 1);
    rows(1, 1, 'after');

    const text = renderChangeImpacts([getChangeImpact(id)!]).join('\n');
    // Several things move at once — a model switch overlapped the real 08-22 change.
    expect(text).toContain('FOLLOWED');
    expect(text.toLowerCase()).not.toContain('caused by');
  });
});
