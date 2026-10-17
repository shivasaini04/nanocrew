import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  tmp: `${process.env.TEMP ?? process.env.TMPDIR ?? '/tmp'}/worker-test-${process.pid}-${Date.now()}`,
  revoked: [] as string[],
  buildArgs: vi.fn((..._a: unknown[]) => ['run', 'img']),
  state: { lastStdin: '', behave: (_p: unknown) => {} },
}));
const tmp = h.tmp;

vi.mock('../config.js', () => ({ DATA_DIR: h.tmp }));
vi.mock('../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));
vi.mock('../container-spawn-limiter.js', () => ({
  tryAcquireSpawnSlot: vi.fn(() => true),
  waitForSpawnSlot: vi.fn(),
  releaseSpawnSlotAfterSettle: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../db.js', () => ({
  getAgent: vi.fn((id: string) =>
    id === 'owner-1'
      ? {
          id: 'owner-1',
          name: 'Finder',
          config: { model: 'openrouter/z-ai/glm-5.3-flash' },
        }
      : undefined,
  ),
  getAgentDefaultModel: vi.fn(() => null),
}));
vi.mock('../services/model-router.js', () => ({
  modelRouter: {
    resolveSubagentModel: vi.fn(() => undefined),
    resolve: vi.fn(
      (cfg: { model?: string }) => cfg.model ?? 'platform-default',
    ),
    resolveThinking: vi.fn(() => false),
  },
}));
const buildArgs = h.buildArgs;
vi.mock('../agents/nanobot-cycle-runner.js', () => ({
  buildContainerArgs: (...a: unknown[]) => h.buildArgs(...a),
  calculateCost: vi.fn(() => 0.0123),
  getNanobotSource: vi.fn(() => '/nanoagent'),
  readLLMKeys: vi.fn(() => ({
    OPENROUTER_API_KEY: 'or-key',
    BRAVE_API_KEY: 'b',
  })),
  OUTPUT_START_MARKER: '---NanoCrew_OUTPUT_START---',
  OUTPUT_END_MARKER: '---NanoCrew_OUTPUT_END---',
}));

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  return {
    spawn: vi.fn((_bin: string, args: string[]) => {
      const p = new EventEmitter() as any;
      p.stdin = new PassThrough();
      p.stdout = new PassThrough();
      p.stderr = new PassThrough();
      p.kill = vi.fn(() => {
        setTimeout(() => p.emit('close', null), 1);
      });
      if (args[0] === 'rm') return p; // the timeout's `docker rm -f`
      p.stdin.on('data', (d: Buffer) => {
        h.state.lastStdin += d.toString();
      });
      setTimeout(() => h.state.behave(p), 5);
      return p;
    }),
  };
});

import {
  runWorkerAttempt,
  spentFromTelemetry,
  workerRoot,
  WORKER_WITHHELD_TOOLS,
} from './worker.js';

const OUT = (obj: unknown) =>
  `---NanoCrew_OUTPUT_START---\n${JSON.stringify(obj)}\n---NanoCrew_OUTPUT_END---\n`;

beforeEach(() => {
  h.state.lastStdin = '';
  buildArgs.mockClear();
  // The relay only issues a token when the platform holds a key; don't depend on a local .env.
  process.env.OPENROUTER_API_KEY ||= 'test-platform-key';
  process.env.BRAVE_API_KEY ||= 'test-brave-key';
});

describe('runWorkerAttempt', () => {
  it('runs on the owner model, sends no owner credentials and no token, and withholds the worker set', async () => {
    h.state.behave = (p: any) => {
      p.stderr.write('[adapter] starting\n');
      p.stdout.write(
        'NANOBOT_PROGRESS:{"type":"tool_analytics","tool":"web_search"}\n',
      );
      p.stdout.write(
        OUT({
          status: 'success',
          result: 'done',
          model: 'openrouter/z-ai/glm-5.3-flash',
          usage: { prompt_tokens: 10 },
        }),
      );
      p.emit('close', 0);
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-1',
      prompt: 'find x',
    });

    expect(r.ok).toBe(true);
    expect(r.result).toBe('done');
    expect(r.costUsd).toBe(0.0123);
    expect(r.toolCalls).toBe(1);
    expect(r.timings.firstOutputMs).not.toBeNull();
    // model argument (index 8) is the owner's, never the platform default
    expect(buildArgs.mock.calls[0][8]).toBe('openrouter/z-ai/glm-5.3-flash');
    // agentCredentials (index 5) is empty — the owner's stored credentials are never passed
    expect(buildArgs.mock.calls[0][5]).toEqual({});

    const payload = JSON.parse(h.state.lastStdin);
    expect(payload.prompt).toBe('find x');
    // Stage 64 phase 2: the real model key never reaches the worker. It gets a relay-only
    // token in its place (opens the model relay and nothing else), and non-model keys as before.
    // Search keys are relayed the same way, so neither real value is in the payload.
    expect(payload.secrets.OPENROUTER_API_KEY).toMatch(/^rly_[0-9a-f]{48}$/);
    expect(JSON.stringify(payload.secrets)).not.toContain('or-key');
    expect(payload.secrets.BRAVE_API_KEY).not.toBe('b');
    for (const t of [
      'smtp_send',
      'handoff_to',
      'self_manage',
      'get_credential',
      'desktop_task',
      'append_memory',
    ]) {
      expect(payload.withheldTools).toContain(t);
    }
    // no cycle token: a worker has a shell, so a token would be readable by the model
    expect(payload.cycleToken).toBeUndefined();
    // the worker's world is its own folder, with a worker identity
    expect(
      fs.readFileSync(
        path.join(tmp, 'swarm', 'attempts', 'a-1', 'IDENTITY.md'),
        'utf-8',
      ),
    ).toMatch(/You are a worker/);
  });

  it('keeps research tools available', () => {
    for (const t of [
      'web_search',
      'web_fetch',
      'browser',
      'effector',
      'effector_swarm',
      'exec',
      'read_file',
      'write_file',
    ]) {
      expect(WORKER_WITHHELD_TOOLS).not.toContain(t);
    }
  });

  it('reports a worker error as not ok, with its cost', async () => {
    h.state.behave = (p: any) => {
      p.stdout.write(OUT({ status: 'error', error: 'boom', result: null }));
      p.emit('close', 1);
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-2',
      prompt: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });

  it('fails closed on output it cannot parse', async () => {
    h.state.behave = (p: any) => {
      p.stdout.write('hello\n');
      p.emit('close', 0);
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-3',
      prompt: 'x',
    });
    expect(r.ok).toBe(false);
    expect(r.costUsd).toBe(0);
  });

  it('fails a timed-out attempt even when it printed a partial output block', async () => {
    h.state.behave = (p: any) => {
      p.stdout.write(
        OUT({ status: 'success', result: ' fetch loop for all 12 packages:' }),
      );
      // ...and then never exits on its own
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-6',
      prompt: 'x',
      timeoutMs: 30,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });

  it('fails an attempt that exits non-zero even with a success block', async () => {
    h.state.behave = (p: any) => {
      p.stdout.write(OUT({ status: 'success', result: 'x' }));
      p.emit('close', 137);
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-7',
      prompt: 'x',
    });
    expect(r.ok).toBe(false);
  });

  it('kills an attempt that runs past its timeout', async () => {
    h.state.behave = () => {
      /* never finishes */
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-4',
      prompt: 'x',
      timeoutMs: 30,
    });
    expect(r.ok).toBe(false);
  });

  it('passes the tool allow-list and result schema, uses a model override, and reads what report_result wrote', async () => {
    h.state.behave = (p: any) => {
      // what the container's report_result tool does
      fs.writeFileSync(
        path.join(tmp, 'swarm', 'attempts', 'a-8', 'result.json'),
        JSON.stringify({ result: { n: 1 }, summary: 's' }),
      );
      p.stdout.write(
        OUT({ status: 'success', result: 'done', model: 'strong' }),
      );
      p.emit('close', 0);
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-8',
      prompt: 'x',
      allowedTools: ['web_search', 'report_result'],
      reportSchema: { type: 'object' },
      modelOverride: 'strong',
    });
    const payload = JSON.parse(h.state.lastStdin);
    expect(payload.allowedTools).toEqual(['web_search', 'report_result']);
    expect(payload.reportSchema).toEqual({ type: 'object' });
    expect(buildArgs.mock.calls[0][8]).toBe('strong');
    expect(r.contract).toEqual({ result: { n: 1 }, summary: 's' });
  });

  it('refuses an unknown owner and an unsafe attempt id', async () => {
    await expect(
      runWorkerAttempt({ ownerAgentId: 'nope', attemptId: 'a-5', prompt: 'x' }),
    ).rejects.toThrow(/owner agent not found/);
    await expect(
      runWorkerAttempt({
        ownerAgentId: 'owner-1',
        attemptId: '../etc',
        prompt: 'x',
      }),
    ).rejects.toThrow(/bad attemptId/);
  });
});

describe('spentFromTelemetry — a worker stopped before it printed a result still cost money', () => {
  it('adds up every model call the worker logged, and ignores a line cut off by the kill', () => {
    const dir = path.join(workerRoot('a-tel'), '.nanocrew', 'telemetry');
    fs.mkdirSync(dir, { recursive: true });
    const call = JSON.stringify({
      event: 'api_response_received',
      usage: { prompt_tokens: 7000, completion_tokens: 400 },
    });
    fs.writeFileSync(
      path.join(dir, 'session-worker-a-tel.jsonl'),
      [
        JSON.stringify({ event: 'api_request_sent', model: 'm' }),
        call,
        call,
        '{"event": "api_response_received", "usa',
      ].join('\n'),
    );
    // calculateCost is mocked at $0.0123 a call
    expect(spentFromTelemetry('a-tel', 'm')).toBeCloseTo(0.0246, 6);
    expect(spentFromTelemetry('a-none', 'm')).toBe(0);
  });
});

describe('a worker that reported and then ran out of time', () => {
  it('its reported result is checked, not thrown away (bench 2, docs 20)', async () => {
    h.state.behave = () => {
      // report_result wrote its file; the worker then kept going and never exited
      fs.writeFileSync(
        path.join(workerRoot('a-late'), 'result.json'),
        JSON.stringify({ result: { x: 1 }, summary: 's', evidence: [] }),
      );
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-late',
      prompt: 'x',
      timeoutMs: 30,
    });
    expect(r.ok).toBe(true);
    expect(r.contract).toEqual({
      result: { x: 1 },
      summary: 's',
      evidence: [],
    });
  });
  it('without a reported result a timeout still fails', async () => {
    h.state.behave = () => {
      /* never reports, never exits */
    };
    const r = await runWorkerAttempt({
      ownerAgentId: 'owner-1',
      attemptId: 'a-late2',
      prompt: 'x',
      timeoutMs: 30,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/);
  });
});
