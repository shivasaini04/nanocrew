import { Router } from 'express';
import { credentialManager } from '../../agents/credential-manager.js';

export const credentialsRouter = Router();

// ─── Resolve the OAuth2 redirect URI for this server ─────────────────────────

function redirectUri(
  service: string,
  req: { headers: { host?: string }; protocol?: string },
): string {
  const base =
    process.env.OAUTH_REDIRECT_BASE ??
    `http://${req.headers.host ?? `localhost:${process.env.DASHBOARD_PORT ?? '3002'}`}`;
  return `${base}/api/credentials/oauth/${service}/callback`;
}

// ─── List credentials ─────────────────────────────────────────────────────────

credentialsRouter.get('/', (_req, res) => {
  try {
    res.json(credentialManager.listConnected());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── List which OAuth2 services have client credentials configured ────────────

credentialsRouter.get('/oauth/services', (_req, res) => {
  try {
    res.json(credentialManager.listOAuthServices());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start OAuth2 PKCE flow — redirect user to provider ──────────────────────

credentialsRouter.get('/oauth/:service/start', (req, res) => {
  try {
    const { service } = req.params;
    const { authUrl } = credentialManager.startOAuthFlow(
      service,
      redirectUri(service, req),
    );
    res.redirect(authUrl);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── OAuth2 callback — exchange code for tokens, then redirect to UI ─────────

credentialsRouter.get('/oauth/:service/callback', async (req, res) => {
  const { service } = req.params;
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    return res.redirect(
      `/?oauth_error=${encodeURIComponent(error)}&service=${service}`,
    );
  }

  if (!code || !state) {
    return res.status(400).json({ error: 'Missing code or state' });
  }

  try {
    await credentialManager.handleOAuthCallback(
      state,
      code,
      redirectUri(service, req),
    );
    res.redirect(`/?oauth_success=${service}`);
  } catch (err: any) {
    res.redirect(
      `/?oauth_error=${encodeURIComponent(err.message)}&service=${service}`,
    );
  }
});

// ─── Store API key credential ─────────────────────────────────────────────────

credentialsRouter.post('/:service', (req, res) => {
  try {
    const { service } = req.params;
    const credentials: Record<string, string> = req.body;
    if (!credentials || typeof credentials !== 'object') {
      return res.status(400).json({ error: 'credentials object required' });
    }
    credentialManager.store(service, credentials);
    res.json({ success: true, service });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Revoke credential ────────────────────────────────────────────────────────

credentialsRouter.delete('/:service', (req, res) => {
  try {
    credentialManager.revoke(req.params.service);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Test credential ──────────────────────────────────────────────────────────

credentialsRouter.post('/:service/test', async (req, res) => {
  try {
    const result = await credentialManager.test(req.params.service);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get valid access token (for agents/tools that call this internally) ──────

credentialsRouter.get('/:service/token', async (req, res) => {
  try {
    const token = await credentialManager.getValidAccessToken(
      req.params.service,
    );
    if (!token) return res.status(404).json({ error: 'No token available' });
    res.json({ token });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Browser credentials (username/password for computer use) ─────────────────
// Stored encrypted under key "browser:{service}" — never returned in plaintext.

credentialsRouter.post('/browser/:service', (req, res) => {
  const { service } = req.params;
  const fields = req.body as Record<string, string>;

  if (!fields || Object.keys(fields).length === 0) {
    return res.status(400).json({
      error:
        'Body must contain credential fields (e.g. { username, password })',
    });
  }

  try {
    credentialManager.store(`browser:${service}`, fields);
    res.json({ service, fields: Object.keys(fields), stored: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

credentialsRouter.get('/browser/:service', (req, res) => {
  const { service } = req.params;
  const data = credentialManager.get(`browser:${service}`);
  if (!data)
    return res
      .status(404)
      .json({ error: `No browser credentials for "${service}"` });
  // Return field names only — never plaintext values
  res.json({ service, fields: Object.keys(data), stored: true });
});

credentialsRouter.delete('/browser/:service', (req, res) => {
  const { service } = req.params;
  credentialManager.revoke(`browser:${service}`);
  res.json({ service, deleted: true });
});
