import { Router } from 'express';
import { getSessionUsage, getUsageSummary, getDailyUsage } from '../../db.js';
import { logger } from '../../logger.js';

export const usageRouter = Router();

// GET /api/usage/summary - Returns summary statistics of token usage
usageRouter.get('/usage/summary', (req, res) => {
  try {
    const summary = getUsageSummary();
    res.json(summary);
  } catch (error) {
    logger.error({ error }, 'Failed to get usage summary');
    res.status(500).json({ error: 'Failed to retrieve usage summary' });
  }
});

// GET /api/usage/daily - Returns token usage grouped by day + model (last 30 days)
usageRouter.get('/usage/daily', (_req, res) => {
  try {
    res.json(getDailyUsage());
  } catch (error) {
    logger.error({ error }, 'Failed to get daily usage');
    res.status(500).json({ error: 'Failed to retrieve daily usage' });
  }
});

// GET /api/usage/sessions - Returns usage history broken down by sessions
usageRouter.get('/usage/sessions', (req, res) => {
  try {
    const sessions = getSessionUsage();
    res.json(sessions);
  } catch (error) {
    logger.error({ error }, 'Failed to get session usage');
    res.status(500).json({ error: 'Failed to retrieve session usage' });
  }
});
