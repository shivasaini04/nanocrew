/**
 * Stage 57 phase 5 — the boss's record of run shapes that worked, for its own prompt.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { insertRun, insertTask, updateRun, updateTask } from './store.js';
import { delegationHistory } from './templates.js';

const spec = (fields: string[], checks: string[]) =>
  JSON.stringify({
    objective: 'find it',
    tools: 'research',
    max_attempts: 2,
    output_schema: {
      type: 'object',
      properties: Object.fromEntries(
        fields.map((f) => [f, { type: 'string' }]),
      ),
    },
    verifier: [{ kind: 'schema' }, ...checks.map((kind) => ({ kind }))],
  });

function run(
  id: string,
  agent: string,
  goal: string,
  statuses: string[],
  opts: {
    fields?: string[];
    checks?: string[];
    spent?: number;
    reason?: string;
    status?: string;
  } = {},
) {
  insertRun({
    id,
    owner_agent_id: agent,
    owner_user_id: 'u',
    boss_cycle_id: null,
    goal,
    mode: 'fanout',
    status: 'running',
    budget_usd: 0.5,
    max_parallel: 3,
    background: 1,
    trace_id: 't',
    created_at: `2026-09-29T10:0${id.slice(-1)}:00.000Z`,
  });
  statuses.forEach((st, i) => {
    insertTask({
      id: `${id}-t${i}`,
      run_id: id,
      idx: i,
      spec_json: spec(
        opts.fields ?? ['company', 'hq_city'],
        opts.checks ?? ['evidence_urls', 'judge'],
      ),
      depends_on: null,
      dedupe_key: null,
      status: 'pending',
      max_attempts: 2,
      created_at: '2026-09-29T10:00:00.000Z',
    });
    updateTask(`${id}-t${i}`, {
      status: st as never,
      last_reason: st === 'dead' ? (opts.reason ?? null) : null,
    });
  });
  updateRun(id, {
    status: (opts.status ?? 'done') as never,
    finished_at: '2026-09-29T10:10:00.000Z',
    spent_usd: opts.spent ?? 0.06,
    digest_json: JSON.stringify({ wallMs: 90_000 }),
  });
}

beforeEach(() => _initTestDatabase());

describe('delegation history', () => {
  it('is empty for an agent that has never delegated', () => {
    expect(delegationHistory('boss-a')).toBe('');
  });

  it('names what each shape asked for, how it was checked, and how it went', () => {
    run(
      'run-1',
      'boss-a',
      'CEO and HQ for three companies',
      ['accepted', 'accepted', 'accepted'],
      { spent: 0.075 },
    );
    const h = delegationHistory('boss-a');
    expect(h).toMatch(/"CEO and HQ for three companies": 3\/3 accepted/);
    expect(h).toMatch(/fields company, hq_city/);
    expect(h).toMatch(/checked by evidence_urls \+ judge/);
    expect(h).toMatch(/~\$0\.025\/task, 90s/);
  });

  it('pools runs of the same shape, keeps others apart, and names a recurring failure', () => {
    run('run-1', 'boss-a', 'pricing A', ['accepted', 'dead'], {
      fields: ['plan', 'price'],
      reason:
        'judge: reject/reject: "$20" is the annual price — cite the monthly one',
    });
    run('run-2', 'boss-a', 'pricing B', ['dead', 'accepted'], {
      fields: ['plan', 'price'],
      reason:
        'judge: reject/reject: "$9" is the annual price — cite the monthly one',
    });
    run('run-3', 'boss-a', 'leads', ['accepted'], {
      fields: ['email'],
      checks: ['email'],
    });
    run('run-4', 'boss-b', 'someone else', ['accepted']);
    const h = delegationHistory('boss-a');
    expect(h.match(/^- "/gm)).toHaveLength(2);
    expect(h).toMatch(/2\/4 accepted/);
    expect(h).toMatch(/Most common reason a task failed \(2×\)/);
    expect(h).not.toMatch(/someone else/);
    expect(h).not.toMatch(/\$20|\$9/); // quoted values, which a worker wrote, are dropped
  });

  it('leaves out cancelled runs', () => {
    run('run-1', 'boss-a', 'never ran', ['cancelled'], { status: 'cancelled' });
    expect(delegationHistory('boss-a')).toBe('');
  });
});
