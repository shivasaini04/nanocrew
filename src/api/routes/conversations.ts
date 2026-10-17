/**
 * Conversation event stream — the single read path (Stage 35).
 *
 * One endpoint returns everything that happened in a conversation, in order:
 * messages, thinking, tool calls, file changes and errors, as rows of one log.
 * Replaces reconciling three separately-fetched, separately-cached sources
 * (`/messages/:chatJid` + `/cycles/:id/activity-trace` + `/cycles/:id/file-events`)
 * that had no ordering key in common.
 *
 * Phase 0: live and unread — no frontend caller yet. Reads switch over in Phase 2.
 */
import { Router } from 'express';

import {
  getAgent,
  getProject,
  getConversationEvents,
  getConversationHeadSeq,
  getConversationTailSeq,
} from '../../db.js';
import { ownsResource } from '../middleware/ownership.js';

export const conversationsRouter = Router();

/**
 * GET /api/conversations/:conversation/events?after_seq=<n>&limit=<m>
 *
 * `after_seq=0` (default) = full history; `after_seq=<last seen seq>` = only what's
 * new, which is how a client backfills after a socket drop without missing or
 * duplicating events. `head_seq` in the response is the log's current head, so a
 * client can tell whether its page is the tail or more remains.
 */
conversationsRouter.get('/conversations/:conversation/events', (req, res) => {
  const { conversation } = req.params;

  // Same isolation rule as message history: an agent/project thread is readable
  // only by its owner; anything else is operator-only.
  if (conversation.startsWith('agent:')) {
    const agent = getAgent(conversation.slice('agent:'.length));
    if (!agent || !ownsResource(req, agent.owner_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else if (conversation.startsWith('project:')) {
    const project = getProject(conversation.slice('project:'.length));
    if (!project || !ownsResource(req, project.owner_id)) {
      return res.status(404).json({ error: 'Not found' });
    }
  } else if (req.user?.role !== 'admin') {
    return res.status(404).json({ error: 'Not found' });
  }

  const afterSeq = Math.max(
    0,
    parseInt((req.query.after_seq as string) || '0', 10) || 0,
  );
  // Capped deliberately low. Each event can carry a tool's full output, so the ceiling
  // here is a memory bound on a SHARED orchestrator, not a paging preference: at the
  // old 1000/2000 one real conversation serialised to 241 MB in a single synchronous
  // JSON.stringify. after_seq=0 returns the newest page (see getConversationEvents).
  const limit = Math.min(
    500,
    Math.max(1, parseInt((req.query.limit as string) || '500', 10) || 500),
  );

  // Paging back through older history. `before_seq=<oldest seq held>` returns the page
  // immediately before it. The initial read returns only the newest page (a bounded
  // memory cost on a shared orchestrator), so this is how the rest is reachable.
  const beforeSeqRaw = parseInt((req.query.before_seq as string) || '0', 10);
  const beforeSeq =
    Number.isFinite(beforeSeqRaw) && beforeSeqRaw > 0
      ? beforeSeqRaw
      : undefined;

  try {
    const events = getConversationEvents(
      conversation,
      afterSeq,
      limit,
      beforeSeq,
    );
    res.json({
      conversation,
      events,
      after_seq: afterSeq,
      before_seq: beforeSeq ?? null,
      head_seq: getConversationHeadSeq(conversation),
      // The conversation's true first seq — a client whose oldest loaded event
      // equals this has reached the beginning and can stop asking for more.
      tail_seq: getConversationTailSeq(conversation),
      returned: events.length,
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch conversation events' });
  }
});
