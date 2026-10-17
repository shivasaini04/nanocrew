/**
 * The viewer's way in to a cycle's screen (stage 50 phase 4).
 *
 * One cookie-authenticated endpoint that hands back a single-use ticket; everything
 * after it is the WebSocket in ../cycle-vnc-ws.ts. The split exists because a browser
 * cannot set headers on a WebSocket handshake, so the socket cannot carry the proof of
 * who is opening it — the same constraint, and the same answer, as
 * `browser-control-ws.ts`.
 *
 * **Ownership is decided here and nowhere else.** The socket trusts the ticket
 * completely, so this route is the only thing standing between a live view of someone's
 * browser session and whoever asks for one.
 */
import { Router } from 'express';

import { agentService } from '../../agents/agent-registry.js';
import { ownsResource } from '../middleware/ownership.js';
import {
  mintVncTicket,
  hasVncRelay,
  agentForVncRelay,
  CYCLE_VNC_WS_PATH,
} from '../cycle-vnc-ws.js';

export const cycleVncRouter = Router();

/**
 * POST /api/cycles/:cycleId/vnc-ticket
 *
 * Returns: { ticket, wsPath }
 *
 * The agent is taken from the live relay registration, never from the request. A caller
 * naming an agent would be choosing whose screen to be checked against; taking it from
 * the server's own record of who dialled in means the ownership test below is asking
 * about the screen actually on the other end.
 */
cycleVncRouter.post('/cycles/:cycleId/vnc-ticket', (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const { cycleId } = req.params;
  const agentId = agentForVncRelay(cycleId);
  if (!agentId || !hasVncRelay(cycleId)) {
    // Nothing is offering a screen by that id. Deliberately the same answer whether
    // the cycle never existed, has ended, or simply has no VNC session — a probe
    // must not be able to tell those apart.
    res.status(404).json({ error: 'No live screen for that cycle' });
    return;
  }

  const agent = agentService.getAgent(agentId);
  if (!agent) {
    res.status(404).json({ error: 'No live screen for that cycle' });
    return;
  }
  if (!ownsResource(req, agent.owner_id) && user.role !== 'admin') {
    res.status(403).json({ error: 'Not your agent' });
    return;
  }

  res.json({
    ticket: mintVncTicket(cycleId, user.id),
    wsPath: CYCLE_VNC_WS_PATH,
  });
});
