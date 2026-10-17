/**
 * What self_improve may write into an identity (2026-09-30).
 *
 * One task — semver range parsing — and the next self_improve wrote that task's rules into
 * the agent's IDENTITY.md as permanent bullets, loaded into every cycle after. Pinned here:
 * evolution waits for several completed work cycles, the prompts ask for lessons about how
 * to work rather than "domain-specific knowledge", and a bullet the model did not label
 * general never reaches the file.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';

const h = vi.hoisted(() => ({
  replies: [] as Array<string | { text: string; finishReason: string }>,
  prompts: [] as Array<{
    system: string;
    user: string;
    maxOutputTokens?: number;
  }>,
}));
vi.mock('ai', () => ({
  generateText: vi.fn(
    async (args: {
      system: string;
      messages: Array<{ content: string }>;
      maxOutputTokens?: number;
    }) => {
      h.prompts.push({
        system: args.system,
        user: args.messages[0]?.content ?? '',
        maxOutputTokens: args.maxOutputTokens,
      });
      const r = h.replies.shift() ?? '[]';
      return typeof r === 'string' ? { text: r, finishReason: 'stop' } : r;
    },
  ),
}));

import {
  _initTestDatabase,
  insertAgent,
  createAgentCycle,
  createAgentMemory,
  getLearnedBullets,
  getAgent,
  addLearnedBullet,
  updateAgentLastEvolvedAt,
  updateAgentIdentityVersion,
} from '../db.js';
import {
  IdentityEvolutionEngine,
  generalOnly,
  taskLabelled,
  withReasoningCap,
  EVOLUTION_REASONING_TOKENS,
  MIN_WORK_CYCLES_PER_EVOLUTION,
} from './identity-evolution.js';
import type { AgentConfig, CycleType } from '../types.js';

const AGENT_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
let tmpDir: string;
let engine: IdentityEvolutionEngine;

function identity(): string {
  return fs.readFileSync(path.join(tmpDir, AGENT_ID, 'IDENTITY.md'), 'utf-8');
}
function workCycles(
  n: number,
  type: CycleType = 'work',
  startedAt = new Date().toISOString(),
): void {
  for (let i = 0; i < n; i++) {
    createAgentCycle({
      agent_id: AGENT_ID,
      cycle_type: type,
      status: 'completed',
      started_at: startedAt,
      cost: 0,
      tasks_done: 1,
    });
  }
}
function memory(content: string): void {
  createAgentMemory({
    agent_id: AGENT_ID,
    type: 'insight',
    content,
    relevance: 0.9,
    used_count: 0,
  } as never);
}

beforeEach(() => {
  h.replies = [];
  h.prompts = [];
  delete process.env.LITELLM_PROXY_URL;
  process.env.ANTHROPIC_API_KEY = 'test-key';
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-scope-'));
  engine = new IdentityEvolutionEngine(tmpDir);
  _initTestDatabase();
  insertAgent({
    id: AGENT_ID,
    name: 'Bench B',
    type: 'custom',
    status: 'idle',
    workspace: tmpDir,
    config: {
      schedule: [],
      budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
      tools: [],
      goals: 'x',
      escalationRules: [],
    } as AgentConfig,
    identity_version: 1,
    created_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.join(tmpDir, AGENT_ID), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, AGENT_ID, 'IDENTITY.md'),
    '# Bench B\n\n## CORE\nA general agent.\n\n## LEARNED\n',
    'utf-8',
  );
  memory('Semver ^1.2.3 allows >=1.2.3 <2.0.0; ~1.2.3 allows <1.3.0');
  memory(
    'Writing the parser test-first caught two edge cases before submitting',
  );
});

describe('self_improve — the evidence gate', () => {
  it('leaves the identity alone after a single task', async () => {
    workCycles(1);
    h.replies.push(
      JSON.stringify([
        { text: 'Semver ^ allows minor bumps', scope: 'general' },
      ]),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({
      skipped: expect.stringMatching(
        /1 completed work cycle since the last update/,
      ),
    });
    expect(h.prompts).toHaveLength(0); // no model call at all
    expect(identity()).not.toMatch(/Semver/i);
    expect(getAgent(AGENT_ID)!.identity_version).toBe(1);
  });

  it('does not count its own housekeeping cycles as work', async () => {
    workCycles(1);
    workCycles(5, 'self_improve');
    workCycles(5, 'checkin');
    const r = await engine.evolve(AGENT_ID);
    expect('skipped' in r).toBe(true);
  });

  it('counts only cycles since the last evolution', async () => {
    workCycles(5, 'work', '2026-09-01T00:00:00.000Z');
    updateAgentLastEvolvedAt(AGENT_ID, '2026-09-15T00:00:00.000Z');
    workCycles(1);
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({
      skipped: expect.stringMatching(/^1 completed work cycle/),
    });
  });

  it('evolves once there are enough completed work cycles', async () => {
    workCycles(MIN_WORK_CYCLES_PER_EVOLUTION);
    h.replies.push(
      JSON.stringify([
        {
          text: 'Write tests before the implementation for parsers',
          scope: 'general',
        },
      ]),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ version: 2 });
    expect(identity()).toContain(
      '- Write tests before the implementation for parsers',
    );
  });
});

describe('self_improve — only general lessons reach the identity', () => {
  beforeEach(() => workCycles(MIN_WORK_CYCLES_PER_EVOLUTION));

  it('drops what the model labels task-only, keeps what it labels general', async () => {
    h.replies.push(
      JSON.stringify([
        { text: 'Semver ^1.2.3 allows >=1.2.3 <2.0.0', scope: 'task' },
        {
          text: "Check a spec's edge cases against its official grammar before coding",
          scope: 'general',
        },
      ]),
    );
    await engine.evolve(AGENT_ID);
    const after = identity();
    expect(after).toContain('official grammar');
    expect(after).not.toMatch(/Semver/i);
  });

  it('fails closed on unlabelled bullets — nothing is written', async () => {
    h.replies.push(JSON.stringify(['Semver ^1.2.3 allows >=1.2.3 <2.0.0']));
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ skipped: 'nothing general enough to keep' });
    expect(identity()).not.toMatch(/Semver/i);
  });

  it('no longer asks for domain-specific knowledge, and says what does not belong', async () => {
    h.replies.push('[]');
    await engine.evolve(AGENT_ID);
    const { system } = h.prompts[0];
    expect(system).not.toMatch(/domain-specific knowledge/i);
    expect(system).toMatch(/loaded into EVERY task/);
    expect(system).toMatch(/facts about the subject of a task/);
    expect(system).toMatch(/"scope": "general"/);
  });

  it('an incremental patch adds only general bullets, and may remove an old task fact', async () => {
    addLearnedBullet(AGENT_ID, 'Use rate limits of 3s for site X');
    addLearnedBullet(AGENT_ID, 'Texas has 254 counties');
    updateAgentLastEvolvedAt(
      AGENT_ID,
      new Date(Date.now() - 60_000).toISOString(),
    );
    workCycles(MIN_WORK_CYCLES_PER_EVOLUTION);
    memory('Fresh memory after the last evolution');
    const [keep, trivia] = getLearnedBullets(AGENT_ID);
    // Version 2 → not a full-resync version, so this is the incremental path.
    h.replies.push(
      JSON.stringify({
        add: [
          { text: 'Delaware incorporated 1.9M entities', scope: 'task' },
          {
            text: 'Save partial results to a file before a long step',
            scope: 'general',
          },
          'an unlabelled string',
        ],
        revise: [],
        remove: [trivia.id],
      }),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ version: 2 });
    const texts = getLearnedBullets(AGENT_ID).map((b) => b.text);
    expect(texts).toContain(keep.text);
    expect(texts).toContain(
      'Save partial results to a file before a long step',
    );
    expect(texts).not.toContain('Texas has 254 counties');
    expect(texts).not.toContain('Delaware incorporated 1.9M entities');
    expect(texts).not.toContain('an unlabelled string');
  });

  // Live 2026-10-01: with removal optional, six calls on the same three semver bullets removed
  // all three once, one twice, none twice. Every current bullet now gets a label.
  it('removes every current bullet the model labels task-only, keeps unlabelled and revised ones', async () => {
    addLearnedBullet(
      AGENT_ID,
      'SemVer prerelease gating: a prerelease only satisfies a same-tuple comparator',
    );
    addLearnedBullet(
      AGENT_ID,
      'Treat x, X and * as one wildcard when parsing semver ranges',
    );
    addLearnedBullet(
      AGENT_ID,
      'Parse ranges hyphen-first, then spaces, then ||',
    );
    addLearnedBullet(AGENT_ID, 'Run the tests before replying');
    updateAgentLastEvolvedAt(
      AGENT_ID,
      new Date(Date.now() - 60_000).toISOString(),
    );
    workCycles(MIN_WORK_CYCLES_PER_EVOLUTION);
    memory('Fresh memory after the last evolution');
    const [gate, wild, order, tests] = getLearnedBullets(AGENT_ID);
    h.replies.push(
      JSON.stringify({
        current: [
          { id: gate.id, scope: 'task' },
          { id: wild.id, scope: 'task' },
          { id: order.id, scope: 'task' },
          // tests: left unlabelled
        ],
        add: [],
        revise: [
          {
            id: order.id,
            text: 'When parsing a grammar, fix the precedence of its operators before coding',
          },
        ],
        remove: [],
      }),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ version: 2 });
    const texts = getLearnedBullets(AGENT_ID).map((b) => b.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        tests.text,
        'When parsing a grammar, fix the precedence of its operators before coding',
      ]),
    );
    expect(texts).toHaveLength(2);
    expect(identity()).not.toMatch(/semver/i);
  });

  it('an incremental patch that changes nothing does not bump the version', async () => {
    addLearnedBullet(AGENT_ID, 'An existing general lesson');
    updateAgentLastEvolvedAt(
      AGENT_ID,
      new Date(Date.now() - 60_000).toISOString(),
    );
    workCycles(MIN_WORK_CYCLES_PER_EVOLUTION);
    memory('Fresh memory after the last evolution');
    h.replies.push(
      JSON.stringify({
        add: [{ text: 'Some task fact', scope: 'task' }],
        revise: [],
        remove: [],
      }),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ skipped: 'nothing new that applies beyond one task' });
    expect(getAgent(AGENT_ID)!.identity_version).toBe(1);
  });
});

describe('self_improve — a reasoning model needs room to answer', () => {
  beforeEach(() => workCycles(MIN_WORK_CYCLES_PER_EVOLUTION));

  // 2026-10-01, prod: GLM 5.3 flash spent 2,297 reasoning tokens against a 2,000 cap and
  // returned nothing; the identity was left alone with "unparseable JSON" in the log.
  it('gives the evolution call enough output budget to reason first', async () => {
    h.replies.push('[]');
    await engine.evolve(AGENT_ID);
    expect(h.prompts[0].maxOutputTokens).toBeGreaterThanOrEqual(8000);
  });

  it('says plainly when the model was cut off before writing anything', async () => {
    h.replies.push({ text: '', finishReason: 'length' });
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ skipped: 'the update failed' });
    expect(identity()).not.toMatch(/^- /m);
  });
});

describe('bullets written under the old rules', () => {
  it('are rebuilt once from memory by a full resynthesis, not patched', async () => {
    addLearnedBullet(AGENT_ID, 'SemVer ^1.2.3 allows >=1.2.3 <2.0.0');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T13:24:39.000Z'));
    addLearnedBullet(AGENT_ID, 'Written before the rules changed');
    vi.useRealTimers();
    updateAgentLastEvolvedAt(AGENT_ID, '2026-09-30T13:24:40.000Z');
    workCycles(MIN_WORK_CYCLES_PER_EVOLUTION);
    h.replies.push(
      JSON.stringify([
        { text: 'Write the whole script, then run it once', scope: 'general' },
      ]),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ version: 2 });
    expect(h.prompts[0].system).toMatch(
      /^You are rewriting the LEARNED section/,
    ); // the full path
    expect(getLearnedBullets(AGENT_ID).map((b) => b.text)).toEqual([
      'Write the whole script, then run it once',
    ]);
  });
});

describe('a full resynthesis that keeps nothing', () => {
  beforeEach(() => workCycles(MIN_WORK_CYCLES_PER_EVOLUTION));

  it('clears bullets written under the old rules', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T13:24:39.000Z'));
    addLearnedBullet(AGENT_ID, 'SemVer ^1.2.3 allows >=1.2.3 <2.0.0');
    vi.useRealTimers();
    h.replies.push(
      JSON.stringify([{ text: 'Semver caret rules', scope: 'task' }]),
    );
    const r = await engine.evolve(AGENT_ID);
    expect(r).toEqual({ version: 2 });
    expect(getLearnedBullets(AGENT_ID)).toEqual([]);
    expect(identity()).not.toMatch(/semver/i);
  });

  it('leaves current-rules bullets alone on an empty answer, and on an unparseable one', async () => {
    addLearnedBullet(AGENT_ID, 'Run the tests before replying');
    updateAgentIdentityVersion(AGENT_ID, 3); // v4 is a periodic full resynthesis
    h.replies.push('[]');
    expect(await engine.evolve(AGENT_ID)).toEqual({
      skipped: 'nothing general enough to keep',
    });
    h.replies.push('Sorry, I cannot do that.');
    expect(await engine.evolve(AGENT_ID)).toEqual({
      skipped: 'the update failed',
    });
    expect(getLearnedBullets(AGENT_ID).map((b) => b.text)).toEqual([
      'Run the tests before replying',
    ]);
  });
});

describe('reasoning cap on OpenRouter calls', () => {
  it('adds OpenRouter reasoning.max_tokens to the request body and keeps the rest', async () => {
    const seen: string[] = [];
    const capped = withReasoningCap((async (
      _u: unknown,
      init?: RequestInit,
    ) => {
      seen.push(String(init?.body));
      return new Response('{}');
    }) as typeof fetch);
    await capped('http://proxy/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'openrouter/z-ai/glm-5.3-flash',
        max_tokens: 8000,
      }),
    });
    expect(JSON.parse(seen[0])).toEqual({
      model: 'openrouter/z-ai/glm-5.3-flash',
      max_tokens: 8000,
      reasoning: { max_tokens: EVOLUTION_REASONING_TOKENS },
    });
  });

  it('leaves a body it cannot parse alone', async () => {
    const seen: unknown[] = [];
    const capped = withReasoningCap((async (
      _u: unknown,
      init?: RequestInit,
    ) => {
      seen.push(init?.body);
      return new Response('{}');
    }) as typeof fetch);
    await capped('http://x', { method: 'POST', body: 'not json' });
    expect(seen).toEqual(['not json']);
  });
});

describe('taskLabelled', () => {
  it('returns only ids labelled task', () => {
    expect(
      taskLabelled([
        { id: 'a', scope: 'task' },
        { id: 'b', scope: 'general' },
        { id: 'c' },
        { scope: 'task' },
        'x',
        null,
      ]),
    ).toEqual(['a']);
    expect(taskLabelled(undefined)).toEqual([]);
  });
});

describe('generalOnly', () => {
  it.each([
    [null, []],
    ['not an array', []],
    [[{ text: ' a ', scope: 'general' }], ['a']],
    [[{ text: 'a', scope: 'task' }], []],
    [[{ text: 'a' }], []],
    [['a'], []],
    [[{ text: '', scope: 'general' }], []],
    [[{ text: 5, scope: 'general' }], []],
  ])('%j → %j', (input, out) => {
    expect(generalOnly(input)).toEqual(out);
  });
});
