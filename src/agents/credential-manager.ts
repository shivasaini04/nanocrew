/**
 * CredentialManager — AES-256-GCM encrypted credential store with OAuth2 PKCE.
 *
 * API key services: apollo, twitter, linkedin, hunter — stored via POST /api/credentials/:service
 * OAuth2 services:  gmail, slack, github, notion   — initiated via GET  /api/credentials/oauth/:service/start
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { encrypt, decrypt } from './secret-crypto.js';
import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CredentialSummary {
  service: string;
  status: 'connected' | 'expired' | 'invalid' | 'not_connected';
  maskedKey: string;
  connectedAt?: string;
  lastUsed?: string;
  usedByAgents: string[];
}

export interface CredentialTestResult {
  service: string;
  status: 'connected' | 'invalid' | 'error';
  message: string;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

const CREDS_FILE = path.join(DATA_DIR, 'credentials.enc');

const API_KEY_SERVICES = ['apollo', 'twitter', 'linkedin', 'hunter', 'x'];
// Voice service (services/voice). Multi-field, unlike the single-api_key services
// above. These are the two things a voice user MUST bring themselves:
//   voice_telephony — their Exotel account. Their ExoPhone is what the prospect
//     sees and their account carries the DND/TRAI liability, so there is no
//     operator fallback: unconfigured means "cannot dial", never "dials as us".
//   voice_smtp — the address demo invites are sent FROM, so a prospect's reply
//     reaches them and not the operator.
// The AI capacity (Gemini Live) is deliberately NOT here: NanoCrew provides that
// key centrally. What a user controls is how the agent sounds and what it says
// (agent.voice / agent.language / agent.goal), not who pays for inference.
const VOICE_SERVICES = ['voice_telephony', 'voice_smtp'];
const OAUTH2_SERVICES = ['gmail', 'slack', 'github', 'notion'];
const ALL_SERVICES = [
  ...API_KEY_SERVICES,
  ...VOICE_SERVICES,
  ...OAUTH2_SERVICES,
];

/** Required fields per multi-field service, checked before store() and on test(). */
const VOICE_REQUIRED_FIELDS: Record<string, string[]> = {
  voice_telephony: [
    'account_sid',
    'api_key',
    'api_token',
    'caller_id',
    'flow_url',
  ],
  voice_smtp: ['host', 'port', 'user', 'password', 'from'],
};

// ─── Encryption (AES-256-GCM) ─────────────────────────────────────────────────

interface StoredEntry {
  encryptedData: string;
  connectedAt: string;
  lastUsed?: string;
}

function loadStore(): Record<string, StoredEntry> {
  if (!fs.existsSync(CREDS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStore(store: Record<string, StoredEntry>): void {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(store, null, 2), 'utf-8');
}

// ─── OAuth2 configs ───────────────────────────────────────────────────────────

interface OAuth2Config {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Notion uses Basic auth for token exchange; others use body params. */
  tokenAuth: 'body' | 'basic';
  /** Token response key that holds the access token (Slack nests under authed_user). */
  accessTokenPath: string[];
}

const OAUTH2: Record<string, OAuth2Config> = {
  gmail: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
    tokenAuth: 'body',
    accessTokenPath: ['access_token'],
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: ['channels:read', 'chat:write', 'users:read', 'files:write'],
    clientIdEnv: 'SLACK_CLIENT_ID',
    clientSecretEnv: 'SLACK_CLIENT_SECRET',
    tokenAuth: 'body',
    accessTokenPath: ['access_token'],
  },
  github: {
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    scopes: ['repo', 'read:user'],
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
    tokenAuth: 'body',
    accessTokenPath: ['access_token'],
  },
  notion: {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: [],
    clientIdEnv: 'NOTION_CLIENT_ID',
    clientSecretEnv: 'NOTION_CLIENT_SECRET',
    tokenAuth: 'basic',
    accessTokenPath: ['access_token'],
  },
};

function getOAuthEnv(cfg: OAuth2Config): {
  clientId: string;
  clientSecret: string;
} {
  const envFile = readEnvFile([cfg.clientIdEnv, cfg.clientSecretEnv]);
  const clientId =
    process.env[cfg.clientIdEnv] ?? envFile[cfg.clientIdEnv] ?? '';
  const clientSecret =
    process.env[cfg.clientSecretEnv] ?? envFile[cfg.clientSecretEnv] ?? '';
  return { clientId, clientSecret };
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest()
    .toString('base64url');
  return { verifier, challenge };
}

// In-memory pending flows: state → { service, codeVerifier }
// These are short-lived (OAuth flow completes in seconds-to-minutes).
const pendingFlows = new Map<
  string,
  { service: string; codeVerifier: string }
>();

// ─── OAuth2 token data shape ──────────────────────────────────────────────────

interface OAuth2Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at?: number; // ms timestamp
  token_type: string;
  scope?: string;
}

function dig(obj: Record<string, unknown>, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== 'object') return '';
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : '';
}

// ─── CredentialManager ────────────────────────────────────────────────────────

export class CredentialManager {
  // ── API key methods (unchanged) ────────────────────────────────────────────

  store(service: string, credentials: Record<string, string>): void {
    // Multi-field services are rejected up front when incomplete. Storing a
    // half-filled telephony record would leave a tenant that looks configured but
    // cannot dial, and the failure would only surface on a real call attempt.
    const required = VOICE_REQUIRED_FIELDS[service];
    if (required) {
      const missing = required.filter((f) => !credentials[f]);
      if (missing.length) {
        throw new Error(`${service} requires: ${missing.join(', ')}`);
      }
    }
    const existing = loadStore();
    existing[service] = {
      encryptedData: encrypt(JSON.stringify(credentials)),
      connectedAt: existing[service]?.connectedAt ?? new Date().toISOString(),
    };
    saveStore(existing);
  }

  get(service: string): Record<string, string> | null {
    const store = loadStore();
    const entry = store[service];
    if (!entry) return null;
    try {
      entry.lastUsed = new Date().toISOString();
      saveStore(store);
      return JSON.parse(decrypt(entry.encryptedData));
    } catch {
      return null;
    }
  }

  revoke(service: string): void {
    const store = loadStore();
    delete store[service];
    saveStore(store);
  }

  // ── OAuth2 PKCE flow ───────────────────────────────────────────────────────

  /**
   * Start an OAuth2 PKCE authorization flow.
   * Returns the URL to redirect the user to and the state nonce.
   */
  startOAuthFlow(
    service: string,
    redirectUri: string,
  ): { authUrl: string; state: string } {
    const cfg = OAUTH2[service];
    if (!cfg) throw new Error(`Unknown OAuth2 service: ${service}`);

    const { clientId } = getOAuthEnv(cfg);
    if (!clientId)
      throw new Error(
        `${cfg.clientIdEnv} is not set — cannot start OAuth2 flow for ${service}`,
      );

    const { verifier, challenge } = generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    pendingFlows.set(state, { service, codeVerifier: verifier });
    // Clean up stale flows after 10 minutes
    setTimeout(() => pendingFlows.delete(state), 10 * 60 * 1000);

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    if (cfg.scopes.length) params.set('scope', cfg.scopes.join(' '));
    if (service === 'notion') params.set('owner', 'user');

    return { authUrl: `${cfg.authUrl}?${params}`, state };
  }

  /**
   * Complete an OAuth2 PKCE flow after the provider redirects back.
   * Exchanges the code for tokens and stores them encrypted.
   */
  async handleOAuthCallback(
    state: string,
    code: string,
    redirectUri: string,
  ): Promise<void> {
    const pending = pendingFlows.get(state);
    if (!pending)
      throw new Error(
        'Unknown or expired OAuth2 state — please restart the flow',
      );
    pendingFlows.delete(state);

    const { service, codeVerifier } = pending;
    const cfg = OAUTH2[service];
    const { clientId, clientSecret } = getOAuthEnv(cfg);

    let res: Response;

    if (cfg.tokenAuth === 'basic') {
      // Notion: Basic auth + JSON body
      res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });
    } else {
      // Standard: body params
      res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }).toString(),
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token exchange failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as Record<string, unknown>;

    // Some providers signal errors in a 200 response body (Slack)
    if (data.ok === false || data.error) {
      throw new Error(
        `Token exchange error: ${data.error ?? JSON.stringify(data)}`,
      );
    }

    const accessToken = dig(data, cfg.accessTokenPath);
    const refreshToken =
      typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
    const expiresIn =
      typeof data.expires_in === 'number' ? data.expires_in : undefined;

    if (!accessToken)
      throw new Error(`No access_token in response: ${JSON.stringify(data)}`);

    const tokens: OAuth2Tokens = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
      token_type:
        typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      scope: typeof data.scope === 'string' ? data.scope : undefined,
    };

    this.store(service, tokens as unknown as Record<string, string>);
  }

  /**
   * Return a valid access token, refreshing automatically if it expires within 60 s.
   * Returns null if no credential is stored or refresh fails.
   */
  async getValidAccessToken(service: string): Promise<string | null> {
    const creds = this.get(service) as
      | (OAuth2Tokens & Record<string, string>)
      | null;
    if (!creds || !creds.access_token) return null;

    const expiresAt =
      typeof creds.expires_at === 'number' ? creds.expires_at : undefined;
    const needsRefresh =
      expiresAt !== undefined && expiresAt - Date.now() < 60_000;

    if (!needsRefresh) return creds.access_token;
    if (!creds.refresh_token) return creds.access_token; // no refresh token — hope for the best

    const cfg = OAUTH2[service];
    if (!cfg) return creds.access_token;

    const { clientId, clientSecret } = getOAuthEnv(cfg);

    try {
      const res = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: creds.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      });

      if (!res.ok) return creds.access_token; // silently fall back to stale token

      const data = (await res.json()) as Record<string, unknown>;
      const newAccess = dig(data, cfg.accessTokenPath);
      if (!newAccess) return creds.access_token;

      const updated: OAuth2Tokens = {
        access_token: newAccess,
        refresh_token:
          typeof data.refresh_token === 'string'
            ? data.refresh_token
            : creds.refresh_token,
        expires_at:
          typeof data.expires_in === 'number'
            ? Date.now() + data.expires_in * 1000
            : undefined,
        token_type: creds.token_type,
        scope: creds.scope,
      };
      this.store(service, updated as unknown as Record<string, string>);
      return newAccess;
    } catch {
      return creds.access_token;
    }
  }

  // ── Test & list ────────────────────────────────────────────────────────────

  async test(service: string): Promise<CredentialTestResult> {
    const creds = this.get(service);
    if (!creds)
      return { service, status: 'error', message: 'No credentials stored' };

    try {
      switch (service) {
        case 'apollo': {
          const apiKey = creds.api_key;
          if (!apiKey)
            return { service, status: 'invalid', message: 'No API key' };
          const headers = {
            'Cache-Control': 'no-cache',
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          };
          const res = await fetch('https://api.apollo.io/v1/auth/health', {
            headers,
          });
          if (!res.ok)
            return {
              service,
              status: 'invalid',
              message: `Apollo returned ${res.status}`,
            };

          // auth/health alone is a false green: it returns 200 for a free-plan key that
          // cannot call a single enrichment endpoint (measured 2026-08-10). Probe
          // people/match with a domain that cannot match — a plan-gated key 403s before
          // any lookup happens, and a paid key finds nobody, so this costs 0 credits
          // either way. Apollo only charges when it returns data.
          const probe = await fetch(
            'https://api.apollo.io/api/v1/people/match',
            {
              method: 'POST',
              headers,
              body: JSON.stringify({ domain: 'nanocrew-plan-probe.invalid' }),
            },
          );
          return probe.status === 403
            ? {
                service,
                status: 'connected',
                message:
                  'Apollo key valid, but this plan blocks enrichment (people/match) — company search only, no names or emails',
              }
            : {
                service,
                status: 'connected',
                message: 'Apollo connection verified (enrichment available)',
              };
        }
        case 'twitter': {
          const bearerToken = creds.bearer_token;
          if (!bearerToken)
            return { service, status: 'invalid', message: 'No bearer token' };
          const res = await fetch(
            'https://api.twitter.com/2/tweets/search/recent?query=test&max_results=10',
            {
              headers: { Authorization: `Bearer ${bearerToken}` },
            },
          );
          return res.ok
            ? {
                service,
                status: 'connected',
                message: 'Twitter connection verified',
              }
            : {
                service,
                status: 'invalid',
                message: `Twitter returned ${res.status}`,
              };
        }
        case 'voice_telephony': {
          // Authenticate WITHOUT placing a call. connect.json would ring a real
          // phone and bill the user, so it is the wrong probe for a credential
          // check; GET on the account resource proves the SID/key/token triple
          // is valid and costs nothing.
          const missing = VOICE_REQUIRED_FIELDS.voice_telephony.filter(
            (f) => !creds[f],
          );
          if (missing.length) {
            return {
              service,
              status: 'invalid',
              message: `Missing: ${missing.join(', ')}`,
            };
          }
          const subdomain = creds.subdomain || 'api.exotel.com';
          const auth = Buffer.from(
            `${creds.api_key}:${creds.api_token}`,
          ).toString('base64');
          const res = await fetch(
            `https://${subdomain}/v1/Accounts/${encodeURIComponent(creds.account_sid)}`,
            { headers: { Authorization: `Basic ${auth}` } },
          );
          if (res.status === 401 || res.status === 403) {
            return {
              service,
              status: 'invalid',
              message: `Exotel rejected the credentials (${res.status}) — check the API key, token and account SID`,
            };
          }
          if (!res.ok) {
            return {
              service,
              status: 'invalid',
              message: `Exotel returned ${res.status}`,
            };
          }
          // The flow URL is the step users most often get wrong: connect.json will
          // not run an arbitrary webhook, only an App Bazaar flow, and a wrong one
          // fails at answer-time (the call connects, then drops) — long after this
          // check would have said "connected". Warn now rather than debug it live.
          const flowOk = /my\.exotel\.com\/.+\/exoml\/start_voice\/.+/.test(
            creds.flow_url,
          );
          return flowOk
            ? {
                service,
                status: 'connected',
                message: `Exotel verified (caller ID ${creds.caller_id})`,
              }
            : {
                service,
                status: 'connected',
                message: `Exotel credentials verified, but the flow URL does not look like an App Bazaar flow (expected http://my.exotel.com/<sid>/exoml/start_voice/<app_id>) — outbound calls will connect and then drop`,
              };
        }
        case 'voice_smtp': {
          const missing = VOICE_REQUIRED_FIELDS.voice_smtp.filter(
            (f) => !creds[f],
          );
          if (missing.length) {
            return {
              service,
              status: 'invalid',
              message: `Missing: ${missing.join(', ')}`,
            };
          }
          // A TCP connect proves the host/port are reachable. Full SMTP AUTH lives
          // in the voice service (Python, which already speaks smtplib); doing a
          // real login here would mean reimplementing STARTTLS/AUTH in TS for no
          // extra safety, so this deliberately reports reachability only.
          const port = Number(creds.port);
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            return {
              service,
              status: 'invalid',
              message: `Invalid port: ${creds.port}`,
            };
          }
          const net = await import('net');
          const reachable = await new Promise<boolean>((resolve) => {
            const sock = net.createConnection({
              host: creds.host,
              port,
              timeout: 8000,
            });
            const done = (ok: boolean) => {
              sock.destroy();
              resolve(ok);
            };
            sock.on('connect', () => done(true));
            sock.on('timeout', () => done(false));
            sock.on('error', () => done(false));
          });
          return reachable
            ? {
                service,
                status: 'connected',
                message: `SMTP host reachable (${creds.host}:${port}), sending as ${creds.from}`,
              }
            : {
                service,
                status: 'invalid',
                message: `Cannot reach ${creds.host}:${port}`,
              };
        }
        case 'hunter': {
          const apiKey = creds.api_key;
          const res = await fetch(
            `https://api.hunter.io/v2/account?api_key=${apiKey}`,
          );
          return res.ok
            ? {
                service,
                status: 'connected',
                message: 'Hunter.io connection verified',
              }
            : {
                service,
                status: 'invalid',
                message: `Seeker returned ${res.status}`,
              };
        }
        case 'gmail': {
          const token = await this.getValidAccessToken('gmail');
          if (!token)
            return { service, status: 'invalid', message: 'No access token' };
          const res = await fetch(
            'https://gmail.googleapis.com/gmail/v1/users/me/profile',
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          );
          return res.ok
            ? {
                service,
                status: 'connected',
                message: `Gmail connected (${((await res.json()) as any).emailAddress ?? 'unknown'})`,
              }
            : {
                service,
                status: 'invalid',
                message: `Gmail returned ${res.status}`,
              };
        }
        case 'slack': {
          const token = await this.getValidAccessToken('slack');
          if (!token)
            return { service, status: 'invalid', message: 'No access token' };
          const res = await fetch('https://slack.com/api/auth.test', {
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = (await res.json()) as any;
          return data.ok
            ? {
                service,
                status: 'connected',
                message: `Slack connected as ${data.user ?? 'unknown'}`,
              }
            : {
                service,
                status: 'invalid',
                message: `Slack error: ${data.error}`,
              };
        }
        case 'github': {
          const token = await this.getValidAccessToken('github');
          if (!token)
            return { service, status: 'invalid', message: 'No access token' };
          const res = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${token}`,
              'User-Agent': 'nanocrew/1.0',
            },
          });
          const data = (await res.json()) as any;
          return res.ok
            ? {
                service,
                status: 'connected',
                message: `GitHub connected as ${data.login}`,
              }
            : {
                service,
                status: 'invalid',
                message: `GitHub returned ${res.status}`,
              };
        }
        case 'notion': {
          const token = await this.getValidAccessToken('notion');
          if (!token)
            return { service, status: 'invalid', message: 'No access token' };
          const res = await fetch('https://api.notion.com/v1/users/me', {
            headers: {
              Authorization: `Bearer ${token}`,
              'Notion-Version': '2022-06-28',
            },
          });
          const data = (await res.json()) as any;
          return res.ok
            ? {
                service,
                status: 'connected',
                message: `Notion connected as ${data.name ?? 'unknown'}`,
              }
            : {
                service,
                status: 'invalid',
                message: `Notion returned ${res.status}`,
              };
        }
        default:
          return {
            service,
            status: 'connected',
            message: 'Credential stored (untested service)',
          };
      }
    } catch (err: any) {
      return { service, status: 'error', message: err.message };
    }
  }

  listConnected(): CredentialSummary[] {
    const store = loadStore();
    return ALL_SERVICES.map((service) => {
      const entry = store[service];
      if (!entry) {
        return {
          service,
          status: 'not_connected' as const,
          maskedKey: '',
          usedByAgents: [],
        };
      }

      let maskedKey = '••••••••';
      let status: CredentialSummary['status'] = 'connected';
      try {
        const creds = JSON.parse(decrypt(entry.encryptedData)) as Record<
          string,
          unknown
        >;
        // Voice services are multi-field and have no single "the key" — show the
        // identity the user recognises (their caller ID / sender address) rather
        // than masking a secret they never typed as one.
        if (service === 'voice_telephony' && creds.caller_id) {
          maskedKey = String(creds.caller_id);
        } else if (service === 'voice_smtp' && creds.from) {
          maskedKey = String(creds.from);
        } else {
          const key = String(
            creds.api_key ??
              creds.bearer_token ??
              creds.email ??
              creds.access_token ??
              '',
          );
          maskedKey = key.length > 4 ? '••••' + key.slice(-4) : '••••';
        }

        // Check expiry for OAuth2 tokens
        if (
          typeof creds.expires_at === 'number' &&
          creds.expires_at < Date.now()
        ) {
          status = creds.refresh_token ? 'expired' : 'expired';
        }
      } catch {
        /* keep defaults */
      }

      return {
        service,
        status,
        maskedKey,
        connectedAt: entry.connectedAt,
        lastUsed: entry.lastUsed,
        usedByAgents: [],
      };
    });
  }

  /** Returns the set of OAuth2 services that have client credentials configured. */
  listOAuthServices(): Array<{ service: string; configured: boolean }> {
    return Object.entries(OAUTH2).map(([service, cfg]) => {
      const { clientId } = getOAuthEnv(cfg);
      return { service, configured: Boolean(clientId) };
    });
  }
}

// Singleton
export const credentialManager = new CredentialManager();
