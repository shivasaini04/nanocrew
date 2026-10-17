import { Router } from 'express';
import type { Request } from 'express';
import { agentService } from '../../agents/agent-registry.js';
import {
  getCrewGraphEdges,
  getProjectMemberships,
  getCompletedCycleCounts,
} from '../../db.js';
import { filterOwned } from '../middleware/ownership.js';

export const crewRouter = Router();

// ─── GET /api/crew/graph ──────────────────────────────────────────────────────

crewRouter.get('/graph', (req, res) => {
  try {
    const agents = filterOwned(req as Request, agentService.getAllAgents());
    const edges = getCrewGraphEdges();
    const memberships = getProjectMemberships();
    const cycleCounts = getCompletedCycleCounts();

    // Build project→agents map for cluster layout
    const projectMap: Record<
      string,
      { id: string; name: string; agents: string[] }
    > = {};
    for (const m of memberships) {
      if (!projectMap[m.project_id]) {
        projectMap[m.project_id] = {
          id: m.project_id,
          name: m.project_name,
          agents: [],
        };
      }
      projectMap[m.project_id].agents.push(m.agent_id);
    }

    res.json({
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        emoji: a.emoji,
        status: a.status,
        color: a.config.personality?.color ?? null,
        parent_agent_id: (a as any).parent_agent_id ?? null,
        cycles: cycleCounts.get(a.id) ?? 0,
      })),
      edges,
      projects: Object.values(projectMap),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
