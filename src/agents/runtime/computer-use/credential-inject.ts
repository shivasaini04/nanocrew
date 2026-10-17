/**
 * Credential injection for browser automation.
 *
 * Steps can include `credentialRef: "github:password"` to pull a stored credential
 * at execution time. The value is injected via Playwright fill() and never appears
 * in the action log or tool result.
 *
 * Credentials are stored under key "browser:{service}" in the credential store,
 * e.g. store("browser:github", { username: "user@example.com", password: "secret" }).
 */
import { credentialManager } from '../../credential-manager.js';

/**
 * Resolve a credentialRef string ("service:field") to its plaintext value.
 * Returns null if the credential is not found.
 */
export async function resolveCredentialRef(
  ref: string,
): Promise<string | null> {
  const colonIdx = ref.indexOf(':');
  if (colonIdx === -1) return null;

  const service = ref.slice(0, colonIdx).trim();
  const field = ref.slice(colonIdx + 1).trim();

  if (!service || !field) return null;

  try {
    const stored = credentialManager.get(`browser:${service}`);
    if (!stored) return null;
    return stored[field] ?? null;
  } catch {
    return null;
  }
}

/** True if a step references a credential that should be injected. */
export function hasCredentialRef(ref: string | undefined): ref is string {
  return typeof ref === 'string' && ref.includes(':');
}
