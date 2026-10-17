import { Router } from 'express';
import { secretsManager } from '../../agents/secrets-manager.js';

export const secretsRouter = Router();

// GET /api/secrets — list global secrets (names + masked, never values)
secretsRouter.get('/', (_req, res) => {
  try {
    res.json(secretsManager.list('global'));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/secrets — store a global secret { name, value }
secretsRouter.post('/', (req, res) => {
  const { name, value } = req.body as { name?: string; value?: string };
  if (!name || !value)
    return res.status(400).json({ error: 'name and value are required' });
  try {
    secretsManager.set('global', name, value);
    const entry = secretsManager.list('global').find((s) => s.name === name);
    res.json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/secrets/:name — revoke a global secret
secretsRouter.delete('/:name', (req, res) => {
  try {
    secretsManager.delete('global', req.params.name);
    res.json({ deleted: true, name: req.params.name });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
