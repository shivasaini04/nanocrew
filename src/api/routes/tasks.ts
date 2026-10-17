import { Router, Request, Response } from 'express';
import {
  getAllTasks,
  getTasksForGroup,
  getTaskById,
  updateTask,
  deleteTask,
} from '../../db.js';
import { filterOwned, ownershipParam } from '../middleware/ownership.js';

export const tasksRouter = Router();

// Stage 28 — PUT/DELETE /tasks/:id are owner-guarded (the GET list route below uses
// :groupFolder, a different param, so it's unaffected by this).
tasksRouter.param(
  'id',
  ownershipParam((id) => getTaskById(id), 'ownedTask'),
);

/** GET /api/tasks — All scheduled tasks */
tasksRouter.get('/tasks', (req: Request, res: Response) => {
  const tasks = filterOwned(req, getAllTasks());
  res.json(tasks);
});

/** GET /api/tasks/:groupFolder — Tasks for a specific group */
tasksRouter.get('/tasks/:groupFolder', (req: Request, res: Response) => {
  const groupFolder = req.params.groupFolder as string;
  const tasks = filterOwned(req, getTasksForGroup(groupFolder));
  res.json(tasks);
});

/**
 * POST /api/tasks — retired (stage 57, 2026-09-29). A scheduled task's only runner queued it
 * as a background job, and the job system was removed, so a new one would never run.
 * Agent timers (the agent's own schedule) are the way to run work on a clock.
 */
tasksRouter.post('/tasks', (_req: Request, res: Response) => {
  res.status(410).json({
    error: 'Scheduled tasks are retired. Use an agent timer instead.',
  });
});

/** PUT /api/tasks/:id — Update a task (status, prompt, schedule) */
tasksRouter.put('/tasks/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  const updates = req.body;

  try {
    updateTask(id, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task' });
  }
});

/** DELETE /api/tasks/:id — Delete a task */
tasksRouter.delete('/tasks/:id', (req: Request, res: Response) => {
  const id = req.params.id as string;
  try {
    deleteTask(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task' });
  }
});
