/**
 * Secret scoping — the three-tier store behind Account → Connections.
 *
 * The owner tier is what lets a customer connect their own account once instead of
 * re-entering it per agent, and it is the only correct home for a customer-specific
 * value (the alternatives are per-agent duplication or `global`, which leaks to every
 * other tenant). It had no tests, and `list` had shipped handling only two of the three
 * scopes: an owner scope fell through a cast to `{ agentId }` and produced the prefix
 * `agent:undefined:`. Owner secrets could be written and resolved but never enumerated —
 * which surfaces as an empty Connections page, not an error, so nothing would have
 * pointed at the store.
 *
 * config.ts computes DATA_DIR from the project root and does not read an env var, so the
 * module is mocked here the same way agent-handoff.test.ts does it.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT, TMP_DATA } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const _fs = require('fs') as typeof import('fs');
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  const root = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'secrets-'));
  return { TMP_ROOT: root, TMP_DATA: _path.join(root, 'data') };
});

vi.mock('../config.js', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  DATA_DIR: TMP_DATA,
}));

const { SecretsManager } = await import('./secrets-manager.js');

const OWNER = 'owner-1';
const OTHER_OWNER = 'owner-2';
const AGENT = 'agent-1';

let secrets: InstanceType<typeof SecretsManager>;

beforeEach(() => {
  fs.rmSync(path.join(TMP_DATA, 'secrets.enc'), { force: true });
  secrets = new SecretsManager();
});

afterAll(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ─── list, per scope ─────────────────────────────────────────────────────────

describe('list', () => {
  it('enumerates owner-scoped secrets', () => {
    // The regression: this returned [] because the prefix was `agent:undefined:`.
    secrets.set({ ownerId: OWNER }, 'XERO_ACCESS_TOKEN', 'tok-123');

    const names = secrets.list({ ownerId: OWNER }).map((s) => s.name);

    expect(names).toEqual(['XERO_ACCESS_TOKEN']);
  });

  it('keeps each scope separate', () => {
    secrets.set('global', 'BRAVE_API_KEY', 'platform-value');
    secrets.set({ ownerId: OWNER }, 'APOLLO_API_KEY', 'owner-value');
    secrets.set({ agentId: AGENT }, 'X_AUTH_TOKEN', 'agent-value');

    expect(secrets.list('global').map((s) => s.name)).toEqual([
      'BRAVE_API_KEY',
    ]);
    expect(secrets.list({ ownerId: OWNER }).map((s) => s.name)).toEqual([
      'APOLLO_API_KEY',
    ]);
    expect(secrets.list({ agentId: AGENT }).map((s) => s.name)).toEqual([
      'X_AUTH_TOKEN',
    ]);
  });

  it("does not leak one customer's connections to another", () => {
    secrets.set({ ownerId: OWNER }, 'XERO_ACCESS_TOKEN', 'mine');

    expect(secrets.list({ ownerId: OTHER_OWNER })).toEqual([]);
  });

  it('masks the value, exposing only the last four characters', () => {
    secrets.set({ ownerId: OWNER }, 'XERO_ACCESS_TOKEN', 'abcdefghij');

    const [entry] = secrets.list({ ownerId: OWNER });

    expect(entry.masked).toBe('••••ghij');
    expect(entry.masked).not.toContain('abcdef');
  });
});

// ─── getAll resolution ───────────────────────────────────────────────────────

describe('getAll resolution order', () => {
  it('is most-specific-wins: platform → owner → agent', () => {
    secrets.set('global', 'TOKEN', 'platform');
    secrets.set({ ownerId: OWNER }, 'TOKEN', 'owner');
    secrets.set({ agentId: AGENT }, 'TOKEN', 'agent');

    expect(secrets.getAll(AGENT, OWNER).TOKEN).toBe('agent');
  });

  it('falls back to the owner value when the agent has no override', () => {
    secrets.set('global', 'TOKEN', 'platform');
    secrets.set({ ownerId: OWNER }, 'TOKEN', 'owner');

    expect(secrets.getAll(AGENT, OWNER).TOKEN).toBe('owner');
  });

  it('ignores the owner tier when no ownerId is passed', () => {
    // Existing callers omit ownerId; passing it is what activates the tier.
    secrets.set('global', 'TOKEN', 'platform');
    secrets.set({ ownerId: OWNER }, 'TOKEN', 'owner');

    expect(secrets.getAll(AGENT).TOKEN).toBe('platform');
  });

  it("never resolves another owner's value", () => {
    secrets.set({ ownerId: OTHER_OWNER }, 'XERO_ACCESS_TOKEN', 'not-yours');

    expect(secrets.getAll(AGENT, OWNER).XERO_ACCESS_TOKEN).toBeUndefined();
  });
});

// ─── delete ──────────────────────────────────────────────────────────────────

describe('delete', () => {
  it('removes an owner secret without touching the same name at another scope', () => {
    secrets.set('global', 'TOKEN', 'platform');
    secrets.set({ ownerId: OWNER }, 'TOKEN', 'owner');

    secrets.delete({ ownerId: OWNER }, 'TOKEN');

    expect(secrets.list({ ownerId: OWNER })).toEqual([]);
    expect(secrets.getAll(AGENT, OWNER).TOKEN).toBe('platform');
  });
});

// ─── name validation ─────────────────────────────────────────────────────────

describe('set', () => {
  it('rejects names that are not env-var shaped', () => {
    // Secrets are injected as env vars, so a lowercase or hyphenated name would
    // produce a variable the container cannot reference.
    expect(() => secrets.set({ ownerId: OWNER }, 'xero-token', 'v')).toThrow(
      /Invalid secret name/,
    );
  });

  it('accepts an uppercase env-var name', () => {
    expect(() =>
      secrets.set({ ownerId: OWNER }, 'XERO_ACCESS_TOKEN', 'v'),
    ).not.toThrow();
  });
});
