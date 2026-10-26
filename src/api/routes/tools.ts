/**
 * Tool Management API Routes — NanoCrew
 *
 * Provides REST endpoints for querying, testing, promoting, and deleting tools.
 */

import { Router, Request, Response } from 'express';
import { ToolLifecycleManager } from '../../services/tool-lifecycle-manager.js';
import { requireAdmin } from '../middleware/auth.js';

let lifecycleManager: ToolLifecycleManager | null = null;

export function setToolLifecycleManager(manager: ToolLifecycleManager): void {
  lifecycleManager = manager;
}

function getManager(res: Response): ToolLifecycleManager | null {
  if (!lifecycleManager) {
    res.status(503).json({ error: 'Tool lifecycle manager not initialized' });
    return null;
  }
  return lifecycleManager;
}

const router = Router();
// This legacy registry is platform-wide and has no per-owner records.
router.use(requireAdmin);

// GET /api/tools — list all tools across all jobs
router.get('/', (_req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const tools = mgr.listAll();
  res.json({ tools, total: tools.length });
});

// GET /api/tools/global — list global tools only
router.get('/global', (_req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  res.json({ tools: mgr.listGlobal() });
});

// GET /api/tools/stale — list stale/unused tools
router.get('/stale', (_req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  res.json({ tools: mgr.getStaleTools() });
});

// GET /api/tools/degraded — list tools with health issues
router.get('/degraded', (_req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  res.json({ tools: mgr.getDegradedTools() });
});

// GET /api/tools/events — get recent event log
router.get('/events', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const limit = parseInt(req.query.limit as string) || 50;
  res.json({ events: mgr.getEventLog(limit) });
});

// GET /api/tools/search — search tools by name or tag
router.get('/search', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const q = (req.query.q as string) || '';
  const tag = req.query.tag as string;
  if (tag) {
    res.json({ tools: mgr.searchByTag(tag) });
  } else {
    res.json({ tools: mgr.searchByName(q) });
  }
});

// GET /api/tools/:jobId — list tools for a specific job
router.get('/:jobId', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const { jobId } = req.params;
  res.json({ tools: mgr.listForJob(jobId as string) });
});

// POST /api/tools/:jobId/:toolName/promote — promote a job-scoped tool to global
router.post('/:jobId/:toolName/promote', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const { jobId, toolName } = req.params;
  const success = mgr.promoteToGlobal(jobId as string, toolName as string);
  if (success) {
    res.json({ message: `Tool '${toolName}' promoted to global.` });
  } else {
    res.status(400).json({
      error: `Could not promote '${toolName}'. It may not exist or a global tool with the same name already exists.`,
    });
  }
});

// DELETE /api/tools/:jobId/:toolName — delete a tool (via cleanup)
router.delete('/:jobId/:toolName', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const { jobId, toolName } = req.params;
  // We trigger an event-style deletion through the manager
  mgr.onToolDeleted({
    type: 'tool_deleted',
    jobId: jobId as string,
    toolName: toolName as string,
    version: '',
    timestamp: new Date().toISOString(),
  });
  res.json({ message: `Tool '${toolName}' deleted from job '${jobId}'.` });
});

// POST /api/tools/:jobId/cleanup — clean up all tools for a finished job
router.post('/:jobId/cleanup', (req: Request, res: Response) => {
  const mgr = getManager(res);
  if (!mgr) return;
  const { jobId } = req.params;
  const result = mgr.cleanupJobTools(jobId as string);
  res.json({ message: `Job '${jobId}' tools cleaned up.`, ...result });
});

export default router;
