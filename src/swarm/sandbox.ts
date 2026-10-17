/**
 * Stage 57 phase 4 — the `command` verifier's sandbox.
 *
 * The boss writes a check (`pytest -q`, `node test.js`); this runs it on a COPY of the
 * worker's files, in a throwaway container with no network, no credentials, no
 * capabilities, and limits on memory, CPU, processes and time. Never on the server, and
 * never a command the worker wrote: a worker that fakes "all tests passed" in a log file
 * gains nothing, because the log is not read — the tests are run again (docs 16 B5).
 *
 * The files are mounted read-only and copied into a tmpfs, so a check that writes caches
 * or build output works, and nothing it does reaches the worker's folder.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CONTAINER_IMAGE } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { checkFileNameProblem } from './spec.js';
import { workerRoot } from './worker.js';

/** Where the boss's test files are written, inside the attempt folder, after the worker has exited. */
export const CHECK_FILES_DIR = '.nanocrew-checks';

/**
 * Write the boss's test files for this attempt. Whatever the worker left at this path is
 * removed first — a worker cannot plant its own "tests" there. The worker's container has
 * exited by now, so nothing writes to the folder while the check runs.
 */
export function writeCheckFiles(
  attemptId: string,
  files: Record<string, string> | undefined,
): boolean {
  const dir = path.join(workerRoot(attemptId), CHECK_FILES_DIR);
  fs.rmSync(dir, { recursive: true, force: true });
  if (!files || !Object.keys(files).length) return false;
  for (const [name, content] of Object.entries(files)) {
    if (checkFileNameProblem(name))
      throw new Error(`bad check file name: ${name}`);
    const dest = path.resolve(dir, name);
    if (!dest.startsWith(path.resolve(dir) + path.sep))
      throw new Error(`bad check file name: ${name}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }
  return true;
}

export interface CommandResult {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

const MAX_CONCURRENT = 2;
const OUTPUT_TAIL = 4000;
let running = 0;
const queue: Array<() => void> = [];

async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  running++;
  return () => {
    running--;
    queue.shift()?.();
  };
}

/** Container path → the path the Docker daemon sees (the orchestrator runs Docker-out-of-Docker). */
function hostPath(p: string): string {
  const root = process.env.HOST_PROJECT_ROOT;
  if (root && p.startsWith(process.cwd()))
    return `${root}/${p.slice(process.cwd().length).replace(/^[\\/]/, '')}`.replace(
      /\\/g,
      '/',
    );
  return p;
}

export function sandboxName(attemptId: string): string {
  return `NanoCrew-check-${attemptId}`.slice(0, 120);
}

/**
 * The `docker run` arguments. Exported so the isolation is pinned by a test. With
 * `withCheckFiles`, the boss's test files replace any file of the same name in the copy.
 */
export function sandboxArgs(
  attemptId: string,
  command: string,
  withCheckFiles = false,
): string[] {
  const overlay = withCheckFiles
    ? `cp -r /src/${CHECK_FILES_DIR}/. /work/ || { echo "ERROR could not place the check files"; exit 91; }; `
    : '';
  return [
    'run',
    '--rm',
    '--name',
    sandboxName(attemptId),
    '--network',
    'none',
    // mode=1777: a tmpfs is root's by default, and the check runs as nobody — without it the
    // copy fails and every check reports a missing file (measured on prod, 2026-09-29).
    '--read-only',
    '--tmpfs',
    '/work:rw,exec,size=256m,mode=1777',
    '--tmpfs',
    '/tmp:rw,exec,size=64m,mode=1777',
    '--memory',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '256',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--user',
    '65534:65534',
    '-e',
    'HOME=/tmp',
    '-e',
    'PYTHONDONTWRITEBYTECODE=1',
    '-v',
    `${hostPath(workerRoot(attemptId))}:/src:ro`,
    '-w',
    '/work',
    '--entrypoint',
    'sh',
    CONTAINER_IMAGE,
    // An unreadable scratch file may be skipped; an empty copy is the check failing — never
    // a check run on nothing.
    '-c',
    `cp -r /src/. /work/ 2>/tmp/copy.err; rm -rf /work/sessions /work/.nanocrew /work/${CHECK_FILES_DIR}; [ -n "$(ls -A /work)" ] || { echo "ERROR could not copy the worker's files"; exit 90; }; ${overlay}cd /work && ${command}`,
  ];
}

export async function runCommandInSandbox(
  attemptId: string,
  command: string,
  timeoutMs: number,
  files?: Record<string, string>,
): Promise<CommandResult> {
  if (!/^[A-Za-z0-9-]{1,80}$/.test(attemptId))
    throw new Error(`bad attemptId: ${attemptId}`);
  const release = await slot();
  try {
    const withFiles = writeCheckFiles(attemptId, files);
    return await new Promise<CommandResult>((resolve) => {
      const proc = spawn(
        CONTAINER_RUNTIME_BIN,
        sandboxArgs(attemptId, command, withFiles),
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let out = '';
      const take = (b: Buffer) => {
        out = (out + b.toString('utf-8')).slice(-OUTPUT_TAIL);
      };
      proc.stdout.on('data', take);
      proc.stderr.on('data', take);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        spawn(CONTAINER_RUNTIME_BIN, ['rm', '-f', sandboxName(attemptId)], {
          stdio: 'ignore',
        }).on('error', () => {
          /* gone */
        });
        proc.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut, output: out });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut, output: String(err) });
      });
    });
  } finally {
    release();
  }
}

/** The line that explains a failed check: an `ERROR ...` line if the check wrote one, else its last line. */
export function failureLine(output: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const err = lines.find((l) => /^ERROR\b/.test(l));
  return (err ?? lines.at(-1) ?? 'no output').slice(0, 300);
}
