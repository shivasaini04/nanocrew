/**
 * Status & system info routes
 */
import { Router } from 'express';

import type { Request, Response } from 'express';

import { getAllChats, getAllRegisteredGroups } from '../../db.js';

export const statusRouter = Router();

const startTime = Date.now();

// Platform-wide status/chats/groups are operator data (aggregate counts + every tenant's
// chats/groups). Restrict to admin so a client can't see other tenants' data. 404 to avoid leaking.
function operatorOnly(req: Request, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

/** GET /api/status — System overview */
statusRouter.get('/status', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const groups = getAllRegisteredGroups();
  const chats = getAllChats();

  res.json({
    status: 'online',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    uptimeHuman: formatUptime(Date.now() - startTime),
    registeredGroups: Object.keys(groups).length,
    totalChats: chats.length,
    timestamp: new Date().toISOString(),
  });
});

/** GET /api/groups — All registered groups */
statusRouter.get('/groups', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const groups = getAllRegisteredGroups();
  const result = Object.entries(groups).map(([jid, group]) => ({
    jid,
    ...group,
  }));
  res.json(result);
});

/** GET /api/chats — All chat metadata */
statusRouter.get('/chats', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const chats = getAllChats();
  res.json(chats);
});

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h ${minutes % 60}m`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
