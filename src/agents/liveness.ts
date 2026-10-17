/**
 * Ends a cycle that has gone silent — not one that is merely long.
 *
 * A working agent writes a line on every step (a model reply, a tool call, a progress event),
 * so silence for `idleMs` means a wedged process. There is no wall-clock limit unless `maxMs`
 * is set: an agent may work for hours or days. Before 2026-09-30 every cycle died at
 * CONTAINER_TIMEOUT (50 minutes on prod) however much it was still doing — a single agent
 * researching 41 states was cut off twice mid-work.
 */
export interface LivenessLimits {
  /** No output at all for this long ends the cycle. 0 = never. */
  idleMs: number;
  /** A hard ceiling on wall time. 0 = none. */
  maxMs: number;
}

export class Liveness {
  private last: number;
  private readonly started: number;
  private readonly timer: NodeJS.Timeout;
  private done = false;

  constructor(
    private readonly limits: LivenessLimits,
    private readonly onDead: (reason: string) => void,
    private readonly now: () => number = () => Date.now(),
    checkEveryMs = 15_000,
  ) {
    this.started = this.last = this.now();
    this.timer = setInterval(() => this.check(), checkEveryMs);
    this.timer.unref?.();
  }

  /** Any output is proof of life. */
  touch(): void {
    this.last = this.now();
  }

  /** Public for tests; the interval calls it. */
  check(): void {
    if (this.done) return;
    const t = this.now();
    if (this.limits.idleMs > 0 && t - this.last > this.limits.idleMs) {
      this.fire(
        `went silent for ${Math.round((t - this.last) / 60_000)} min with no output at all`,
      );
    } else if (this.limits.maxMs > 0 && t - this.started > this.limits.maxMs) {
      this.fire(
        `ran past its ${Math.round(this.limits.maxMs / 60_000)}-minute limit`,
      );
    }
  }

  stop(): void {
    this.done = true;
    clearInterval(this.timer);
  }

  private fire(reason: string): void {
    this.stop();
    this.onDead(reason);
  }
}
