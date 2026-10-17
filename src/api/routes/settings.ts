import { Router } from 'express';
import { readEnvFile, writeEnvFile, MANAGED_KEYS } from '../../env.js';

export const settingsRouter = Router();

// Mask a secret so the dashboard can show "is it set?" without leaking the value.
// Keeps the last 4 chars so the user can recognize which key is stored.
function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return '••••' + value.slice(-4);
}

// Keys that are non-secret config (ports, flags). Everything else is masked.
const NON_SECRET_KEYS = new Set([
  'DASHBOARD_PORT',
  'GLOBAL_DAILY_BUDGET_USD',
  'MODEL_PRIORITY',
  'LIGHT_MODEL',
]);

settingsRouter.get('/', (req, res) => {
  try {
    const settings = readEnvFile(MANAGED_KEYS);
    const fullSettings = MANAGED_KEYS.reduce((acc, key) => {
      const raw = settings[key] || '';
      const value = NON_SECRET_KEYS.has(key) ? raw : maskSecret(raw);
      return { ...acc, [key]: value };
    }, {});

    res.json(fullSettings);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

settingsRouter.post('/', (req, res) => {
  try {
    const updates = req.body;
    const sanitizedUpdates: Record<string, string> = {};

    for (const key of Object.keys(updates)) {
      if (!MANAGED_KEYS.includes(key)) continue;
      const v = updates[key];
      // Reject mask-string writes — protects against UI accidentally posting back the masked value
      if (typeof v === 'string' && v.startsWith('••••')) continue;
      sanitizedUpdates[key] = v;
    }

    if (Object.keys(sanitizedUpdates).length > 0) {
      writeEnvFile(sanitizedUpdates);
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
