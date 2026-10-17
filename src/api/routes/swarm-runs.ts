/**
 * Stage 57 — the routes a boss agent's `delegate`, `run_status` and `steer_run` tools call.
 *
 * Authenticated by the per-cycle token, like self-management — mounted before the session
 * gate for the same reason (a cycle container has no cookie). Workers get no token at all
 * (src/swarm/worker.ts), so these refuse them: a worker cannot raise workers.
 */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import {
  resolveCycleToken,
  verifyCycleToken,
  extractCycleToken,
} from '../../agents/cycle-token.js';
import { logger } from '../../logger.js';
import { getSwarmEngine } from '../../swarm/service.js';
import { getRun, type RunRow } from '../../swarm/store.js';

export const swarmRunsRouter = Router();

function requireCycleToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const agentId = String(req.params.id ?? '');
  const token = extractCycleToken(
    req.headers.authorization,
    req.headers['x-cycle-token'],
  );
  if (!verifyCycleToken(token, agentId)) {
    logger.warn(
      { agentId, path: req.path },
      'Run call rejected — invalid or expired cycle token',
    );
    res.status(401).json({ error: 'Invalid or expired cycle token' });
    return;
  }
  (req as Request & { cycleId?: string }).cycleId =
    resolveCycleToken(token)?.cycleId;
  next();
}

swarmRunsRouter.use('/:id/runs', requireCycleToken);

function brief(run: RunRow) {
  return {
    id: run.id,
    goal: run.goal,
    status: run.status,
    spent_usd: run.spent_usd,
    budget_usd: run.budget_usd,
    created_at: run.created_at,
    finished_at: run.finished_at,
  };
}

// POST /api/agents/:id/runs — start a run. Body: { goal, tasks[], budget_usd?, max_parallel? }
swarmRunsRouter.post('/:id/runs', (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const cycleId = (req as Request & { cycleId?: string }).cycleId ?? null;
  const r = getSwarmEngine().createRun(agentId, cycleId, req.body);
  if (!r.ok)
    return res
      .status(422)
      .json({ error: 'The run was not started.', problems: r.errors });
  logger.info(
    { agentId, runId: r.run.id, tasks: req.body?.tasks?.length },
    'run started',
  );
  res.status(201).json({ run: brief(r.run), notes: r.notes });
});

// GET /api/agents/:id/runs — this agent's recent runs
swarmRunsRouter.get('/:id/runs', (req: Request, res: Response) => {
  res.json({
    runs: getSwarmEngine().listRuns(String(req.params.id)).map(brief),
  });
});

// GET /api/agents/:id/runs/:runId?wait_s=N — the run's state; waits up to N (≤240) seconds for it to finish
swarmRunsRouter.get('/:id/runs/:runId', async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const runId = String(req.params.runId);
  const engine = getSwarmEngine();
  if (!engine.owned(runId, agentId))
    return res.status(404).json({ error: 'Run not found' });

  const waitS = Math.min(Math.max(Number(req.query.wait_s) || 0, 0), 240);
  if (waitS > 0 && !getRun(runId)?.finished_at) {
    engine.beginInlineWait(runId);
    let finished = false;
    try {
      const deadline = Date.now() + waitS * 1000;
      while (Date.now() < deadline) {
        if (getRun(runId)?.finished_at) {
          finished = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
    } finally {
      engine.endInlineWait(runId, finished);
    }
  }
  const view = engine.view(runId, agentId);
  if (!view) return res.status(404).json({ error: 'Run not found' });
  res.json({
    run: brief(getRun(runId)!),
    digest: view.markdown,
    counts: view.counts,
    tasks: view.tasks.map((t) => ({
      idx: t.idx,
      status: t.status,
      attempts: t.attempts,
      reason: t.reason,
    })),
  });
});

// POST /api/agents/:id/runs/:runId/steer — { add_tasks?: [], cancel_task?: idx, cancel?: true }
swarmRunsRouter.post(
  '/:id/runs/:runId/steer',
  (req: Request, res: Response) => {
    const agentId = String(req.params.id);
    const runId = String(req.params.runId);
    const engine = getSwarmEngine();
    if (!engine.owned(runId, agentId))
      return res.status(404).json({ error: 'Run not found' });
    const b = (req.body ?? {}) as {
      add_tasks?: unknown[];
      cancel_task?: number;
      cancel?: boolean;
    };
    if (b.cancel) {
      return res.json({
        cancelled: engine.cancelRun(runId, agentId),
        run: brief(getRun(runId)!),
      });
    }
    if (b.cancel_task !== undefined) {
      return res.json({
        cancelled: engine.cancelTask(runId, agentId, Number(b.cancel_task)),
        run: brief(getRun(runId)!),
      });
    }
    if (Array.isArray(b.add_tasks) && b.add_tasks.length) {
      const r = engine.addTasks(runId, agentId, b.add_tasks);
      if (!r.ok)
        return res
          .status(422)
          .json({ error: 'Nothing was added.', problems: r.errors });
      return res.json({ added: b.add_tasks.length, run: brief(r.run) });
    }
    res
      .status(400)
      .json({ error: 'Say what to do: add_tasks, cancel_task or cancel.' });
  },
);
