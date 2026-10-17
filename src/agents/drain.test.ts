/**
 * Stage 64 phase 3 — a deploy waits for running cycles, and a cut run a person asked for
 * comes back once.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetDrainForTest,
  decideResume,
  isDraining,
  RESUME_MAX_AGE_MS,
  startDraining,
  waitForIdle,
} from './drain.js';

afterEach(() => _resetDrainForTest());

describe('waitForIdle', () => {
  it('returns as soon as nothing is executing', async () => {
    let running = 2;
    setTimeout(() => {
      running = 0;
    }, 30);
    const r = await waitForIdle(() => running, 5_000, 5);
    expect(r.remaining).toBe(0);
    expect(r.waitedMs).toBeLessThan(1_000);
  });

  it('gives up at the deadline and says how many were still running', async () => {
    const r = await waitForIdle(() => 1, 60, 5);
    expect(r.remaining).toBe(1);
    expect(r.waitedMs).toBeGreaterThanOrEqual(60);
  });

  it('nothing running: no wait at all', async () => {
    const r = await waitForIdle(() => 0, 5_000, 5);
    expect(r).toEqual({ remaining: 0, waitedMs: expect.any(Number) });
    expect(r.waitedMs).toBeLessThan(50);
  });
});

describe('draining flag', () => {
  it('off until shutdown starts it', () => {
    expect(isDraining()).toBe(false);
    startDraining();
    expect(isDraining()).toBe(true);
  });
});

describe('decideResume', () => {
  const now = Date.parse('2026-10-01T10:00:00Z');
  const recent = new Date(now - 10 * 60_000).toISOString();

  it('a run a person asked for is resumed', () => {
    expect(
      decideResume({ human_requested: 1, started_at: recent }, 0, now),
    ).toBe(true);
  });

  it('a scheduled run is not — it comes round again on its own', () => {
    expect(
      decideResume({ human_requested: 0, started_at: recent }, 0, now),
    ).toBe(false);
  });

  it('a run older than the limit is not resurrected', () => {
    const old = new Date(now - RESUME_MAX_AGE_MS - 60_000).toISOString();
    expect(
      decideResume({ human_requested: true, started_at: old }, 0, now),
    ).toBe(false);
  });

  it('restarts looping (two cuts already in the window) stop the resume', () => {
    expect(
      decideResume({ human_requested: 1, started_at: recent }, 1, now),
    ).toBe(true);
    expect(
      decideResume({ human_requested: 1, started_at: recent }, 2, now),
    ).toBe(false);
  });
});
