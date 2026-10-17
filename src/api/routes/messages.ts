/**
 * Message history routes
 */
import { Router } from 'express';

import {
  getAgent,
  getChatHistory,
  getRouterState,
  getProject,
} from '../../db.js';
import { ASSISTANT_NAME } from '../../config.js';
import { ownsResource } from '../middleware/ownership.js';

export const messagesRouter = Router();

/** GET /api/messages/:chatJid — Message history for a chat */
messagesRouter.get('/messages/:chatJid', (req, res) => {
  const { chatJid } = req.params;
  const limit = parseInt((req.query.limit as string) || '50', 10);

  // Stage 28 — isolate per-agent chat threads to the agent's owner. Group/dashboard
  // threads belong to the WhatsApp routing layer, so they're operator (admin) only.
  if (chatJid.startsWith('agent:')) {
    const agent = getAgent(chatJid.slice('agent:'.length));
    if (!agent || !ownsResource(req, agent.owner_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else if (chatJid.startsWith('project:')) {
    const project = getProject(chatJid.slice('project:'.length));
    if (!project || !ownsResource(req, project.owner_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else if (req.user?.role !== 'admin') {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    // For dashboard chats, only show messages from the current session
    // so that a page reload doesn't merge all past conversations together.
    // Non-dashboard chats (WhatsApp etc.) are unaffected.
    const sessionBoundary = chatJid.startsWith('dash:')
      ? (getRouterState(`session_start_${chatJid}`) ?? '')
      : (req.query.since as string) || '';

    const messages = getChatHistory(chatJid, sessionBoundary);
    const sliced = messages.slice(-limit);
    res.json({
      chatJid,
      messages: sliced,
      total: messages.length,
      returned: sliced.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});
