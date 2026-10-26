import { Router } from 'express';
import type { Request } from 'express';
import { agentService } from '../../agents/agent-registry.js';
import {
  getCrewGraphEdges,
  getProjectMemberships,
  getCompletedCycleCounts,
  listProjects,
} from '../../db.js';
import { filterOwned } from '../middleware/ownership.js';

export const crewRouter = Router();

// ─── GET /api/crew/graph ──────────────────────────────────────────────────────

crewRouter.get('/graph', (req, res) => {
  try {
    const agents = filterOwned(req as Request, agentService.getAllAgents());
    const agentIds = new Set(agents.map((a) => a.id));
    const projectIds = new Set(
      filterOwned(req, listProjects()).map((p) => p.id),
    );
    const edges = getCrewGraphEdges().filter(
      (edge) => agentIds.has(edge.from) && agentIds.has(edge.to),
    );
    const memberships = getProjectMemberships().filter(
      (m) => agentIds.has(m.agent_id) && projectIds.has(m.project_id),
    );
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
        parent_agent_id: (() => {
          const parent = (a as typeof a & { parent_agent_id?: string })
            .parent_agent_id;
          return parent && agentIds.has(parent) ? parent : null;
        })(),
        cycles: cycleCounts.get(a.id) ?? 0,
      })),
      edges,
      projects: Object.values(projectMap),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});
