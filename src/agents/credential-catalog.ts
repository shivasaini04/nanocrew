/**
 * The one place a credential service is described on the TypeScript side.
 *
 * Adding the `x` service required edits in six files, and shipping it still produced a
 * credential with no UI, because the pieces are spread across the runtime, the API, the
 * dashboard and a second copy of this map in Python. This module is the first step of the
 * consolidation in `docs/research/stage37/credentials-architecture.md`: one definition that
 * injection, readiness and (later) the settings form all derive from, instead of four
 * hand-maintained lists that agree only by convention.
 *
 * The Python copy in `container/nanoagent/nanoagent/agent/tools/credentials.py` still
 * exists and still has to match. That duplication is only removable once saving writes
 * env-named secrets directly — the final step of the plan — so for now this is the side
 * that owns the mapping.
 */

/** service → field → env var name injected into the agent container. */
export const CREDENTIAL_ENV_MAP: Record<string, Record<string, string>> = {
  apollo: { api_key: 'APOLLO_API_KEY' },
  gmail: {
    client_id: 'GMAIL_CLIENT_ID',
    client_secret: 'GMAIL_CLIENT_SECRET',
    refresh_token: 'GMAIL_REFRESH_TOKEN',
    email: 'GMAIL_EMAIL',
  },
  twitter: {
    bearer_token: 'TWITTER_BEARER_TOKEN',
    api_key: 'TWITTER_API_KEY',
    api_secret: 'TWITTER_API_SECRET',
  },
  linkedin: { session_cookie: 'LINKEDIN_SESSION_COOKIE' },
  hunter: { api_key: 'HUNTER_API_KEY' },
  database: { connection_string: 'DATABASE_URL' },
  x: {
    auth_token: 'X_AUTH_TOKEN',
    ct0: 'X_CT0',
    browserbase_api_key: 'BROWSERBASE_API_KEY',
    browserbase_project_id: 'BROWSERBASE_PROJECT_ID',
  },
};

/**
 * Fields without which the service cannot work at all. Everything else is optional —
 * `x` runs fine with no Browserbase pair, it just uses the server's own IP, so requiring
 * all four would report a working connection as broken.
 */
const REQUIRED_FIELDS: Record<string, string[]> = {
  apollo: ['api_key'],
  gmail: ['refresh_token'],
  twitter: ['bearer_token'],
  linkedin: ['session_cookie'],
  hunter: ['api_key'],
  database: ['connection_string'],
  x: ['auth_token', 'ct0'],
};

/** Env var names that must be present for `service` to be usable. */
export function requiredEnvNamesFor(service: string): string[] {
  const fields = CREDENTIAL_ENV_MAP[service];
  if (!fields) return [];
  const required = REQUIRED_FIELDS[service] ?? Object.keys(fields);
  return required.map((f) => fields[f]).filter(Boolean);
}

/**
 * Is `service` usable, given an already-resolved secret environment?
 *
 * Deliberately checks the env names rather than the credential store, because a customer
 * can only reach the secrets path — the credentials API is admin-only and platform-wide.
 * Finder is connected to X entirely through per-agent secrets, and any check that consults
 * only `credentialManager` reports it as disconnected while it works perfectly.
 */
export function isServiceConnectedViaSecrets(
  service: string,
  env: Record<string, string>,
): boolean {
  const names = requiredEnvNamesFor(service);
  return names.length > 0 && names.every((n) => !!env[n]);
}
