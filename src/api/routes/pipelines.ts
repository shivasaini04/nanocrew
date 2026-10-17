import { Router } from 'express';
import {
  getPipelines,
  getPipeline,
  createPipeline,
  updatePipeline,
  deletePipeline,
  getPipelineRuns,
  logPipelineRun,
  updatePipelineRunTarget,
  setRowOwner,
} from '../../db.js';
import { agentService } from '../../agents/agent-registry.js';
import type { CycleType } from '../../types.js';
import { logger } from '../../logger.js';
import { filterOwned, ownershipParam } from '../middleware/ownership.js';
import { canWake } from '../../agents/wake-policy.js';

export const pipelinesRouter = Router();

// Stage 28 — any /:id route is owner-guarded (pipelines use :id consistently).
pipelinesRouter.param(
  'id',
  ownershipParam((id) => getPipeline(id), 'ownedPipeline'),
);

// GET /api/pipelines
pipelinesRouter.get('/', (req, res) => {
  try {
    res.json(filterOwned(req, getPipelines()));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipelines/:id  (ownership enforced by router.param above)
pipelinesRouter.get('/:id', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  res.json(p);
});

// POST /api/pipelines
pipelinesRouter.post('/', (req, res) => {
  const {
    name,
    enabled,
    source_agent_id,
    trigger_cycle_type,
    trigger_status,
    target_agent_id,
    target_cycle_type,
    inject_output,
    project_id,
  } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  if (!target_agent_id?.trim())
    return res.status(400).json({ error: 'target_agent_id required' });
  try {
    const p = createPipeline({
      name: name.trim(),
      enabled: enabled !== false,
      source_agent_id: source_agent_id || null,
      trigger_cycle_type: trigger_cycle_type || null,
      trigger_status: trigger_status === 'failed' ? 'failed' : 'completed',
      target_agent_id,
      target_cycle_type: target_cycle_type || 'custom',
      inject_output: inject_output !== false,
      project_id: project_id || null,
    });
    if (req.user) setRowOwner('pipelines', p.id, req.user.id);
    res.status(201).json({ ...p, owner_id: req.user?.id ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pipelines/:id/runs — audit log
pipelinesRouter.get('/:id/runs', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  try {
    const limit = parseInt((req.query.limit as string) ?? '50', 10);
    res.json(getPipelineRuns(req.params.id, isNaN(limit) ? 50 : limit));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/pipelines/:id/fire — manual fire for testing (bypasses source-cycle requirement)
pipelinesRouter.post('/:id/fire', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  if (!p.enabled)
    return res
      .status(400)
      .json({ error: 'Pipeline is disabled — enable it before manual fire.' });

  const target = agentService.getAgent(p.target_agent_id);
  if (!target || !canWake(target, 'pipeline')) {
    return res.status(409).json({
      error:
        `${target?.name ?? p.target_agent_id}'s wake policy has \`pipeline\` turned off ` +
        '(or it is stopped) — it will not run from this trigger.',
    });
  }

  const context = p.inject_output
    ? `## Pipeline Trigger (manual)\nManually fired via the dashboard — no real source cycle.`
    : `## Pipeline Trigger (manual)\nManually fired via the dashboard.`;

  // Log the run immediately and respond. The actual cycle runs async.
  const run = logPipelineRun({
    pipeline_id: p.id,
    source_cycle_id: null,
    target_cycle_id: null,
    source_agent_id: p.source_agent_id,
    source_cycle_type: p.trigger_cycle_type,
    source_status: p.trigger_status,
    target_agent_id: p.target_agent_id,
    target_cycle_type: p.target_cycle_type,
    project_id: p.project_id,
    trigger_kind: 'manual',
    status: 'fired',
    reason: 'manual test',
  });

  setImmediate(() => {
    agentService
      .runCycle(
        p.target_agent_id,
        p.target_cycle_type as CycleType,
        context,
        p.project_id ?? undefined,
      )
      .then((targetCycle) => {
        if (targetCycle?.id)
          try {
            updatePipelineRunTarget(run.id, targetCycle.id);
          } catch {
            /* non-fatal */
          }
      })
      .catch((err) => {
        logger.warn(
          { pipelineId: p.id, err: err.message },
          'Manual pipeline fire failed',
        );
        try {
          logPipelineRun({
            pipeline_id: p.id,
            source_cycle_id: null,
            target_cycle_id: null,
            source_agent_id: p.source_agent_id,
            source_cycle_type: p.trigger_cycle_type,
            source_status: p.trigger_status,
            target_agent_id: p.target_agent_id,
            target_cycle_type: p.target_cycle_type,
            project_id: p.project_id,
            trigger_kind: 'manual',
            status: 'failed',
            reason: String(err?.message ?? err).slice(0, 240),
          });
        } catch {
          /* non-fatal */
        }
      });
  });

  res.status(202).json({ runId: run.id, status: 'fired' });
});

// PATCH /api/pipelines/:id
pipelinesRouter.patch('/:id', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  try {
    updatePipeline(req.params.id, req.body);
    res.json(getPipeline(req.params.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/pipelines/:id
pipelinesRouter.delete('/:id', (req, res) => {
  const p = getPipeline(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pipeline not found' });
  deletePipeline(req.params.id);
  res.json({ ok: true });
});
