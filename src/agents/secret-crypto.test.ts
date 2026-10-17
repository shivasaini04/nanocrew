import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import {
  encrypt,
  decrypt,
  decryptWithMigration,
  deriveVaultSecret,
} from './secret-crypto.js';

/**
 * The property worth protecting: setting or changing nanocrew_SECRET_KEY must never make
 * already-stored secrets unreadable. Both stores wrap decrypt in `catch { skip }`, so a
 * broken key does not raise — credentials just silently vanish and agents report "not
 * connected" for no visible reason. These tests exist so that cannot ship.
 */

/** Reproduce a legacy-format value without depending on the module's private helpers. */
function encryptWithSeed(seed: string, plaintext: string): string {
  const key = crypto.createHash('sha256').update(seed).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('secret-crypto', () => {
  it('round-trips with the configured key', () => {
    process.env.nanocrew_SECRET_KEY = 'a-real-production-key';
    expect(decrypt(encrypt('auth_token_value'))).toBe('auth_token_value');
  });

  it('still reads secrets written under the old fallback after a key is set', () => {
    const legacy = encryptWithSeed(
      'nanocrew-secrets-fallback',
      'X_AUTH_TOKEN_VALUE',
    );
    process.env.nanocrew_SECRET_KEY = 'newly-set-key';
    const { plaintext, staleKey } = decryptWithMigration(legacy);
    expect(plaintext).toBe('X_AUTH_TOKEN_VALUE');
    expect(staleKey).toBe(true); // caller re-encrypts on the strength of this
  });

  it('still reads credentials keyed off a since-rotated ANTHROPIC_API_KEY', () => {
    const legacy = encryptWithSeed(
      'sk-ant-old-key',
      JSON.stringify({ api_key: 'apollo123' }),
    );
    process.env.ANTHROPIC_API_KEY = 'sk-ant-old-key';
    process.env.nanocrew_SECRET_KEY = 'newly-set-key';
    expect(JSON.parse(decryptWithMigration(legacy).plaintext)).toEqual({
      api_key: 'apollo123',
    });
  });

  it('reads the old default-seed credentials too', () => {
    const legacy = encryptWithSeed('NanoCrew-default-key', 'hunter_key');
    process.env.nanocrew_SECRET_KEY = 'newly-set-key';
    expect(decryptWithMigration(legacy).plaintext).toBe('hunter_key');
  });

  it('reports staleKey false when the current key opened it, so nothing is rewritten needlessly', () => {
    process.env.nanocrew_SECRET_KEY = 'stable-key';
    expect(decryptWithMigration(encrypt('v')).staleKey).toBe(false);
  });

  it('throws rather than returning garbage when no key fits', () => {
    const alien = encryptWithSeed('a-key-nobody-has', 'secret');
    process.env.nanocrew_SECRET_KEY = 'newly-set-key';
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => decryptWithMigration(alien)).toThrow(/Could not decrypt/);
  });
});

/**
 * Stage 49 phase 2. The effector session vault keyed itself off the per-cycle token
 * (randomBytes(32), revoked at cycle end), so a browser login saved in one cycle was
 * undecryptable in the next and the agent silently started logged out. The seed below
 * replaces it: stable for an agent, derived rather than stored, never in the workspace.
 */
describe('deriveVaultSecret', () => {
  it('is stable across calls, which is the entire point', () => {
    process.env.nanocrew_SECRET_KEY = 'server-master-key';
    // Two cycles of the same agent must derive the same seed, or the session that
    // the first one saved cannot be opened by the second.
    expect(deriveVaultSecret('agent-1')).toBe(deriveVaultSecret('agent-1'));
  });

  it('differs per agent, so one workspace cannot open a sibling agent’s sessions', () => {
    process.env.nanocrew_SECRET_KEY = 'server-master-key';
    expect(deriveVaultSecret('agent-1')).not.toBe(deriveVaultSecret('agent-2'));
  });

  it('changes when the server master key changes', () => {
    process.env.nanocrew_SECRET_KEY = 'key-one';
    const before = deriveVaultSecret('agent-1');
    process.env.nanocrew_SECRET_KEY = 'key-two';
    // Rotating the master key orphans saved sessions. That is acceptable here in a
    // way it is not for `secrets`/`credentials`: a session is a cache of a login,
    // so the worst case is the agent logs in again.
    expect(deriveVaultSecret('agent-1')).not.toBe(before);
  });

  it('never returns the master key itself', () => {
    process.env.nanocrew_SECRET_KEY = 'server-master-key';
    const seed = deriveVaultSecret('agent-1');
    expect(seed).not.toContain('server-master-key');
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
  });
});
