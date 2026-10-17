/**
 * Stage 57 — what a boss may ask for, and the limits it runs under.
 *
 * Limits come from phase 2's measurements: a worker is ~225 MB (up to ~900 MB with a browser), ten fit on the
 * server with room to spare, and one worker stays reliable up to ~5 items. A request that
 * breaks a rule is refused with the reason, before any money is spent — a bad spec is the
 * largest single cause of multi-agent failure (MAST, 42%).
 */
import { WORKER_WITHHELD_TOOLS } from './worker.js';
import { schemaProblems, type JsonSchema } from './schema-check.js';

export const LIMITS = {
  /** Worker containers alive at once, across the server. */
  globalWorkers: Number(process.env.SWARM_GLOBAL_WORKERS ?? 8),
  /** Per owner (user). Equal to global while there is one user — lower it at a second customer. */
  perOwnerWorkers: Number(process.env.SWARM_PER_OWNER_WORKERS ?? 8),
  perRunDefault: 3,
  perRunMax: 8,
  /** Tasks checked only by `schema`/`none` are weak evidence — never more than this at once. */
  weakVerifierMaxParallel: 3,
  /**
   * Tasks every one of which is read by the judge panel (or better). The 3–4 ceiling in the
   * literature is for agents that talk to each other about one problem; separate pieces,
   * each checked on its own, keep scaling (WideSeek-R1; Anthropic's 3–5+). docs 20 §4.
   */
  judgedMaxParallel: 5,
  /** Workers racing on one task: first to pass its checks wins (docs 20 §4, best-of-N). */
  raceMax: 4,
  /** Test files the boss hands a `command` check: count and total size. */
  checkFilesMax: 20,
  checkFilesMaxBytes: 64_000,
  itemsPerWorkerMax: 5,
  attemptTimeoutMs: 10 * 60_000,
  /** The most a task may ask for with `timeout_minutes`. */
  attemptTimeoutMaxMs: 30 * 60_000,
  /** Checking one result: page fetches (15 s each, a fallback up to 60 s), a command (≤300 s), judges. */
  verifyTimeoutMs: 8 * 60_000,
  maxAttempts: 2,
  maxTasksPerRun: 30,
  defaultBudgetUsd: 0.5,
  /** Above this the owner approves the plan before anything starts (phase 5). */
  maxBudgetUsd: 1.0,
  /** Never, approved or not. */
  hardMaxBudgetUsd: 10.0,
  summaryMaxChars: 2000,
  resultMaxBytes: 16_000,
  objectiveMaxChars: 2000,
};

export type ToolProfile = 'research' | 'compute' | 'review';

/** Short tool lists on purpose: the worker's prompt is its cost (phase 2: ~35k tokens with ~45 tools). */
export const TOOL_PROFILES: Record<ToolProfile, readonly string[]> = {
  research: [
    'web_search',
    'web_fetch',
    'web_map',
    'effector',
    'read_file',
    'write_file',
    'list_dir',
    'read_pdf',
    'url_check',
    'classify',
    'todo_write',
  ],
  compute: [
    'read_file',
    'write_file',
    'edit_file',
    'append_file',
    'list_dir',
    'glob_search',
    'grep_search',
    'exec',
    'python_repl',
    'run_tests',
    'read_pdf',
    'todo_write',
  ],
  review: [
    'read_file',
    'list_dir',
    'glob_search',
    'grep_search',
    'web_fetch',
    'url_check',
    'read_pdf',
    'todo_write',
  ],
};

/**
 * How a result is checked. Cheapest first, all fail closed (verify.ts):
 *   schema         the result matches output_schema
 *   dedupe         values at `field` are not already in the owner's tracker or this run
 *   evidence_urls  every cited URL opens now; values at `fields` appear on those pages
 *   email          each address at `field` is deliverable (Reacher)
 *   command        a check the boss wrote exits 0 on a copy of the worker's files
 *   judge          two models of another family accept it against the fetched pages
 *   none           nothing — the result is labelled unverified
 */
export type VerifierSpec =
  | { kind: 'schema' }
  | { kind: 'none' }
  | { kind: 'dedupe'; field: string }
  | { kind: 'evidence_urls'; fields?: string[]; allow_none?: boolean }
  | { kind: 'email'; field: string; allow_risky?: boolean }
  | {
      kind: 'command';
      run: string;
      timeout_s: number;
      files?: Record<string, string>;
    }
  | { kind: 'judge'; rubric: string };
export type VerifierKind = VerifierSpec['kind'];
const VERIFIER_KINDS: readonly VerifierKind[] = [
  'schema',
  'none',
  'dedupe',
  'evidence_urls',
  'email',
  'command',
  'judge',
];

/** What a research task is judged against when its boss named no checks. */
export const DEFAULT_RESEARCH_RUBRIC =
  'The result answers the task, and every fact the task asked for is stated on a cited page, or is calculated from values on a cited page with the arithmetic holding. A value the worker could not find is reported as missing, not guessed.';

/** Checks that can show a result is true without trusting a model. Only these widen a run past 3. */
export function isStrongVerifier(v: VerifierSpec): boolean {
  return (
    v.kind === 'email' ||
    v.kind === 'command' ||
    (v.kind === 'evidence_urls' && (v.fields?.length ?? 0) > 0)
  );
}

/** Does `a.b.c` name something in the schema? Arrays are walked through (`leads.email`). */
export function schemaHasPath(
  schema: JsonSchema | undefined,
  path: string,
): boolean {
  if (!schema) return true;
  let node: JsonSchema | undefined = schema;
  for (const key of path.split('.').filter(Boolean)) {
    while (node && node.type === 'array')
      node = node.items as JsonSchema | undefined;
    const props = node?.properties as Record<string, JsonSchema> | undefined;
    if (!props || !(key in props)) return false;
    node = props[key];
  }
  return true;
}

/** A check file's name: a plain relative path, no `..`, nothing absolute. */
export function checkFileNameProblem(name: string): string | null {
  if (!name || name.length > 120) return 'names must be 1–120 characters';
  const parts = name.split('/');
  if (parts.length > 4) return 'at most 3 folders deep';
  if (
    parts.some((p) => !/^[A-Za-z0-9._-]+$/.test(p) || p === '.' || p === '..')
  ) {
    return 'use letters, digits, ".", "_", "-" and "/" only — no absolute paths and no ".."';
  }
  return null;
}

function readCheckFiles(
  raw: unknown,
  where: string,
  errors: string[],
): Record<string, string> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(
      `${where}: command.files must be an object of {"file name": "contents"}`,
    );
    return null;
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > LIMITS.checkFilesMax) {
    errors.push(
      `${where}: command.files — at most ${LIMITS.checkFilesMax} files`,
    );
    return null;
  }
  let bytes = 0;
  const out: Record<string, string> = {};
  for (const [name, content] of entries) {
    const bad = checkFileNameProblem(name);
    if (bad) {
      errors.push(`${where}: command.files "${name.slice(0, 60)}": ${bad}`);
      return null;
    }
    if (typeof content !== 'string') {
      errors.push(`${where}: command.files "${name}" must be the file's text`);
      return null;
    }
    bytes += Buffer.byteLength(content, 'utf-8');
    out[name] = content;
  }
  if (bytes > LIMITS.checkFilesMaxBytes) {
    errors.push(
      `${where}: command.files total ${bytes} bytes — at most ${LIMITS.checkFilesMaxBytes}`,
    );
    return null;
  }
  return out;
}

function readVerifier(
  raw: unknown,
  where: string,
  schema: JsonSchema | undefined,
  errors: string[],
): VerifierSpec | null {
  const o = (raw && typeof raw === 'object' ? raw : { kind: raw }) as Record<
    string,
    unknown
  >;
  const kind = String(o.kind ?? '') as VerifierKind;
  if (!VERIFIER_KINDS.includes(kind)) {
    errors.push(
      `${where}: verifier "${kind}" does not exist (have: ${VERIFIER_KINDS.join(', ')})`,
    );
    return null;
  }
  const path = (name: string, p: unknown): string | null => {
    const s = typeof p === 'string' ? p.trim() : '';
    if (!s) {
      errors.push(
        `${where}: the ${kind} verifier needs \`${name}\` — the result field it checks`,
      );
      return null;
    }
    if (!schemaHasPath(schema, s)) {
      errors.push(
        `${where}: ${kind} checks "${s}", which is not in output_schema`,
      );
      return null;
    }
    return s;
  };
  switch (kind) {
    case 'schema':
    case 'none':
      return { kind };
    case 'dedupe': {
      const f = path('field', o.field);
      return f ? { kind, field: f } : null;
    }
    case 'email': {
      const f = path('field', o.field);
      return f ? { kind, field: f, allow_risky: o.allow_risky === true } : null;
    }
    case 'evidence_urls': {
      const fields = Array.isArray(o.fields)
        ? o.fields.map((f) => path('fields', f))
        : [];
      if (fields.includes(null)) return null;
      return {
        kind,
        fields: fields as string[],
        ...(o.allow_none === true && !fields.length
          ? { allow_none: true }
          : {}),
      };
    }
    case 'command': {
      const run = typeof o.run === 'string' ? o.run.trim() : '';
      if (!run) {
        errors.push(
          `${where}: the command verifier needs \`run\` — the check to run on the worker's files, e.g. "pytest -q"`,
        );
        return null;
      }
      if (run.length > 2000) {
        errors.push(`${where}: command.run is over 2000 characters`);
        return null;
      }
      const t = Number(o.timeout_s ?? 120);
      const timeout_s = Math.min(
        Math.max(Number.isFinite(t) ? t : 120, 10),
        300,
      );
      if (o.files === undefined || o.files === null)
        return { kind, run, timeout_s };
      const files = readCheckFiles(o.files, where, errors);
      return files ? { kind, run, timeout_s, files } : null;
    }
    case 'judge': {
      const rubric = typeof o.rubric === 'string' ? o.rubric.trim() : '';
      if (!rubric) {
        errors.push(
          `${where}: the judge verifier needs a \`rubric\` — what a correct result must do`,
        );
        return null;
      }
      return { kind, rubric: rubric.slice(0, 2000) };
    }
  }
  return null;
}

export interface TaskSpec {
  objective: string;
  inputs?: Record<string, unknown>;
  output_schema?: JsonSchema;
  tools: ToolProfile;
  extra_tools?: string[];
  boundaries?: string;
  verifier: VerifierSpec[];
  dedupe_key?: string;
  /** Indices of earlier tasks in the same request (or run) that must be accepted first. */
  depends_on?: number[];
  max_attempts: number;
  /**
   * Workers racing on this one task at once (2–4). Each tries independently; the first
   * result that passes the checks is accepted and the rest are stopped. Needs a check that
   * can show a result is true — without one, racing only picks an answer at random.
   */
  race?: number;
  /** How long one attempt may run, 1–30 minutes (default LIMITS.attemptTimeoutMs, 10). */
  timeout_minutes?: number;
}

export interface RunRequest {
  goal: string;
  tasks: TaskSpec[];
  budget_usd: number;
  max_parallel: number;
  background: boolean;
  /** Budget above LIMITS.maxBudgetUsd: held until the owner approves the plan. */
  needs_approval: boolean;
}

export type Validated<T> =
  | { ok: true; value: T; notes: string[] }
  | { ok: false; errors: string[] };

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Normalise and check one task. `index` is its position in the request, `offset` the
 * number of tasks the run already has (for depends_on in add_tasks).
 */
export function validateTask(
  raw: unknown,
  index: number,
  offset = 0,
): Validated<TaskSpec> {
  const errors: string[] = [];
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const where = `task ${index + offset}`;

  // `goal` is accepted as a synonym — the imported skills call it that.
  const objective = String(t.objective ?? t.goal ?? '').trim();
  if (!objective) errors.push(`${where}: objective is required`);
  if (objective.length > LIMITS.objectiveMaxChars)
    errors.push(
      `${where}: objective over ${LIMITS.objectiveMaxChars} characters — put data in inputs`,
    );

  const inputs = (t.inputs ?? t.context) as Record<string, unknown> | undefined;
  if (
    inputs !== undefined &&
    (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))
  ) {
    errors.push(`${where}: inputs must be an object`);
  } else if (inputs) {
    for (const [k, v] of Object.entries(inputs)) {
      if (Array.isArray(v) && v.length > LIMITS.itemsPerWorkerMax) {
        errors.push(
          `${where}: inputs.${k} has ${v.length} items — one worker is reliable up to ${LIMITS.itemsPerWorkerMax}. Split it into tasks of at most ${LIMITS.itemsPerWorkerMax}.`,
        );
      }
    }
  }

  const tools = String(t.tools ?? 'research') as ToolProfile;
  if (!(tools in TOOL_PROFILES))
    errors.push(
      `${where}: tools must be one of ${Object.keys(TOOL_PROFILES).join(', ')}`,
    );
  const extra = arr(t.extra_tools).map(String);
  for (const name of extra) {
    if (WORKER_WITHHELD_TOOLS.includes(name))
      errors.push(`${where}: a worker can never have ${name}`);
  }

  let output_schema: JsonSchema | undefined;
  if (t.output_schema !== undefined) {
    const problems = schemaProblems(t.output_schema);
    if (problems.length)
      errors.push(`${where}: output_schema — ${problems.join('; ')}`);
    else output_schema = t.output_schema as JsonSchema;
  }

  // No checks named: a research result is still checked for truth, not just shape. Measured
  // 2026-09-29: asked for facts on three companies, the Assistant sent three tasks with no
  // verifier although the tool description asked for one — rigour cannot depend on the
  // boss remembering. `none` stays available, and is labelled unverified everywhere.
  // allow_none: a dead cited page still fails in code, but an honest "not found" that cites
  // no page goes to the judges rather than failing for lack of a URL (the same run's third
  // worker searched five ways, found nothing, and said so).
  const verifierRaw = arr(t.verifier).length
    ? arr(t.verifier)
    : tools === 'research'
      ? [
          { kind: 'evidence_urls', allow_none: true },
          { kind: 'judge', rubric: DEFAULT_RESEARCH_RUBRIC },
        ]
      : [{ kind: output_schema ? 'schema' : 'none' }];
  const verifier: VerifierSpec[] = [];
  for (const v of verifierRaw) {
    const r = readVerifier(v, where, output_schema, errors);
    if (r) verifier.push(r);
  }
  if (verifier.some((v) => v.kind === 'schema') && !output_schema)
    errors.push(`${where}: the schema verifier needs an output_schema`);
  // A result that must match a schema is checked against it first, whatever else was asked.
  if (output_schema && !verifier.some((v) => v.kind === 'schema'))
    verifier.unshift({ kind: 'schema' });
  if (
    verifier.some((v) => v.kind === 'none') &&
    verifier.some((v) => v.kind !== 'none' && v.kind !== 'schema')
  ) {
    errors.push(
      `${where}: "none" means unchecked — it cannot be combined with real checks`,
    );
  }

  const depends_on = arr(t.depends_on).map(Number);
  for (const d of depends_on) {
    if (!Number.isInteger(d) || d < 0 || d >= index + offset)
      errors.push(`${where}: depends_on ${d} must point to an earlier task`);
  }

  let max_attempts = Math.min(
    Math.max(
      Number(t.max_attempts ?? LIMITS.maxAttempts) || LIMITS.maxAttempts,
      1,
    ),
    3,
  );
  const dedupe_key =
    t.dedupe_key !== undefined ? String(t.dedupe_key).slice(0, 200) : undefined;
  const boundaries =
    t.boundaries !== undefined
      ? String(t.boundaries).slice(0, 1000)
      : undefined;

  // A race: n workers at once on the same brief, the first to pass wins. Each racer is one
  // attempt, so the race IS the retries. Without a check that can show truth, n answers
  // give nothing to choose by (Large Language Monkeys: selection without a verifier plateaus).
  let race: number | undefined;
  if (t.race !== undefined && t.race !== null && Number(t.race) !== 1) {
    const n = Math.floor(Number(t.race));
    if (!Number.isFinite(n) || n < 2 || n > LIMITS.raceMax)
      errors.push(`${where}: race must be 2 to ${LIMITS.raceMax} workers`);
    else if (!verifier.some(isStrongVerifier))
      errors.push(
        `${where}: race needs a check that can show a result is true (command, email, or evidence_urls with fields) — otherwise there is nothing to pick the winner by`,
      );
    else {
      race = n;
      max_attempts = n;
    }
  }

  // Measured 2026-09-29 (docs 20): three racers on a hard coding task were all killed at the
  // 10-minute default — a reasoning model took 80–120 s a call. "Delegate only long pieces"
  // needs pieces that are allowed to be long.
  let timeout_minutes: number | undefined;
  if (t.timeout_minutes !== undefined && t.timeout_minutes !== null) {
    const m = Math.round(Number(t.timeout_minutes));
    if (!Number.isFinite(m) || m < 1 || m > LIMITS.attemptTimeoutMaxMs / 60_000)
      errors.push(
        `${where}: timeout_minutes must be 1 to ${LIMITS.attemptTimeoutMaxMs / 60_000}`,
      );
    else timeout_minutes = m;
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    notes: [],
    value: {
      objective,
      inputs,
      output_schema,
      tools,
      extra_tools: extra.length ? extra : undefined,
      boundaries,
      verifier,
      dedupe_key,
      depends_on: depends_on.length ? depends_on : undefined,
      max_attempts,
      ...(race ? { race } : {}),
      ...(timeout_minutes ? { timeout_minutes } : {}),
    },
  };
}

export function validateRunRequest(raw: unknown): Validated<RunRequest> {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;
  const errors: string[] = [];
  const notes: string[] = [];

  const goal = String(b.goal ?? '').trim();
  if (!goal)
    errors.push('goal is required — one line saying what the whole run is for');

  const rawTasks = arr(b.tasks);
  if (rawTasks.length === 0) errors.push('tasks: give at least one');
  if (rawTasks.length > LIMITS.maxTasksPerRun)
    errors.push(`tasks: at most ${LIMITS.maxTasksPerRun} per run`);

  const tasks: TaskSpec[] = [];
  rawTasks.slice(0, LIMITS.maxTasksPerRun).forEach((t, i) => {
    const r = validateTask(t, i);
    if (r.ok) tasks.push(r.value);
    else errors.push(...r.errors);
  });

  const keys = tasks.map((t) => t.dedupe_key).filter(Boolean);
  const dup = keys.find((k, i) => keys.indexOf(k) !== i);
  if (dup)
    errors.push(
      `dedupe_key "${dup}" is used twice — two tasks would do the same work`,
    );

  let budget_usd =
    b.budget_usd === undefined ? LIMITS.defaultBudgetUsd : Number(b.budget_usd);
  if (!Number.isFinite(budget_usd) || budget_usd <= 0)
    errors.push('budget_usd must be a positive number');
  if (budget_usd > LIMITS.hardMaxBudgetUsd) {
    errors.push(
      `budget_usd ${budget_usd} is over the $${LIMITS.hardMaxBudgetUsd} ceiling — split the work into smaller runs.`,
    );
  }
  // Above $1 the run is planned but held: the owner approves the plan and its cost first.
  const needs_approval = budget_usd > LIMITS.maxBudgetUsd;

  let max_parallel =
    b.max_parallel === undefined
      ? LIMITS.perRunDefault
      : Math.floor(Number(b.max_parallel));
  if (!Number.isFinite(max_parallel) || max_parallel < 1)
    max_parallel = LIMITS.perRunDefault;
  if (max_parallel > LIMITS.perRunMax) {
    notes.push(`max_parallel lowered to ${LIMITS.perRunMax}`);
    max_parallel = LIMITS.perRunMax;
  }
  // A race that cannot run all its workers at once is not a race.
  const widestRace = Math.max(0, ...tasks.map((t) => t.race ?? 0));
  if (widestRace > max_parallel && b.max_parallel === undefined)
    max_parallel = Math.min(widestRace, LIMITS.perRunMax);
  // Width follows verifier strength (docs 17 §2): with only format checks, more workers at
  // once buy more unchecked output, not more right answers. A judge panel reads every
  // result, so judged pieces may go wider; only mechanical checks go widest.
  const allStrong =
    tasks.length > 0 && tasks.every((t) => t.verifier.some(isStrongVerifier));
  const allJudged =
    tasks.length > 0 &&
    tasks.every((t) =>
      t.verifier.some((v) => isStrongVerifier(v) || v.kind === 'judge'),
    );
  const cap = allStrong
    ? LIMITS.perRunMax
    : allJudged
      ? LIMITS.judgedMaxParallel
      : LIMITS.weakVerifierMaxParallel;
  if (max_parallel > cap) {
    notes.push(
      allJudged
        ? `max_parallel lowered to ${cap} — tasks checked by reviewer models run at most ${cap} at once; mechanical checks (evidence_urls with fields, email, command) allow more`
        : `max_parallel lowered to ${cap} — not every task has a check that can show its result is true (evidence_urls with fields, email, or command)`,
    );
    max_parallel = cap;
  }

  const background = b.background === undefined ? true : Boolean(b.background);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    notes,
    value: {
      goal,
      tasks,
      budget_usd,
      max_parallel,
      background,
      needs_approval,
    },
  };
}

/** The tools a worker for this task may use: its profile, its named extras, and report_result. */
export function allowedToolsFor(task: TaskSpec): string[] {
  return [
    ...new Set([
      ...TOOL_PROFILES[task.tools],
      ...(task.extra_tools ?? []),
      'report_result',
    ]),
  ];
}
