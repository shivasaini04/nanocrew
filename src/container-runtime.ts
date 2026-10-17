/**
 * Container runtime abstraction for NanoCrew.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import {
  execSync,
  execFile,
  execFileSync,
  spawn,
  ChildProcess,
} from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

export interface ContainerInfo {
  id: string;
  name: string;
  state: string;
  status: string;
  image: string;
  created: string;
  ports: string;
}

export interface ContainerStats {
  id: string;
  name: string;
  cpu_percent: string;
  memory_usage: string;
  memory_limit: string;
  memory_percent: string;
}

/** Get list of all NanoCrew containers */
export async function getContainers(): Promise<ContainerInfo[]> {
  try {
    // Explicit tab-delimited fields — NOT `{{json .}}`. Under Docker Desktop's containerd
    // image store, `{{json .}}` serializes a Size field, and computing it calls
    // snapshotter.Usage (lstat-ing every layer) — which fails transiently while a large
    // image layer is being built (e.g. a sidecar snapshot bake), breaking this whole call
    // ("Failed to get containers"). We don't use size, so we never ask for it.
    const SEP = '\t';
    // execFile (not execFileSync) — this runs on a 3s poll timer for as long as any
    // dashboard client is connected. Sync child_process calls block the ENTIRE Node
    // event loop, not just the caller, until the docker CLI/daemon round-trip
    // completes; when the daemon is slow (e.g. mid-build, or just under load) that
    // froze the whole app for every user, not only whoever's page triggered the poll.
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      [
        'ps',
        '-a',
        '--filter',
        'name=NanoCrew-',
        '--format',
        [
          '{{.ID}}',
          '{{.Names}}',
          '{{.State}}',
          '{{.Status}}',
          '{{.Image}}',
          '{{.CreatedAt}}',
          '{{.Ports}}',
        ].join(SEP),
      ],
      { encoding: 'utf-8' },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [id, name, state, status, image, created, ports] =
          line.split(SEP);
        if (!id) return null;
        return { id, name, state, status, image, created, ports };
      })
      .filter((c): c is ContainerInfo => c !== null && !!c.id);
  } catch (err) {
    logger.error({ err }, 'Failed to get containers');
    return [];
  }
}

/** Get stats for a specific container */
export async function getContainerStats(
  id: string,
): Promise<ContainerStats | null> {
  if (!id) return null;
  try {
    // Format JSON lines, no stream to just get the current snapshot
    const { stdout } = await execFileAsync(
      CONTAINER_RUNTIME_BIN,
      [
        'stats',
        id,
        '--no-stream',
        '--format',
        '{"id":"{{.ID}}", "name":"{{.Name}}", "cpu_percent":"{{.CPUPerc}}", "memory_usage":"{{.MemUsage}}", "memory_percent":"{{.MemPerc}}"}',
      ],
      { encoding: 'utf-8' },
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length > 0) {
      return JSON.parse(lines[0]);
    }
    return null;
  } catch (err) {
    logger.debug(
      { err, id },
      'Failed to get container stats - container might be dead',
    );
    return null;
  }
}

/** Perform an action on a container (start, stop, restart) */
export async function actionContainer(
  id: string,
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  try {
    await execFileAsync(CONTAINER_RUNTIME_BIN, [action, id]);
    logger.info({ id, action }, `Container action successful`);
  } catch (err) {
    logger.error({ id, action, err }, `Failed to perform container action`);
    throw err;
  }
}

/** Stream logs from a container */
export function streamContainerLogs(
  id: string,
  onData: (data: string) => void,
  onError: (err: Error) => void,
): ChildProcess {
  if (!id) {
    throw new Error('Container ID is required for log streaming');
  }
  const proc = spawn(CONTAINER_RUNTIME_BIN, [
    'logs',
    '--tail',
    '100',
    '-f',
    id,
  ]);

  proc.stdout.on('data', (data) => {
    onData(data.toString());
  });

  proc.stderr.on('data', (data) => {
    // Docker logs sends both stdout and stderr depending on how the app logs
    // so we just pass standard error to the same onData callback
    onData(data.toString());
  });

  proc.on('error', (err) => {
    onError(err);
  });

  return proc;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, ['info'], {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Container runtime failed to start                      ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without a container runtime. To fix:        ║',
    );
    console.error(
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoCrew                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill and remove stale swarm worker containers. */
export function cleanupWorkers(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      [
        'ps',
        '-a',
        '--filter',
        'name=NanoCrew-swarm-',
        '--format',
        '{{.Names}}',
      ],
      { encoding: 'utf-8' },
    );
    const workers = output.trim().split('\n').filter(Boolean);
    for (const name of workers) {
      try {
        // Force stop and remove
        execFileSync(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], {
          stdio: 'pipe',
        });
      } catch {
        /* ignore */
      }
    }
    if (workers.length > 0) {
      logger.info(
        { count: workers.length },
        'Cleaned up stale worker containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up worker containers');
  }
}

/** Kill orphaned NanoCrew containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=NanoCrew-', '--format', '{{.Names}}'],
      { encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      if (name.includes('orchestrator')) continue;
      try {
        execFileSync(CONTAINER_RUNTIME_BIN, ['stop', name], { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
