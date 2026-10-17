/**
 * Stage 57 — rows for runs, tasks, attempts and events. Plain reads and writes; every
 * decision lives in engine.ts. Only the orchestrator writes these tables — containers
 * reach them over HTTP, never through a mounted file (the old queue's flaw).
 */
import { randomBytes } from 'crypto';
import { getDb } from '../db.js';

export type RunStatus =
  | 'awaiting_approval'
  | 'running'
  | 'done'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'budget_stopped';
export type TaskStatus =
  | 'blocked'
  | 'pending'
  | 'leased'
  | 'verifying'
  | 'accepted'
  | 'dead'
  | 'cancelled';
/** `checking`: a racer's result is being checked while its task stays open (engine.ts, races). */
export type AttemptStatus =
  | 'running'
  | 'checking'
  | 'done'
  | 'failed'
  | 'lost'
  | 'late'
  | 'killed';

export interface RunRow {
  id: string;
  owner_agent_id: string;
  owner_user_id: string | null;
  boss_cycle_id: string | null;
  goal: string;
  mode: string;
  status: RunStatus;
  budget_usd: number;
  spent_usd: number;
  max_parallel: number;
  background: number;
  trace_id: string;
  created_at: string;
  finished_at: string | null;
  stop_reason: string | null;
  digest_json: string | null;
  woke_boss: number;
}
export interface TaskRow {
  id: string;
  run_id: string;
  idx: number;
  spec_json: string;
  depends_on: string | null;
  dedupe_key: string | null;
  status: TaskStatus;
  attempts: number;
  max_attempts: number;
  current_attempt_id: string | null;
  last_reason: string | null;
  result_json: string | null;
  verdict_json: string | null;
  cost_usd: number;
  created_at: string;
  finished_at: string | null;
}
export interface AttemptRow {
  id: string;
  task_id: string;
  run_id: string;
  n: number;
  model: string | null;
  status: AttemptStatus;
  lease_expires_at: string;
  started_at: string;
  finished_at: string | null;
  cost_usd: number;
  timings_json: string | null;
  error: string | null;
}
export interface EventRow {
  seq: number;
  run_id: string;
  at: string;
  type: string;
  task_id: string | null;
  attempt_id: string | null;
  data_json: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
}

export const hex = (bytes: number) => randomBytes(bytes).toString('hex');
export const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

function patch(
  table: string,
  id: string,
  fields: Record<string, unknown>,
): void {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  getDb()
    .prepare(
      `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    )
    .run(...keys.map((k) => fields[k] as never), id);
}

// ── runs ──────────────────────────────────────────────────────────────────────
export function insertRun(
  r: Omit<
    RunRow,
    'spent_usd' | 'finished_at' | 'stop_reason' | 'digest_json' | 'woke_boss'
  >,
): void {
  getDb()
    .prepare(
      `INSERT INTO runs (id, owner_agent_id, owner_user_id, boss_cycle_id, goal, mode, status, budget_usd, max_parallel, background, trace_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.id,
      r.owner_agent_id,
      r.owner_user_id,
      r.boss_cycle_id,
      r.goal,
      r.mode,
      r.status,
      r.budget_usd,
      r.max_parallel,
      r.background,
      r.trace_id,
      r.created_at,
    );
}
export const getRun = (id: string) =>
  getDb().prepare('SELECT * FROM runs WHERE id = ?').get(id) as
    | RunRow
    | undefined;
export const updateRun = (id: string, f: Partial<RunRow>) =>
  patch('runs', id, f);
export const addRunSpend = (id: string, usd: number) =>
  getDb()
    .prepare('UPDATE runs SET spent_usd = spent_usd + ? WHERE id = ?')
    .run(usd, id);
export const listActiveRuns = () =>
  getDb()
    .prepare(`SELECT * FROM runs WHERE status = 'running' ORDER BY created_at`)
    .all() as RunRow[];
export const listRunsForAgent = (agentId: string, limit = 10) =>
  getDb()
    .prepare(
      'SELECT * FROM runs WHERE owner_agent_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(agentId, limit) as RunRow[];
/** A person's runs across all their agents — the owner's run list in the dashboard. */
export const listRunsForUser = (userId: string, limit = 50) =>
  getDb()
    .prepare(
      'SELECT * FROM runs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(userId, limit) as RunRow[];

// ── tasks ─────────────────────────────────────────────────────────────────────
export function insertTask(
  t: Omit<
    TaskRow,
    | 'attempts'
    | 'current_attempt_id'
    | 'last_reason'
    | 'result_json'
    | 'verdict_json'
    | 'cost_usd'
    | 'finished_at'
  >,
): void {
  getDb()
    .prepare(
      `INSERT INTO run_tasks (id, run_id, idx, spec_json, depends_on, dedupe_key, status, max_attempts, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      t.id,
      t.run_id,
      t.idx,
      t.spec_json,
      t.depends_on,
      t.dedupe_key,
      t.status,
      t.max_attempts,
      t.created_at,
    );
}
export const getTask = (id: string) =>
  getDb().prepare('SELECT * FROM run_tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
export const getTasksForRun = (runId: string) =>
  getDb()
    .prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY idx')
    .all(runId) as TaskRow[];
export const updateTask = (id: string, f: Partial<TaskRow>) =>
  patch('run_tasks', id, f);
export const getTasksByStatus = (status: TaskStatus) =>
  getDb()
    .prepare('SELECT * FROM run_tasks WHERE status = ? ORDER BY created_at')
    .all(status) as TaskRow[];
export const addTaskSpend = (id: string, usd: number) =>
  getDb()
    .prepare('UPDATE run_tasks SET cost_usd = cost_usd + ? WHERE id = ?')
    .run(usd, id);

// ── attempts ──────────────────────────────────────────────────────────────────
export function insertAttempt(
  a: Omit<AttemptRow, 'finished_at' | 'cost_usd' | 'timings_json' | 'error'>,
): void {
  getDb()
    .prepare(
      `INSERT INTO run_attempts (id, task_id, run_id, n, model, status, lease_expires_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      a.id,
      a.task_id,
      a.run_id,
      a.n,
      a.model,
      a.status,
      a.lease_expires_at,
      a.started_at,
    );
}
export const getAttempt = (id: string) =>
  getDb().prepare('SELECT * FROM run_attempts WHERE id = ?').get(id) as
    | AttemptRow
    | undefined;
export const updateAttempt = (id: string, f: Partial<AttemptRow>) =>
  patch('run_attempts', id, f);
export const getAttemptsForRun = (runId: string) =>
  getDb()
    .prepare('SELECT * FROM run_attempts WHERE run_id = ? ORDER BY started_at')
    .all(runId) as AttemptRow[];
export const getRunningAttempts = () =>
  getDb()
    .prepare(`SELECT * FROM run_attempts WHERE status = 'running'`)
    .all() as AttemptRow[];
export const getCheckingAttempts = () =>
  getDb()
    .prepare(`SELECT * FROM run_attempts WHERE status = 'checking'`)
    .all() as AttemptRow[];

// ── events ────────────────────────────────────────────────────────────────────
export function appendEvent(
  run: Pick<RunRow, 'id' | 'trace_id'>,
  type: string,
  o: {
    taskId?: string;
    attemptId?: string;
    data?: unknown;
    parentSpanId?: string;
  } = {},
): string {
  const span = hex(8);
  getDb()
    .prepare(
      `INSERT INTO run_events (run_id, at, type, task_id, attempt_id, data_json, trace_id, span_id, parent_span_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      run.id,
      nowIso(),
      type,
      o.taskId ?? null,
      o.attemptId ?? null,
      o.data === undefined ? null : JSON.stringify(o.data),
      run.trace_id,
      span,
      o.parentSpanId ?? null,
    );
  return span;
}
export const getEvents = (runId: string) =>
  getDb()
    .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq')
    .all(runId) as EventRow[];
