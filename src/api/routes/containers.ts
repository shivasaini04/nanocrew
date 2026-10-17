/**
 * Container monitoring routes
 */
import { Router } from 'express';
import { getContainers, actionContainer } from '../../container-runtime.js';
import { logger } from '../../logger.js';

export const containersRouter = Router();

/** GET /api/containers — List NanoCrew containers */
containersRouter.get('/containers', async (_req, res) => {
  try {
    const containers = await getContainers();
    res.json({
      containers,
      count: containers.length,
    });
  } catch (err) {
    logger.warn({ err }, 'Failed to list containers');
    res.status(500).json({
      containers: [],
      count: 0,
      error: 'Container runtime unavailable',
    });
  }
});

/** POST /api/containers/:id/:action — Perform an action on a container */
containersRouter.post('/containers/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    res.status(400).json({ error: 'Invalid action' });
    return;
  }

  try {
    await actionContainer(id, action as 'start' | 'stop' | 'restart');
    res.json({ success: true, id, action });
  } catch (err: any) {
    logger.error({ id, action, err }, 'Container action failed');
    res.status(500).json({ error: err.message || 'Container action failed' });
  }
});
