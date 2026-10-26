import { Router } from 'express';
import {
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  clearAllNotifications,
  createNotification,
  getAgent,
} from '../../db.js';
import { ownsResource } from '../middleware/ownership.js';

export const notificationsRouter = Router();

// POST /api/notifications — create a notification
notificationsRouter.post('/', (req, res) => {
  try {
    const { type, title, body, agent_id, meta } = req.body ?? {};
    if (!type || !title)
      return res.status(400).json({ error: 'type and title are required' });
    if (agent_id && !ownsResource(req, getAgent(agent_id)?.owner_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const notif = createNotification({
      type,
      title,
      body: body ?? '',
      agent_id: agent_id ?? null,
      meta: meta ?? null,
      owner_id: req.user!.id,
    });
    res.json(notif);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications?limit=50&unread=true
notificationsRouter.get('/', (req, res) => {
  try {
    const limit = Math.min(
      parseInt((req.query.limit as string) || '50', 10),
      200,
    );
    const unreadOnly = req.query.unread === 'true';
    const notifications = getNotifications(limit, unreadOnly, req.user!.id);
    const unreadCount = getUnreadNotificationCount(req.user!.id);
    res.json({ notifications, unreadCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/count
notificationsRouter.get('/count', (req, res) => {
  try {
    res.json({ unreadCount: getUnreadNotificationCount(req.user!.id) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/notifications/:id/read
notificationsRouter.patch('/:id/read', (req, res) => {
  try {
    const ok = markNotificationRead(req.params.id, req.user!.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/read-all
notificationsRouter.post('/read-all', (req, res) => {
  try {
    markAllNotificationsRead(req.user!.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications/:id
notificationsRouter.delete('/:id', (req, res) => {
  try {
    const ok = deleteNotification(req.params.id, req.user!.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notifications
notificationsRouter.delete('/', (req, res) => {
  try {
    clearAllNotifications(req.user!.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
