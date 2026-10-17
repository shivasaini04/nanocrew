/**
 * Stage 57, docs 20 — races (n workers on one task, the first to pass wins), check files
 * for `command`, width by check strength, accepted files handed over by path, and the
 * spend of workers that never printed a result.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase } from '../db.js';
import { copyWorkerFiles } from './artifacts.js';
import { buildDigest, renderDigest } from './digest.js';
import { SwarmEngine, type EngineDeps } from './engine.js';
import { CHECK_FILES_DIR, sandboxArgs } from './sandbox.js';
import { validateRunRequest } from './spec.js';
import {
  getAttemptsForRun,
  getEvents,
  getRun,
  getTasksForRun,
  updateAttempt,
} from './store.js';
import type { WorkerAttemptResult, WorkerAttemptSpec } from './worker.js';

type Pending = {
  spec: WorkerAttemptSpec;
  resolve: (r: WorkerAttemptResult) => void;
};

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
};
const TEST_PY = 'from sol import f\nassert f(2) == 4\n';
const raceTask = (race: number, extra: Record<string, unknown> = {}) => ({
  objective: 'write sol.py with f(x) = x*x',
  tools: 'compute',
  output_schema: SCHEMA,
  race,
  verifier: [
    {
      kind: 'command',
      run: 'python test_sol.py',
      files: { 'test_sol.py': TEST_PY },
    },
  ],
  ...extra,
});
const good = {
  result: { answer: 'done' },
  summary: 'wrote it',
  evidence: ['sol.py'],
};

function ok(spec: WorkerAttemptSpec, cost = 0.01): WorkerAttemptResult {
  return {
    attemptId: spec.attemptId,
    containerName: '',
    ok: true,
    contract: good,
    costUsd: cost,
    toolCalls: 1,
    exitCode: 0,
    timings: { queuedMs: 0, firstOutputMs: 1, firstProgressMs: 1, runMs: 1000 },
  };
}
function fail(spec: WorkerAttemptSpec, cost = 0.01): WorkerAttemptResult {
  return {
    ...ok(spec, cost),
    ok: false,
    error: 'stopped',
    exitCode: 137,
    contract: undefined,
  };
}

let pending: Pending[];
let killed: string[];
let passes: Set<string>;
let commands: Array<{ attemptId: string; files?: Record<string, string> }>;
let collected: string[];

function makeEngine(over: Partial<EngineDeps> = {}): SwarmEngine {
  return new SwarmEngine({
    runAttempt: (spec) =>
      new Promise((resolve) => pending.push({ spec, resolve })),
    kill: (id) => {
      killed.push(id);
    },
    modelsFor: () => ({ model: 'worker-model', strongerModel: 'strong-model' }),
    ownerUserOf: () => 'user-1',
    deliver: () => {},
    canWake: () => false,
    wake: async () => null,
    taint: () => {},
    verifyContext: (_run, attemptId) => ({
      runCommand: async (_cmd, _t, files) => {
        commands.push({ attemptId, files });
        return passes.has(attemptId)
          ? { exitCode: 0, timedOut: false, output: 'ok' }
          : { exitCode: 1, timedOut: false, output: 'AssertionError' };
      },
    }),
    collectFiles: (run, task, attemptId) => {
      collected.push(attemptId);
      return [
        `/workspace/group/workspace/runs/${run.id}/task-${task.idx}/sol.py`,
      ];
    },
    ...over,
  });
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

function create(e: SwarmEngine, body: unknown): string {
  const r = e.createRun('boss-a', 'cyc', body);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.run.id;
}

beforeEach(() => {
  _initTestDatabase();
  pending = [];
  killed = [];
  passes = new Set();
  commands = [];
  collected = [];
});

describe('race — n workers on one task, the first to pass wins', () => {
  it('starts every racer at once, on the same model, with no retry note', () => {
    const e = makeEngine();
    create(e, { goal: 'g', tasks: [raceTask(3)] });
    expect(pending).toHaveLength(3);
    expect(new Set(pending.map((p) => p.spec.modelOverride))).toEqual(
      new Set(['worker-model']),
    );
    expect(pending.some((p) => p.spec.prompt.includes('earlier attempt'))).toBe(
      false,
    );
    expect(
      getTasksForRun(getRun(pending[0].spec.attemptId.split('-t')[0])!.id)[0]
        .status,
    ).toBe('leased');
  });

  it('accepts the first that passes, stops the rest, and refuses their late results', async () => {
    const e = makeEngine();
    const runId = create(e, { goal: 'g', tasks: [raceTask(3)] });
    const [a, b, c] = pending;
    passes.add(b.spec.attemptId);
    b.resolve(ok(b.spec));
    await flush();
    const [t] = getTasksForRun(runId);
    expect(t.status).toBe('accepted');
    expect(t.current_attempt_id).toBe(b.spec.attemptId);
    expect(killed.sort()).toEqual([a.spec.attemptId, c.spec.attemptId].sort());
    expect(collected).toEqual([b.spec.attemptId]);
    // the stopped racers report later — refused, but their spend still counts
    a.resolve(fail(a.spec, 0.02));
    c.resolve(ok(c.spec, 0.03));
    await flush();
    const attempts = getAttemptsForRun(runId);
    expect(attempts.find((x) => x.id === a.spec.attemptId)!.status).toBe(
      'killed',
    );
    expect(attempts.find((x) => x.id === c.spec.attemptId)!.status).toBe(
      'killed',
    );
    expect(commands.map((x) => x.attemptId)).toEqual([b.spec.attemptId]);
    const run = getRun(runId)!;
    expect(run.status).toBe('done');
    expect(run.spent_usd).toBeCloseTo(0.06, 5);
    expect(
      getEvents(runId).filter((ev) => ev.type === 'attempt_late'),
    ).toHaveLength(2);
  });

  it('keeps going when one racer is rejected while another still runs', async () => {
    const e = makeEngine();
    const runId = create(e, { goal: 'g', tasks: [raceTask(2)] });
    const [a, b] = pending;
    a.resolve(ok(a.spec));
    await flush();
    expect(getTasksForRun(runId)[0].status).toBe('leased');
    passes.add(b.spec.attemptId);
    b.resolve(ok(b.spec));
    await flush();
    expect(getTasksForRun(runId)[0].status).toBe('accepted');
    expect(getRun(runId)!.status).toBe('done');
  });

  it('dies when every racer fails — the racers are its retries', async () => {
    const e = makeEngine();
    const runId = create(e, { goal: 'g', tasks: [raceTask(3)] });
    pending[0].resolve(fail(pending[0].spec));
    pending[1].resolve(ok(pending[1].spec));
    pending[2].resolve(ok(pending[2].spec));
    await flush();
    expect(pending).toHaveLength(3);
    const [t] = getTasksForRun(runId);
    expect(t.status).toBe('dead');
    expect(t.last_reason).toMatch(/none of the 3 racers passed/);
    expect(getRun(runId)!.status).toBe('failed');
  });

  it('starts the remaining racers as slots free up when capacity is short', async () => {
    const e = makeEngine({ limits: { globalWorkers: 2 } });
    const runId = create(e, { goal: 'g', tasks: [raceTask(3)] });
    expect(pending).toHaveLength(2);
    pending[0].resolve(fail(pending[0].spec));
    await flush();
    expect(pending).toHaveLength(3);
    passes.add(pending[2].spec.attemptId);
    pending[2].resolve(ok(pending[2].spec));
    await flush();
    expect(getTasksForRun(runId)[0].status).toBe('accepted');
  });

  it('a racer whose check was cut off by a restart is checked again', async () => {
    const e1 = makeEngine();
    const runId = create(e1, { goal: 'g', tasks: [raceTask(2)] });
    const [a, b] = pending;
    // a restart while a's result was being checked and b was still working
    updateAttempt(a.spec.attemptId, { status: 'checking' });
    pending = [];
    passes.add(a.spec.attemptId);
    const e2 = makeEngine({ reloadContract: () => good });
    e2.recover();
    await flush();
    expect(killed).toContain(b.spec.attemptId);
    expect(getTasksForRun(runId)[0].status).toBe('accepted');
    expect(getTasksForRun(runId)[0].current_attempt_id).toBe(a.spec.attemptId);
  });

  it("the check gets the boss's test files", async () => {
    const e = makeEngine();
    create(e, { goal: 'g', tasks: [raceTask(2)] });
    passes.add(pending[0].spec.attemptId);
    pending[0].resolve(ok(pending[0].spec));
    await flush();
    expect(commands[0].files).toEqual({ 'test_sol.py': TEST_PY });
  });

  it('the worker is shown the check files', () => {
    const e = makeEngine();
    create(e, { goal: 'g', tasks: [raceTask(2)] });
    expect(pending[0].spec.prompt).toContain('## Check files: test_sol.py');
    expect(pending[0].spec.prompt).toContain('assert f(2) == 4');
  });
});

describe('race and check-file rules', () => {
  const errs = (body: unknown) => {
    const v = validateRunRequest(body);
    return v.ok ? [] : v.errors;
  };

  it('refuses a race with no check that can show truth', () => {
    const e = errs({ goal: 'g', tasks: [{ objective: 'x', race: 3 }] });
    expect(e.join(' ')).toMatch(
      /race needs a check that can show a result is true/,
    );
  });

  it('refuses races outside 2–4', () => {
    expect(errs({ goal: 'g', tasks: [raceTask(5)] }).join(' ')).toMatch(
      /race must be 2 to 4/,
    );
    expect(errs({ goal: 'g', tasks: [raceTask(1)] })).toEqual([]);
  });

  it('widens the run to fit the race when the boss named no width', () => {
    const v = validateRunRequest({ goal: 'g', tasks: [raceTask(4)] });
    expect(v.ok && v.value.max_parallel).toBe(4);
    expect(v.ok && v.value.tasks[0].max_attempts).toBe(4);
  });

  it('refuses check files that could escape the folder', () => {
    for (const name of ['../x.py', '/etc/passwd', 'a/../../b', 'a\\b', '']) {
      const e = errs({
        goal: 'g',
        tasks: [
          {
            ...raceTask(2),
            verifier: [{ kind: 'command', run: 'x', files: { [name]: 'y' } }],
          },
        ],
      });
      expect(e.length, name).toBeGreaterThan(0);
    }
  });

  it('refuses check files over the size limit', () => {
    const e = errs({
      goal: 'g',
      tasks: [
        {
          ...raceTask(2),
          verifier: [
            {
              kind: 'command',
              run: 'x',
              files: { 'big.py': 'x'.repeat(70_000) },
            },
          ],
        },
      ],
    });
    expect(e.join(' ')).toMatch(/at most 64000/);
  });
});

describe('width follows how results are checked', () => {
  const width = (verifier: unknown[] | undefined, tools = 'research') => {
    const v = validateRunRequest({
      goal: 'g',
      max_parallel: 8,
      tasks: [
        {
          objective: 'x',
          tools,
          output_schema: SCHEMA,
          ...(verifier ? { verifier } : {}),
        },
      ],
    });
    if (!v.ok) throw new Error(v.errors.join('; '));
    return v.value.max_parallel;
  };
  it('shape-only checks: 3', () =>
    expect(width([{ kind: 'schema' }], 'compute')).toBe(3));
  it('judged (the research default): 5', () =>
    expect(width(undefined)).toBe(5));
  it('mechanical checks: 8', () =>
    expect(width([{ kind: 'evidence_urls', fields: ['answer'] }])).toBe(8));
});

describe('accepted files reach the boss by path', () => {
  it('the digest lists them and says not to re-type them', async () => {
    const e = makeEngine();
    const runId = create(e, { goal: 'g', tasks: [raceTask(2)] });
    passes.add(pending[0].spec.attemptId);
    pending[0].resolve(ok(pending[0].spec));
    await flush();
    const md = renderDigest(
      buildDigest(
        getRun(runId)!,
        getTasksForRun(runId),
        getAttemptsForRun(runId),
      ),
    );
    expect(md).toContain(
      `/workspace/group/workspace/runs/${runId}/task-0/sol.py`,
    );
    expect(md).toMatch(/never re-type them/);
  });
});

describe('copyWorkerFiles', () => {
  let src: string, dest: string;
  beforeEach(() => {
    src = fs.mkdtempSync(path.join(os.tmpdir(), 'w-src-'));
    dest = fs.mkdtempSync(path.join(os.tmpdir(), 'w-dest-'));
  });
  afterEach(() => {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  const put = (rel: string, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), text);
  };

  it('copies what the worker made and nothing of the runtime', () => {
    put('sol.py');
    put('pkg/util.py');
    put('workspace/report.md');
    put('IDENTITY.md');
    put('result.json');
    put('progress.json');
    put('mcp-servers.json');
    put('.nanocrew/telemetry/x.jsonl');
    put('.checkpoints/HEAD');
    put('memory/m.md');
    put('sessions/s.jsonl');
    put('workspace/memory/m.md');
    put('workspace/inbox/run.md');
    put('__pycache__/sol.pyc');
    put('pkg/__pycache__/u.pyc');
    put(`${CHECK_FILES_DIR}/test_sol.py`);
    const r = copyWorkerFiles(src, dest);
    expect(r.copied.sort()).toEqual([
      'pkg/util.py',
      'sol.py',
      'workspace/report.md',
    ]);
    expect(fs.existsSync(path.join(dest, 'pkg/util.py'))).toBe(true);
  });

  it('never follows a link the worker planted', () => {
    put('sol.py');
    const outside = path.join(os.tmpdir(), `secret-${Date.now()}.txt`);
    fs.writeFileSync(outside, 'secret');
    try {
      try {
        fs.symlinkSync(outside, path.join(src, 'leak.txt'));
      } catch {
        return; /* no symlink rights on this machine */
      }
      const r = copyWorkerFiles(src, dest);
      expect(r.copied).toEqual(['sol.py']);
      expect(r.skipped).toBe(1);
      expect(fs.existsSync(path.join(dest, 'leak.txt'))).toBe(false);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it('stops at its limits', () => {
    for (let i = 0; i < 5; i++) put(`f${i}.txt`, 'abcd');
    const r = copyWorkerFiles(src, dest, {
      files: 3,
      fileBytes: 100,
      totalBytes: 100,
    });
    expect(r.copied).toHaveLength(3);
    expect(r.skipped).toBe(2);
  });
});

describe('sandbox with check files', () => {
  it("lays the check files over the worker's copy, after removing any the worker planted", () => {
    const script = sandboxArgs('run-x-t0-a1', 'python test_sol.py', true).at(
      -1,
    )!;
    const planted = script.indexOf(
      `rm -rf /work/sessions /work/.nanocrew /work/${CHECK_FILES_DIR}`,
    );
    const overlay = script.indexOf(`cp -r /src/${CHECK_FILES_DIR}/. /work/`);
    const run = script.indexOf('python test_sol.py');
    expect(planted).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(planted);
    expect(run).toBeGreaterThan(overlay);
  });
  it('without check files, no overlay', () => {
    expect(sandboxArgs('run-x-t0-a1', 'true').at(-1)).not.toContain(
      `cp -r /src/${CHECK_FILES_DIR}`,
    );
  });
});

describe('long pieces may run long', () => {
  it('a task can ask for up to 30 minutes, and its worker gets that long', () => {
    const e = makeEngine();
    create(e, { goal: 'g', tasks: [{ ...raceTask(2), timeout_minutes: 25 }] });
    expect(pending[0].spec.timeoutMs).toBe(25 * 60_000);
    const v = validateRunRequest({
      goal: 'g',
      tasks: [{ ...raceTask(2), timeout_minutes: 45 }],
    });
    expect(v.ok).toBe(false);
  });
  it('a quiet run is not stalled while a worker is inside its lease', async () => {
    let now = Date.now();
    const alerts: string[] = [];
    const e = makeEngine({
      now: () => now,
      alert: (_r, title) => {
        alerts.push(title);
      },
    });
    create(e, { goal: 'g', tasks: [{ ...raceTask(2), timeout_minutes: 30 }] });
    now += 20 * 60_000; // 20 quiet minutes, lease runs to 31
    expect(e.detectStalls()).toEqual([]);
    expect(alerts).toEqual([]);
    now += 15 * 60_000; // past the lease: now it is stalled
    expect(e.detectStalls()).toHaveLength(1);
    expect(alerts[0]).toMatch(/stalled/);
  });
});

describe('a judge that returns nothing is asked again before it counts', () => {
  it('an empty answer gets one more try; a real answer then counts', async () => {
    const { runPanel } = await import('./judge.js');
    const calls: string[] = [];
    const complete = async (model: string, _s: string, user: string) => {
      calls.push(model);
      const first = calls.filter((m) => m === model).length === 1;
      if (model === 'a' && first) return { text: '', costUsd: 0.001 };
      expect(user.length).toBeGreaterThan(0);
      return {
        text: '{"verdict": "accept", "reason": "on the page"}',
        costUsd: 0.001,
      };
    };
    const v = await runPanel(
      { objective: 'o', rubric: 'r', result: { x: 1 }, pages: [] },
      [
        { model: 'a', weight: 1 },
        { model: 'b', weight: 1 },
      ],
      complete,
    );
    expect(v.accepted).toBe(true);
    expect(calls.filter((m) => m === 'a')).toHaveLength(2);
    expect(v.costUsd).toBeCloseTo(0.003, 6);
  });
  it('still empty after the retry: it fails closed', async () => {
    const { runPanel } = await import('./judge.js');
    const complete = async (model: string) => ({
      text: model === 'a' ? '' : '{"verdict": "accept", "reason": "ok"}',
      costUsd: 0,
    });
    const v = await runPanel(
      { objective: 'o', rubric: 'r', result: {}, pages: [] },
      [
        { model: 'a', weight: 1 },
        { model: 'b', weight: 1 },
      ],
      complete,
    );
    expect(v.accepted).toBe(false);
  });
});
