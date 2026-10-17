import { afterEach, describe, expect, it, vi } from 'vitest';

describe('cycle token lifetime', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // Since 2026-09-30 a cycle has no wall-clock limit (liveness.ts), so a token that expired
  // at the old 50-minute container timeout would cut a long cycle off from every token-gated
  // call — credentials, self-management, the model relay — while it was still working.
  it('lives 30 days when cycles have no ceiling (the default)', async () => {
    vi.stubEnv('CYCLE_MAX_MS', '');
    const { TOKEN_TTL_MS } = await import('./cycle-token.js');
    expect(TOKEN_TTL_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('outlives an optional hard ceiling by 10 minutes', async () => {
    vi.stubEnv('CYCLE_MAX_MS', '7200000');
    const { TOKEN_TTL_MS } = await import('./cycle-token.js');
    expect(TOKEN_TTL_MS).toBe(7200000 + 10 * 60 * 1000);
  });

  it('no longer follows CONTAINER_TIMEOUT', async () => {
    vi.stubEnv('CYCLE_MAX_MS', '');
    vi.stubEnv('CONTAINER_TIMEOUT', '3000000');
    const { TOKEN_TTL_MS } = await import('./cycle-token.js');
    expect(TOKEN_TTL_MS).toBeGreaterThan(3000000 + 10 * 60 * 1000);
  });
});
