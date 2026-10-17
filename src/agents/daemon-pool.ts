/**
 * DaemonPool — Stage 21 Phase 2b.
 *
 * Keeps a warm, long-lived nanobot container ("daemon") per agent so cycles don't
 * pay the ~17s cold-start (container spawn + litellm import) every time. A request
 * is one JSON line written to the daemon's stdin; the response is everything up to
 * the per-request `REQUEST_DONE` sentinel the adapter emits.
 *
 * Scope (Phase 2b): only agent-private cycles (no project/repo mounts), so a daemon's
 * mounts are stable for its whole life. Project/repo cycles keep the one-shot path.
 *
 * Lifecycle: lazy start on first request, reuse while warm, idle-evict after a TTL,
 * LRU-evict above a pool cap. A failed/exited daemon is torn down so the next request
 * restarts fresh.
 */
import { spawn, execFile, type ChildProcess } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { logger } from '../logger.js';
import {
  tryAcquireSpawnSlot,
  waitForSpawnSlot,
  releaseSpawnSlotAfterSettle,
} from '../container-spawn-limiter.js';
import { Liveness, type LivenessLimits } from './liveness.js';

const PROGRESS_PREFIX = 'NANOBOT_PROGRESS:';
const REQUEST_DONE = '---NanoCrew_REQUEST_DONE---';

const IDLE_TTL_MS = Number(
  process.env.NANOBOT_DAEMON_IDLE_TTL_MS ?? 10 * 60 * 1000,
); // 10 min
const MAX_WARM = Number(process.env.NANOBOT_DAEMON_MAX ?? 4);

interface ActiveRequest {
  raw: string;
  onProgress?: (line: string) => void;
  resolve: (raw: string) => void;
  reject: (err: Error) => void;
  live: Liveness;
}

/** One warm container plus its request plumbing. Requests are serialized. */
class Daemon {
  readonly agentId: string;
  readonly containerName: string;
  private proc: ChildProcess;
  private lineBuf = '';
  private stdoutDecoder = new StringDecoder('utf8');
  private active: ActiveRequest | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  exited = false;
  lastUsed = Date.now();

  /** Whether a request is in flight right now. "Idle" must mean idle — see the sweeper. */
  get busy(): boolean {
    return this.active !== null;
  }

  constructor(agentId: string, containerName: string, args: string[]) {
    this.agentId = agentId;
    this.containerName = containerName;
    this.proc = spawn(CONTAINER_RUNTIME_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (d: Buffer) =>
      this.onData(this.stdoutDecoder.write(d)),
    );
    this.proc.stderr!.on('data', (d: Buffer) => {
      this.active?.live.touch();
      const line = d.toString('utf8').trim();
      if (line) logger.debug({ agentId, container: containerName }, line);
    });
    this.proc.on('close', (code) => {
      this.exited = true;
      this.active?.live.stop();
      this.active?.reject(
        new Error(`daemon exited (code ${code}) mid-request`),
      );
      this.active = null;
    });
    this.proc.on('error', (err) => {
      this.exited = true;
      this.active?.live.stop();
      this.active?.reject(new Error(`daemon spawn error: ${err.message}`));
      this.active = null;
    });
  }

  private onData(chunk: string): void {
    this.lineBuf += chunk;
    const lines = this.lineBuf.split('\n');
    this.lineBuf = lines.pop() ?? '';
    for (const line of lines) {
      const a = this.active;
      if (!a) continue;
      // Any output is proof of life. Without this, `lastUsed` keeps the timestamp from
      // when the request was written to stdin, so a working daemon looks progressively
      // more idle the harder it is working.
      this.lastUsed = Date.now();
      a.live.touch();
      if (line.startsWith(PROGRESS_PREFIX)) {
        a.onProgress?.(line);
        continue;
      }
      if (line.trim() === REQUEST_DONE) {
        a.live.stop();
        this.active = null;
        a.resolve(a.raw);
        continue;
      }
      a.raw += line + '\n';
    }
  }

  /**
   * Serialized: one request at a time. Resolves with the raw response text. No wall-clock
   * limit unless `limits.maxMs` is set — a request ends when it finishes, or when the daemon
   * goes silent for `limits.idleMs` (liveness.ts).
   */
  request(
    payloadStr: string,
    onProgress: ((line: string) => void) | undefined,
    limits: LivenessLimits,
  ): Promise<string> {
    const run = () =>
      new Promise<string>((resolve, reject) => {
        if (this.exited) return reject(new Error('daemon exited'));
        const live = new Liveness(limits, (why) => {
          this.active = null;
          reject(new Error(`daemon request ${why}`));
        });
        this.active = { raw: '', onProgress, resolve, reject, live };
        this.lastUsed = Date.now();
        try {
          this.proc.stdin!.write(payloadStr + '\n');
        } catch (err) {
          live.stop();
          this.active = null;
          reject(
            new Error(`daemon stdin write failed: ${(err as Error).message}`),
          );
        }
      });
    // chain to serialize; isolate failures so the queue keeps flowing
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  kill(): void {
    this.exited = true;
    try {
      this.proc.stdin?.end();
    } catch {
      /* ignore */
    }
    try {
      this.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // The container has no --rm; remove it by name so a restart can reuse the name.
    execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', this.containerName], () => {
      /* fire-and-forget */
    });
  }
}

export class DaemonPool {
  private daemons = new Map<string, Daemon>();
  private sweeper: NodeJS.Timeout | null = null;

  /**
   * Run a request against the agent's warm daemon (starting/replacing it as needed).
   * `args` is the full `docker run` argv for the (persistent) container; `containerName`
   * must match the `--name` in args so we can `docker rm -f` it on teardown.
   */
  async run(
    agentId: string,
    containerName: string,
    args: string[],
    payloadStr: string,
    onProgress: ((line: string) => void) | undefined,
    limits: LivenessLimits,
  ): Promise<string> {
    let d = this.daemons.get(agentId);
    if (!d || d.exited) {
      d = await this.start(agentId, containerName, args);
    }
    try {
      return await d.request(payloadStr, onProgress, limits);
    } catch (err) {
      // A failed request may mean a wedged/dead daemon — tear it down so the next
      // call gets a clean one.
      this.evict(agentId);
      throw err;
    } finally {
      this.startSweeper();
    }
  }

  private async start(
    agentId: string,
    containerName: string,
    args: string[],
  ): Promise<Daemon> {
    // Clear any stale container holding this name (e.g. after an orchestrator restart),
    // then enforce the pool cap before spawning a fresh one.
    await new Promise<void>((res) =>
      execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName], () => res()),
    );
    this.enforceCap();
    if (!tryAcquireSpawnSlot()) await waitForSpawnSlot();
    const d = new Daemon(agentId, containerName, args);
    releaseSpawnSlotAfterSettle();
    this.daemons.set(agentId, d);
    logger.info({ agentId, containerName }, 'Started warm agent daemon');
    return d;
  }

  private enforceCap(): void {
    if (this.daemons.size < MAX_WARM) return;
    // LRU: evict the least-recently-used daemon(s) down to cap-1 — but only idle ones.
    // The same reasoning as the sweeper: a busy daemon is doing work a cycle is waiting
    // on, and killing it costs that whole cycle. If every daemon is busy, the pool is
    // allowed to run one over cap until one frees up. A warm container above the cap is
    // cheap; a destroyed 20-minute sweep is not.
    const sorted = [...this.daemons.values()]
      .filter((d) => !d.busy)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.daemons.size >= MAX_WARM && sorted.length) {
      this.evict(sorted.shift()!.agentId);
    }
  }

  evict(agentId: string): void {
    const d = this.daemons.get(agentId);
    if (!d) return;
    this.daemons.delete(agentId);
    d.kill();
    logger.info(
      { agentId, container: d.containerName },
      'Evicted agent daemon',
    );
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const [agentId, d] of this.daemons) {
        // Never reap a daemon mid-request. `lastUsed` is stamped when a request is
        // written to stdin, so before this check a cycle that simply took longer than
        // IDLE_TTL_MS was killed *while working* and reported as idle.
        //
        // Found 2026-09-09 on Crawler a live cycle: a LinkedIn sweep is 353 requests
        // at a 3s crawl delay — 17.6 min of deliberate sleeping against a 10 min TTL, so
        // it could never survive. Evicted at 10m24s (the first tick past the TTL), which
        // surfaced as `daemon exited (code null) mid-request` and sent the cycle down the
        // one-shot fallback, re-running the whole thing from turn zero: 33.7 min total and
        // a 429 from LinkedIn, which saw both rounds.
        //
        // A wedged daemon is still cleaned up — its request's liveness watchdog rejects
        // after CYCLE_IDLE_TIMEOUT_MS of silence, and that rejection evicts via run()'s catch.
        if (d.busy) continue;
        if (now - d.lastUsed > IDLE_TTL_MS) this.evict(agentId);
      }
      if (this.daemons.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 60 * 1000);
    this.sweeper.unref?.();
  }

  /** Tear down every daemon (e.g. on shutdown). */
  shutdown(): void {
    for (const agentId of [...this.daemons.keys()]) this.evict(agentId);
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }
}

export const daemonPool = new DaemonPool();
