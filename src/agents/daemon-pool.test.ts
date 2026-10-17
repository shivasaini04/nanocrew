/**
 * The daemon pool's one job that nobody was checking: do not kill a container that is
 * currently doing work.
 *
 * `lastUsed` is stamped when a request is written to the daemon's stdin and (before this)
 * never again, so a cycle that simply ran longer than IDLE_TTL_MS looked progressively
 * more idle the harder it was working. Found 2026-09-09 on Crawler a live cycle: a
 * LinkedIn sweep is 353 requests at a 3s crawl delay — 17.6 minutes of deliberate sleeping
 * against a 10 minute TTL, so it could never survive. It was evicted at 10m24s, fell
 * through to the one-shot path, and re-ran the entire sweep from turn zero.
 *
 * The pool spawns real containers, so these tests drive the eviction logic against fake
 * daemons injected into the pool's map — the sweeper and the cap are the code under test,
 * not the container plumbing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { DaemonPool } from './daemon-pool.js';

interface FakeDaemon {
  agentId: string;
  containerName: string;
  lastUsed: number;
  busy: boolean;
  exited: boolean;
  kill: () => void;
}

const IDLE_TTL_MS = 10 * 60 * 1000;
const SWEEP_MS = 60 * 1000;

function fakeDaemon(
  agentId: string,
  over: Partial<FakeDaemon> = {},
): FakeDaemon {
  return {
    agentId,
    containerName: `NanoCrew-daemon-${agentId}`,
    lastUsed: Date.now(),
    busy: false,
    exited: false,
    kill: vi.fn(),
    ...over,
  };
}

/** The pool's private innards, which is where the eviction policy lives. */
function daemonsOf(pool: DaemonPool): Map<string, FakeDaemon> {
  return (pool as unknown as { daemons: Map<string, FakeDaemon> }).daemons;
}

function startSweeper(pool: DaemonPool): void {
  (pool as unknown as { startSweeper: () => void }).startSweeper();
}

describe('idle sweeper', () => {
  let pool: DaemonPool;

  beforeEach(() => {
    vi.useFakeTimers();
    pool = new DaemonPool();
  });

  afterEach(() => {
    pool.shutdown();
    vi.useRealTimers();
  });

  it('does not evict a daemon that is mid-request, however long it has been running', () => {
    // The exact shape of the bug: stamped long ago, still working.
    const d = fakeDaemon('busy1', {
      lastUsed: Date.now() - IDLE_TTL_MS * 3,
      busy: true,
    });
    daemonsOf(pool).set(d.agentId, d);

    startSweeper(pool);
    vi.advanceTimersByTime(SWEEP_MS * 5);

    expect(daemonsOf(pool).has('busy1')).toBe(true);
    expect(d.kill).not.toHaveBeenCalled();
  });

  it('still evicts a genuinely idle daemon past the TTL', () => {
    const d = fakeDaemon('idle1', {
      lastUsed: Date.now() - IDLE_TTL_MS - 1,
      busy: false,
    });
    daemonsOf(pool).set(d.agentId, d);

    startSweeper(pool);
    vi.advanceTimersByTime(SWEEP_MS);

    expect(daemonsOf(pool).has('idle1')).toBe(false);
    expect(d.kill).toHaveBeenCalled();
  });

  it('keeps a fresh idle daemon warm', () => {
    const d = fakeDaemon('fresh', { lastUsed: Date.now(), busy: false });
    daemonsOf(pool).set(d.agentId, d);

    startSweeper(pool);
    vi.advanceTimersByTime(SWEEP_MS);

    expect(daemonsOf(pool).has('fresh')).toBe(true);
  });

  it('evicts the idle one and spares the busy one in the same pass', () => {
    const busy = fakeDaemon('busy2', {
      lastUsed: Date.now() - IDLE_TTL_MS * 2,
      busy: true,
    });
    const idle = fakeDaemon('idle2', {
      lastUsed: Date.now() - IDLE_TTL_MS * 2,
      busy: false,
    });
    daemonsOf(pool).set(busy.agentId, busy);
    daemonsOf(pool).set(idle.agentId, idle);

    startSweeper(pool);
    vi.advanceTimersByTime(SWEEP_MS);

    expect(daemonsOf(pool).has('busy2')).toBe(true);
    expect(daemonsOf(pool).has('idle2')).toBe(false);
  });

  it('a daemon that finishes its work becomes evictable again', () => {
    const d = fakeDaemon('finisher', {
      lastUsed: Date.now() - IDLE_TTL_MS * 2,
      busy: true,
    });
    daemonsOf(pool).set(d.agentId, d);

    startSweeper(pool);
    vi.advanceTimersByTime(SWEEP_MS);
    expect(daemonsOf(pool).has('finisher')).toBe(true);

    // Request done: no longer busy, and its last activity is still old.
    d.busy = false;
    vi.advanceTimersByTime(SWEEP_MS);

    expect(daemonsOf(pool).has('finisher')).toBe(false);
  });
});

describe('LRU cap', () => {
  let pool: DaemonPool;

  beforeEach(() => {
    pool = new DaemonPool();
  });

  function enforceCap(): void {
    (pool as unknown as { enforceCap: () => void }).enforceCap();
  }

  it('evicts the least-recently-used idle daemon to make room', () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const d = fakeDaemon(`a${i}`, { lastUsed: now - (4 - i) * 1000 });
      daemonsOf(pool).set(d.agentId, d);
    }

    enforceCap();

    expect(daemonsOf(pool).has('a0')).toBe(false); // oldest goes
    expect(daemonsOf(pool).has('a3')).toBe(true);
  });

  it('never sacrifices a busy daemon to the cap, even when it is the oldest', () => {
    const now = Date.now();
    const oldestBusy = fakeDaemon('oldest-busy', {
      lastUsed: now - 99_000,
      busy: true,
    });
    daemonsOf(pool).set(oldestBusy.agentId, oldestBusy);
    for (let i = 1; i < 4; i++) {
      const d = fakeDaemon(`b${i}`, { lastUsed: now - (4 - i) * 1000 });
      daemonsOf(pool).set(d.agentId, d);
    }

    enforceCap();

    expect(daemonsOf(pool).has('oldest-busy')).toBe(true);
    expect(oldestBusy.kill).not.toHaveBeenCalled();
  });

  it('runs over cap rather than killing work when every daemon is busy', () => {
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      const d = fakeDaemon(`c${i}`, { lastUsed: now - i * 1000, busy: true });
      daemonsOf(pool).set(d.agentId, d);
    }

    enforceCap();

    // A warm container above the cap is cheap; a destroyed 20-minute sweep is not.
    expect(daemonsOf(pool).size).toBe(4);
  });
});
