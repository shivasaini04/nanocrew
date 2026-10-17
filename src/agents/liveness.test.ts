import { describe, expect, it } from 'vitest';
import { Liveness } from './liveness.js';

const MIN = 60_000;

function clockAt(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('Liveness', () => {
  it('never ends a cycle that keeps producing output, however long it runs', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: 30 * MIN, maxMs: 0 },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    // 3 days of work, one line every 10 minutes.
    for (let i = 0; i < 3 * 24 * 6; i++) {
      c.advance(10 * MIN);
      live.touch();
      live.check();
    }
    expect(dead).toEqual([]);
    live.stop();
  });

  it('ends a cycle that goes silent for longer than idleMs', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: 30 * MIN, maxMs: 0 },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    c.advance(29 * MIN);
    live.check();
    expect(dead).toEqual([]);
    c.advance(2 * MIN);
    live.check();
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatch(/went silent for 31 min/);
  });

  it('fires once, then stays quiet', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: MIN, maxMs: 0 },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    c.advance(5 * MIN);
    live.check();
    live.check();
    c.advance(5 * MIN);
    live.check();
    expect(dead).toHaveLength(1);
  });

  it('honours an optional hard ceiling even while output keeps coming', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: 30 * MIN, maxMs: 120 * MIN },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    for (let i = 0; i < 12; i++) {
      c.advance(10 * MIN);
      live.touch();
      live.check();
    }
    expect(dead).toEqual([]);
    c.advance(MIN);
    live.touch();
    live.check();
    expect(dead).toEqual(['ran past its 120-minute limit']);
  });

  it('does nothing after stop()', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: MIN, maxMs: MIN },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    live.stop();
    c.advance(60 * MIN);
    live.check();
    expect(dead).toEqual([]);
  });

  it('with both limits 0, never fires', () => {
    const c = clockAt();
    const dead: string[] = [];
    const live = new Liveness(
      { idleMs: 0, maxMs: 0 },
      (w) => dead.push(w),
      c.now,
      1e9,
    );
    c.advance(365 * 24 * 60 * MIN);
    live.check();
    expect(dead).toEqual([]);
    live.stop();
  });
});
