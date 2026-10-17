/**
 * Stage 57 phase 5 — the owner's view of delegated runs (the dashboard's Runs page).
 *
 * Session-authenticated: mounted behind requireAuth, unlike swarm-runs.ts, which serves the
 * agents' own cycle tokens. Every route is scoped to the signed-in user — the list filters by
 * owner, and `:runId` goes through a param guard that 404s anyone else's run without saying
 * it exists. (A route with no `:id` once skipped its guard and leaked every account's
 * check-ins — the list here is filtered explicitly, not by a guard.)
 *
 * Worker output reaches the browser as text. It is web-derived: the page renders it as text
 * and links only http(s) URLs.
 */
import fs from 'fs';
import path from 'path';
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from 'express';

import { getAgent } from '../../db.js';
import { buildDigest, type Digest } from '../../swarm/digest.js';
import { runHealth } from '../../swarm/health.js';
import { getSwarmEngine } from '../../swarm/service.js';
import type { TaskSpec } from '../../swarm/spec.js';
import {
  getAttemptsForRun,
  getEvents,
  getRun,
  getTasksForRun,
  listRunsForUser,
  type RunRow,
} from '../../swarm/store.js';
import type { Verdict, WorkerContract } from '../../swarm/verify.js';
import { workerRoot } from '../../swarm/worker.js';

export const runsRouter = Router();

type WithRun = Request & { ownedRun?: RunRow };

function ownerOf(run: RunRow): string | null {
  // The user recorded at creation, confirmed against the agent's current owner.
  const agentOwner = getAgent(run.owner_agent_id)?.owner_id ?? null;
  return run.owner_user_id && run.owner_user_id === agentOwner
    ? run.owner_user_id
    : null;
}

runsRouter.param(
  'runId',
  (req: Request, res: Response, next: NextFunction, runId: string) => {
    const run = getRun(String(runId));
    if (!run || !req.user || ownerOf(run) !== req.user.id) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    (req as WithRun).ownedRun = run;
    next();
  },
);

const secs = (ms: number) => Math.round(ms / 1000);

function digestOf(run: RunRow): Digest {
  return run.digest_json
    ? (JSON.parse(run.digest_json) as Digest)
    : buildDigest(run, getTasksForRun(run.id), getAttemptsForRun(run.id));
}

function agentBrief(agentId: string) {
  const a = getAgent(agentId);
  return {
    id: agentId,
    name: a?.name ?? 'Unknown agent',
    emoji: (a as { emoji?: string } | undefined)?.emoji ?? '',
  };
}

// GET /api/runs — the signed-in user's runs, newest first
runsRouter.get('/', (req: Request, res: Response) => {
  const uid = req.user?.id;
  if (!uid) return res.json({ runs: [] });
  const runs = listRunsForUser(uid, 50).filter((r) => ownerOf(r) === uid);
  res.json({
    runs: runs.map((r) => {
      const d = digestOf(r);
      return {
        id: r.id,
        goal: r.goal,
        status: r.status,
        agent: agentBrief(r.owner_agent_id),
        created_at: r.created_at,
        finished_at: r.finished_at,
        spent_usd: r.spent_usd,
        budget_usd: r.budget_usd,
        counts: d.counts,
        wall_s: secs(d.wallMs),
        work_s: secs(d.sumWorkMs),
      };
    }),
  });
});

// GET /api/runs/:runId — everything the run view shows
runsRouter.get('/:runId', (req: Request, res: Response) => {
  const run = (req as WithRun).ownedRun!;
  const tasks = getTasksForRun(run.id);
  const attempts = getAttemptsForRun(run.id);
  const events = getEvents(run.id);
  const digest = run.finished_at
    ? digestOf(run)
    : buildDigest(run, tasks, attempts);
  const runMs = (json: string | null) => {
    try {
      return Number(JSON.parse(json ?? '{}').runMs) || null;
    } catch {
      return null;
    }
  };

  res.json({
    run: {
      id: run.id,
      goal: run.goal,
      status: run.status,
      agent: agentBrief(run.owner_agent_id),
      created_at: run.created_at,
      finished_at: run.finished_at,
      stop_reason: run.stop_reason,
      budget_usd: run.budget_usd,
      spent_usd: run.spent_usd,
      max_parallel: run.max_parallel,
    },
    counts: digest.counts,
    timing: {
      wall_s: secs(digest.wallMs),
      work_s: secs(digest.sumWorkMs),
      critical_s: secs(digest.criticalPathMs),
    },
    health: runHealth(run, tasks, attempts, events, digest),
    tasks: tasks.map((t) => {
      const spec = JSON.parse(t.spec_json) as TaskSpec;
      const verdict = t.verdict_json
        ? (JSON.parse(t.verdict_json) as Verdict)
        : null;
      const accepted =
        t.status === 'accepted' && t.result_json
          ? (JSON.parse(t.result_json) as WorkerContract)
          : null;
      return {
        idx: t.idx,
        objective: spec.objective,
        tools: spec.tools,
        status: t.status,
        reason: t.last_reason,
        depends_on: t.depends_on ? JSON.parse(t.depends_on) : [],
        cost_usd: t.cost_usd,
        checks_planned: spec.verifier.map((v) => v.kind),
        checks: verdict?.checks ?? [],
        unverified: verdict?.unverified ?? false,
        result: accepted?.result,
        summary: accepted?.summary,
        evidence: accepted?.evidence ?? [],
        attempts: attempts
          .filter((a) => a.task_id === t.id)
          .map((a) => ({
            id: a.id,
            n: a.n,
            model: a.model,
            status: a.status,
            started_at: a.started_at,
            finished_at: a.finished_at,
            cost_usd: a.cost_usd,
            run_s:
              runMs(a.timings_json) !== null
                ? secs(runMs(a.timings_json)!)
                : null,
            error: a.error,
          })),
      };
    }),
    events: events.slice(-200).map((e) => ({
      at: e.at,
      type: e.type,
      attempt: e.attempt_id,
      data: e.data_json ? JSON.parse(e.data_json) : null,
    })),
  });
});

// GET /api/runs/:runId/attempts/:attemptId/transcript — what one worker did, step by step
runsRouter.get(
  '/:runId/attempts/:attemptId/transcript',
  (req: Request, res: Response) => {
    const run = (req as WithRun).ownedRun!;
    const attemptId = String(req.params.attemptId);
    if (!getAttemptsForRun(run.id).some((a) => a.id === attemptId))
      return res.status(404).json({ error: 'Not found' });
    let steps: Array<Record<string, unknown>> = [];
    try {
      const raw = JSON.parse(
        fs.readFileSync(
          path.join(workerRoot(attemptId), 'activity.json'),
          'utf-8',
        ),
      ) as { steps?: unknown[] };
      steps = (raw.steps ?? []) as Array<Record<string, unknown>>;
    } catch {
      /* no transcript: the worker never started, or its folder was cleared */
    }
    const cut = (v: unknown, n: number) =>
      (typeof v === 'string'
        ? v
        : v === undefined
          ? ''
          : JSON.stringify(v)
      ).slice(0, n);
    res.json({
      steps: steps.slice(0, 300).map((s) => ({
        type: String(s.type ?? ''),
        tool: s.tool ? String(s.tool) : undefined,
        input: cut(s.input, 2000),
        output: cut(s.output, 4000),
        content: cut(s.content, 4000),
      })),
    });
  },
);

// POST /api/runs/:runId/cancel — the owner stops a run: workers are stopped, nothing more is spent
runsRouter.post('/:runId/cancel', (req: Request, res: Response) => {
  const run = (req as WithRun).ownedRun!;
  const ok = getSwarmEngine().cancelRun(
    run.id,
    run.owner_agent_id,
    'cancelled by the owner',
  );
  res.json({ cancelled: ok, status: getRun(run.id)?.status });
});
