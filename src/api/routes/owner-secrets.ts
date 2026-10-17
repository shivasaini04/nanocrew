import { Router } from 'express';
import { secretsManager } from '../../agents/secrets-manager.js';

/**
 * Owner-scoped secrets — one login set once, reaching every agent the caller owns.
 *
 * Stage 51 gap 2. `/api/secrets` is admin-only and hardcodes the `global` scope, so a
 * customer could only set a secret agent by agent. The owner is always the session user,
 * never a field in the request, so one customer cannot read or write another's namespace.
 */
export const ownerSecretsRouter = Router();

function ownerOf(req: { user?: { id: string } }): string | null {
  return req.user?.id ?? null;
}

// GET /api/owner-secrets — names + masked values, never the values themselves
ownerSecretsRouter.get('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(401).json({ error: 'Not signed in' });
  try {
    res.json(secretsManager.list({ ownerId }));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/owner-secrets { name, value }
ownerSecretsRouter.post('/', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(401).json({ error: 'Not signed in' });
  const { name, value } = req.body as { name?: string; value?: string };
  if (!name || !value)
    return res.status(400).json({ error: 'name and value are required' });
  try {
    secretsManager.set({ ownerId }, name, value);
    res.json(secretsManager.list({ ownerId }).find((s) => s.name === name));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/owner-secrets/:name
ownerSecretsRouter.delete('/:name', (req, res) => {
  const ownerId = ownerOf(req);
  if (!ownerId) return res.status(401).json({ error: 'Not signed in' });
  try {
    secretsManager.delete({ ownerId }, req.params.name);
    res.json({ deleted: true, name: req.params.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
