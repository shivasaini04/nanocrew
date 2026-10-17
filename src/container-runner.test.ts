import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---NanoCrew_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NanoCrew_OUTPUT_END---';

// Mock config
vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'NanoCrew-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 1800000, // 30min
  DATA_DIR: '/tmp/NanoCrew-test-data',
  GROUPS_DIR: '/tmp/NanoCrew-test-groups',
  IDLE_TIMEOUT: 1800000, // 30min
  TIMEZONE: 'America/Los_Angeles',
  DEFAULT_MEMORY_LIMIT_MAIN: '2g',
  DEFAULT_MEMORY_LIMIT_WORKER: '1g',
  DEFAULT_CPU_LIMIT_MAIN: '2',
  DEFAULT_CPU_LIMIT_WORKER: '1',
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { _resetSpawnLimiterForTesting } from './container-spawn-limiter.js';
import type { RegisteredGroup } from './types.js';

// The spawn limiter is a process-wide singleton; a slot acquired under fake timers
// never releases (its release timer is abandoned on vi.useRealTimers()), which would
// otherwise leak across the it() blocks below until one hangs waiting for a slot that
// never frees. Reset before every test regardless of which describe block it's in.
beforeEach(() => {
  _resetSpawnLimiterForTesting();
});

const testGroup: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Nano',
  added_at: new Date().toISOString(),
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: ContainerOutput,
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner timeout behavior', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fakeProc = createFakeProcess();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('timeout after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output with a result
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    // Let output processing settle
    await vi.advanceTimersByTimeAsync(10);

    // Fire the hard timeout (IDLE_TIMEOUT + 30s = 1830000ms)
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event (as if container was stopped by the timeout)
    fakeProc.emit('close', 137);

    // Let the promise resolve
    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ result: 'Here is my response' }),
    );
  });

  it('timeout with no output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // No output emitted — fire the hard timeout
    await vi.advanceTimersByTimeAsync(1830000);

    // Emit close event
    fakeProc.emit('close', 137);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('timed out');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testGroup,
      testInput,
      () => {},
      onOutput,
    );

    // Emit output
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await vi.advanceTimersByTimeAsync(10);

    // Normal exit (no timeout)
    fakeProc.emit('close', 0);

    await vi.advanceTimersByTimeAsync(10);

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});

describe('container-runner arguments and resource limits', () => {
  beforeEach(() => {
    fakeProc = createFakeProcess();
    vi.mocked(spawn).mockClear();
  });

  it('applies default main resource limits when isMain is true', async () => {
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {},
      },
      {
        ...testInput,
        isMain: true,
      },
      () => {},
    );

    // Complete the run quickly so we can inspect spawn calls
    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const args = spawnCalls[0][1];

    // Main should have 2g and 2 cpus defaults
    const memIndex = args.indexOf('--memory');
    expect(memIndex).not.toBe(-1);
    expect(args[memIndex + 1]).toBe('2g');

    const cpuIndex = args.indexOf('--cpus');
    expect(cpuIndex).not.toBe(-1);
    expect(args[cpuIndex + 1]).toBe('2');
  });

  it('applies default worker resource limits when isMain is false', async () => {
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {},
      },
      {
        ...testInput,
        isMain: false,
      },
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const args = spawnCalls[0][1];

    // Worker should have 1g and 1 cpu defaults
    const memIndex = args.indexOf('--memory');
    expect(memIndex).not.toBe(-1);
    expect(args[memIndex + 1]).toBe('1g');

    const cpuIndex = args.indexOf('--cpus');
    expect(cpuIndex).not.toBe(-1);
    expect(args[cpuIndex + 1]).toBe('1');
  });

  it('applies custom resource limits when provided in containerConfig', async () => {
    const resultPromise = runContainerAgent(
      {
        ...testGroup,
        containerConfig: {
          memoryLimit: '512m',
          cpuLimit: '0.5',
        },
      },
      {
        ...testInput,
        isMain: false,
      },
      () => {},
    );

    emitOutputMarker(fakeProc, { status: 'success', result: 'ok' });
    fakeProc.emit('close', 0);
    await resultPromise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    expect(spawnCalls.length).toBe(1);
    const args = spawnCalls[0][1];

    const memIndex = args.indexOf('--memory');
    expect(memIndex).not.toBe(-1);
    expect(args[memIndex + 1]).toBe('512m');

    const cpuIndex = args.indexOf('--cpus');
    expect(cpuIndex).not.toBe(-1);
    expect(args[cpuIndex + 1]).toBe('0.5');
  });
});
