import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shouldFallBackToOneShot } from './daemon-fallback.js';

describe('warm daemon → one-shot fallback', () => {
  it.each([
    'daemon exited (code 137) mid-request',
    'daemon exited',
    'daemon spawn error: ENOENT',
    'daemon stdin write failed: EPIPE',
    'docker: Error response from daemon: Conflict. The container name is already in use',
  ])('re-runs when the daemon itself broke: %s', (msg) => {
    expect(shouldFallBackToOneShot(new Error(msg))).toBe(true);
  });

  // Since 2026-09-30 a request ends on silence (liveness.ts), not on a wall clock. A silent
  // cycle re-run on a fresh one-shot would sit silent a second time.
  it.each([
    'daemon request went silent for 31 min with no output at all',
    'daemon request ran past its 120-minute limit',
    'daemon request timed out after 3000000ms',
  ])('does not re-run a cycle the watchdog ended: %s', (msg) => {
    expect(shouldFallBackToOneShot(new Error(msg))).toBe(false);
  });

  // Crawler a live cycle (2026-09-11): a model error the agent reported was parsed by
  // finalizeOutput inside the daemon try, read as a broken daemon, and the whole task
  // re-ran from scratch for 50 minutes. The parse must sit outside that try.
  it('parses the daemon result outside the fallback try', () => {
    const src = readFileSync(
      join(__dirname, 'nanobot-cycle-runner.ts'),
      'utf-8',
    );
    const call = src.indexOf('raw = await daemonPool.run(');
    const catchAt = src.indexOf('} catch (err) {', call);
    const parse = src.indexOf('return finalizeOutput(raw,', call);
    expect(call).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(catchAt);
    expect(src.slice(catchAt, parse)).toContain('if (raw !== null)');
  });

  // Same day: the timed-out one-shot kept running detached because only the docker CLI
  // was killed. The timeout has to remove the container itself.
  it('removes a timed-out one-shot container by name, not just its docker client', () => {
    const src = readFileSync(
      join(__dirname, 'nanobot-cycle-runner.ts'),
      'utf-8',
    );
    const at = src.indexOf('reject(new Error(`Agent container ${why}`))');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(src.lastIndexOf('new Liveness(', at), at);
    expect(block).toContain(
      "execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', containerName]",
    );
  });
});
