/**
 * Stage 57 phase 5 — the boss's own record of which run shapes worked (docs 14: "the planning
 * prompt carries … the boss's own record of which shapes worked before").
 *
 * Built from this agent's finished runs: what each task was asked to return, how it was
 * checked, how many results were accepted, and what a task cost — plus the rejection reason
 * that recurs most. A few lines in the cycle prompt, and nothing at all for an agent that has
 * never delegated. Only what the boss itself wrote and what the engine measured goes in:
 * never a worker's result, which is web-derived.
 */
import { getDb } from '../db.js';
import type { TaskSpec } from './spec.js';
import type { RunRow, TaskRow } from './store.js';

const MAX_SHAPES = 3;

interface Shape {
  signature: string;
  goal: string;
  fields: string[];
  checks: string[];
  accepted: number;
  total: number;
  costPerTask: number;
  wallS: number;
}

function finishedRuns(agentId: string, limit: number): RunRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM runs WHERE owner_agent_id = ? AND finished_at IS NOT NULL AND status != 'cancelled'
    ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as RunRow[];
}
function tasksOf(runId: string): TaskRow[] {
  return getDb()
    .prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY idx')
    .all(runId) as TaskRow[];
}

/** A short "what worked before" note for this agent's prompt, or '' when there is no history. */
export function delegationHistory(agentId: string): string {
  let runs: RunRow[];
  try {
    runs = finishedRuns(agentId, 12);
  } catch {
    return '';
  }
  if (!runs.length) return '';

  const shapes = new Map<string, Shape>();
  const reasons = new Map<string, number>();
  for (const run of runs) {
    const tasks = tasksOf(run.id);
    if (!tasks.length) continue;
    const spec = JSON.parse(tasks[0].spec_json) as TaskSpec;
    const fields = Object.keys(spec.output_schema?.properties ?? {}).slice(
      0,
      6,
    );
    const checks = [
      ...new Set(
        spec.verifier.map((v) => v.kind).filter((k) => k !== 'schema'),
      ),
    ];
    const signature = `${fields.join(',')}|${checks.join(',')}`;
    const accepted = tasks.filter((t) => t.status === 'accepted').length;
    let wallS = 0;
    try {
      wallS =
        Math.round(
          (JSON.parse(run.digest_json ?? '{}') as { wallMs?: number }).wallMs ??
            0,
        ) / 1000;
    } catch {
      /* none */
    }
    const s = shapes.get(signature);
    if (s) {
      s.accepted += accepted;
      s.total += tasks.length;
    } else
      shapes.set(signature, {
        signature,
        goal: run.goal,
        fields,
        checks,
        accepted,
        total: tasks.length,
        costPerTask: run.spent_usd / tasks.length,
        wallS: Math.round(wallS),
      });
    for (const t of tasks) {
      if (t.status !== 'dead' || !t.last_reason) continue;
      // The reason's first clause, without quoted values: the pattern, not the instance.
      const key = t.last_reason
        .replace(/"[^"]*"/g, '"…"')
        .split(/ — |: (?=[A-Z])/)[0]
        .slice(0, 120);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }
  if (!shapes.size) return '';

  const lines = [
    'Your past runs (your own record — reuse a shape that worked):',
  ];
  for (const s of [...shapes.values()].slice(0, MAX_SHAPES)) {
    lines.push(
      `- "${s.goal.slice(0, 70)}": ${s.accepted}/${s.total} accepted` +
        `${s.fields.length ? `; fields ${s.fields.join(', ')}` : ''}` +
        `; checked by ${s.checks.length ? s.checks.join(' + ') : 'shape only'}` +
        `; ~$${s.costPerTask.toFixed(3)}/task${s.wallS ? `, ${s.wallS}s` : ''}`,
    );
  }
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2)
    lines.push(`- Most common reason a task failed (${top[1]}×): ${top[0]}`);
  return lines.join('\n');
}
