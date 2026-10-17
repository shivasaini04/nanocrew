import { describe, it, expect } from 'vitest';
import {
  requiredEnvNamesFor,
  isServiceConnectedViaSecrets,
  CREDENTIAL_ENV_MAP,
} from './credential-catalog.js';

/**
 * The property that matters: a credential supplied through secrets — the only path a
 * customer can reach, since the credentials API is admin-only — must read as connected.
 * Getting this wrong reports working agents as broken, which is what shipped before.
 */
describe('requiredEnvNamesFor', () => {
  it('returns only the fields a service cannot work without', () => {
    // x runs fine without Browserbase; it just uses the server's own IP.
    expect(requiredEnvNamesFor('x')).toEqual(['X_AUTH_TOKEN', 'X_CT0']);
    expect(requiredEnvNamesFor('apollo')).toEqual(['APOLLO_API_KEY']);
    expect(requiredEnvNamesFor('linkedin')).toEqual([
      'LINKEDIN_SESSION_COOKIE',
    ]);
  });

  it('is empty for an unknown service rather than throwing', () => {
    expect(requiredEnvNamesFor('nope')).toEqual([]);
  });

  it('never names an env var the injector does not know how to set', () => {
    for (const svc of Object.keys(CREDENTIAL_ENV_MAP)) {
      const known = new Set(Object.values(CREDENTIAL_ENV_MAP[svc]));
      for (const env of requiredEnvNamesFor(svc))
        expect(known.has(env)).toBe(true);
    }
  });
});

describe('isServiceConnectedViaSecrets', () => {
  it('is connected when every required env var is present', () => {
    expect(
      isServiceConnectedViaSecrets('x', { X_AUTH_TOKEN: 'a', X_CT0: 'b' }),
    ).toBe(true);
  });

  it('is not connected when one is missing', () => {
    expect(isServiceConnectedViaSecrets('x', { X_AUTH_TOKEN: 'a' })).toBe(
      false,
    );
  });

  it('ignores the optional Browserbase pair', () => {
    expect(
      isServiceConnectedViaSecrets('x', {
        X_AUTH_TOKEN: 'a',
        X_CT0: 'b',
        BROWSERBASE_API_KEY: '',
      }),
    ).toBe(true);
  });

  it('treats an empty value as absent, not as configured', () => {
    expect(
      isServiceConnectedViaSecrets('x', { X_AUTH_TOKEN: 'a', X_CT0: '' }),
    ).toBe(false);
  });

  it('is never connected for an unknown service', () => {
    expect(isServiceConnectedViaSecrets('nope', { ANYTHING: 'x' })).toBe(false);
  });
});
