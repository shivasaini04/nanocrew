/**
 * Stage 57 — a result counts only when a verifier accepts it.
 *
 * Every task has a chain, run cheapest first. Anything other than an explicit accept —
 * a malformed contract, a verifier that throws, a page that will not load, a judge that
 * answers in a shape we cannot read — is a reject. Nothing fails open (the old INSPECTOR
 * approved on every parse failure).
 *
 * Verifiers re-execute; they never take the worker's word. Pages are fetched again, now,
 * by the platform. Addresses are checked with a mail server. Tests are run again in a
 * sandbox. A worker's own log saying "all passed" is never read.
 *
 * Before any of that, every result is screened for text that reads as instructions to an
 * AI — the shape a poisoned page takes when a worker copies it into its answer.
 */
import { validateAgainst } from './schema-check.js';
import { LIMITS, type TaskSpec, type VerifierSpec } from './spec.js';
import type { JudgeInput, PanelVerdict } from './judge.js';
import type { Page } from './page-fetch.js';
import type { CommandResult } from './sandbox.js';

/** What a worker hands back through report_result. */
export interface WorkerContract {
  result: unknown;
  summary: string;
  evidence?: string[];
  confidence?: number;
}

export interface Check {
  kind: string;
  ok: boolean;
  detail?: string;
}

export interface Verdict {
  accepted: boolean;
  /** true when the only thing that accepted it was `none`. Shown everywhere the result is. */
  unverified: boolean;
  reason?: string;
  checks: Check[];
  /** Money the checks spent (judges). Added to the run. */
  costUsd?: number;
}

export type EmailStatus = 'safe' | 'risky' | 'invalid' | 'unknown';

/** What the checks may call. Real ones in service.ts; tests pass fakes. */
export interface VerifyContext {
  fetchPage?: (url: string) => Promise<Page>;
  checkEmail?: (
    address: string,
  ) => Promise<{ status: EmailStatus; detail?: string }>;
  /** Is this value already in the owner's tracker? Returns where, or null. */
  knownToOwner?: (value: string) => string | null;
  /** `files` are the boss's test files, laid over the worker's copy so the worker cannot edit them. */
  runCommand?: (
    command: string,
    timeoutMs: number,
    files?: Record<string, string>,
  ) => Promise<CommandResult>;
  judge?: (input: JudgeInput) => Promise<PanelVerdict>;
}

/** Parse and bound a contract. Returns a reason string when it is unusable. */
export function readContract(raw: unknown): WorkerContract | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return 'no result was reported (report_result was not called)';
  const o = raw as Record<string, unknown>;
  if (
    !('result' in o) ||
    o.result === undefined ||
    o.result === null ||
    o.result === ''
  )
    return 'the reported result is empty';
  const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
  if (!summary) return 'the reported result has no summary';
  let size = 0;
  try {
    size = JSON.stringify(o.result).length;
  } catch {
    return 'the result is not serialisable';
  }
  if (size > LIMITS.resultMaxBytes)
    return `the result is ${size} bytes — over ${LIMITS.resultMaxBytes}; put bulk in a file and reference it`;
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.map(String).slice(0, 30)
    : undefined;
  const confidence =
    typeof o.confidence === 'number' && o.confidence >= 0 && o.confidence <= 1
      ? o.confidence
      : undefined;
  return {
    result: o.result,
    summary: summary.slice(0, LIMITS.summaryMaxChars),
    evidence,
    confidence,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every value at a dotted path; arrays along the way are walked (`leads.email`). */
export function valuesAt(obj: unknown, path: string): unknown[] {
  let cur: unknown[] = [obj];
  for (const key of path.split('.').filter(Boolean)) {
    const next: unknown[] = [];
    for (const c of cur.flatMap((x) => (Array.isArray(x) ? x : [x]))) {
      if (c && typeof c === 'object' && key in (c as object))
        next.push((c as Record<string, unknown>)[key]);
    }
    cur = next;
  }
  return cur
    .flatMap((x) => (Array.isArray(x) ? x : [x]))
    .filter((v) => v !== null && v !== undefined && v !== '');
}

function stringLeaves(x: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 10) return out;
  if (typeof x === 'string') out.push(x);
  else if (Array.isArray(x)) x.forEach((v) => stringLeaves(v, out, depth + 1));
  else if (x && typeof x === 'object')
    Object.values(x).forEach((v) => stringLeaves(v, out, depth + 1));
  return out;
}

const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  /\byou are now\b|\bnew instructions\b|\bsystem prompt\b|\bdeveloper mode\b|\bjailbreak\b/i,
  /<\|?(im_start|im_end|endoftext|system)\|?>|\[\/?INST\]|<\/?(system|assistant)>/i,
  /\b(as an? (ai|assistant|agent|language model)|attention (ai|assistant|agent|llm))\b[^.\n]{0,60}\b(must|should|need to|are required to|will)\b/i,
];

/** Text in a result that reads as instructions to an AI. Narrow on purpose — a lead's job ad saying "email your CV to…" is not one. */
export function instructionLikeText(c: WorkerContract): string | null {
  for (const s of [...stringLeaves(c.result), c.summary]) {
    for (const re of INSTRUCTION_PATTERNS) {
      const m = re.exec(s);
      if (m)
        return s
          .slice(Math.max(0, m.index - 20), m.index + m[0].length + 20)
          .replace(/\s+/g, ' ')
          .trim();
    }
  }
  return null;
}

function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\p{L}\p{N}@.$€£%/:+'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'its',
  'their',
  'per',
  'into',
  'our',
  'you',
  'your',
  'was',
  'has',
  'have',
  'not',
]);
function contentWords(s: string): string[] {
  return norm(s)
    .split(' ')
    .map((w) => w.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, ''))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** Host of a URL-ish value, without www — `https://www.Linear.app/` → `linear.app`. */
function hostOf(v: string): string | null {
  try {
    return new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).hostname
      .replace(/^www\./, '')
      .toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Does this value appear on this page? Short values (names, cities, prices, emails) must
 * appear as written, or every one of their words must; a URL matches by its host; longer
 * prose needs most of its words. Judging whether prose is *supported* is the judge's job.
 */
export function valueOnPage(value: unknown, page: Page): boolean {
  const text = norm(page.text);
  if (!text) return false;
  if (typeof value === 'number' || typeof value === 'boolean')
    return text.includes(String(value));
  const v = String(value);
  if (
    /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(v.trim()) &&
    !/@/.test(v)
  ) {
    const h = hostOf(v.trim());
    if (
      h &&
      (hostOf(page.finalUrl) === h ||
        hostOf(page.url) === h ||
        text.includes(h))
    )
      return true;
  }
  const n = norm(v);
  if (n && text.includes(n)) return true;
  const words = contentWords(v);
  if (!words.length) return false;
  const found = words.filter((w) => text.includes(w)).length;
  return v.length <= 80 ? found === words.length : found / words.length >= 0.7;
}

// ── the chain ────────────────────────────────────────────────────────────────

type Step = { ok: boolean; detail?: string; cost?: number };

/** Pages opened per result. Every one of them reaches the judges (judge.ts splits its budget). */
const MAX_CITED = 6;

/** Cheapest first, whatever order the boss listed them in: a result that fails a free check never costs a judge. */
const COST_RANK: Record<VerifierSpec['kind'], number> = {
  schema: 0,
  none: 0,
  dedupe: 1,
  evidence_urls: 2,
  email: 3,
  command: 4,
  judge: 5,
};

async function runOne(
  v: VerifierSpec,
  task: TaskSpec,
  c: WorkerContract,
  ctx: VerifyContext,
  pages: Map<string, Page>,
): Promise<Step> {
  const need = <K extends keyof VerifyContext>(
    k: K,
  ): NonNullable<VerifyContext[K]> => {
    const f = ctx[k];
    if (!f) throw new Error(`${v.kind} is not available here`);
    return f as NonNullable<VerifyContext[K]>;
  };
  const fetchAll = async (urls: string[]) => {
    const fetch = need('fetchPage');
    await Promise.all(
      urls
        .filter((u) => !pages.has(u))
        .map(async (u) => {
          pages.set(u, await fetch(u));
        }),
    );
    return urls.map((u) => pages.get(u)!);
  };
  // Two kinds of URL. `evidence` is what the worker says its answer rests on: every one must
  // load. A URL inside the result is often a source too — workers list them in a `sources`
  // field and leave `evidence` empty (live, 2026-09-29: a correct Stripe result was rejected
  // as "no pages cited" with four URLs in `sources`) — but it can also be a claim, like a
  // lead's LinkedIn profile, on a site that walls off servers. So those are opened
  // best-effort: used when they load, never a reason to reject when they do not.
  const isUrl = (s: string) => /^https?:\/\/\S+$/i.test(s);
  const evidenceUrls = [
    ...new Set((c.evidence ?? []).map((s) => s.trim()).filter(isUrl)),
  ].slice(0, MAX_CITED);
  const resultUrls = [
    ...new Set(
      stringLeaves(c.result)
        .map((s) => s.trim())
        .filter(isUrl),
    ),
  ].filter((u) => !evidenceUrls.includes(u));
  const citedUrls = () => [...evidenceUrls, ...resultUrls].slice(0, MAX_CITED);
  const mustLoad = (p: Page) => evidenceUrls.includes(p.url);

  switch (v.kind) {
    case 'schema': {
      if (!task.output_schema)
        return { ok: false, detail: 'no output_schema to check against' };
      const problems = validateAgainst(c.result, task.output_schema);
      return problems.length
        ? { ok: false, detail: problems.slice(0, 5).join('; ') }
        : { ok: true };
    }
    case 'none':
      return { ok: true, detail: 'not checked' };

    case 'dedupe': {
      const known = need('knownToOwner');
      for (const val of valuesAt(c.result, v.field)) {
        const where = known(String(val));
        if (where)
          return {
            ok: false,
            detail: `${JSON.stringify(String(val))} is already in the owner's ${where} — find ones that are not`,
          };
      }
      return { ok: true };
    }

    case 'evidence_urls': {
      const urls = citedUrls();
      if (!urls.length && v.allow_none)
        return { ok: true, detail: 'no pages cited — left to the judges' };
      if (!urls.length)
        return {
          ok: false,
          detail:
            'no evidence URLs were cited — list the pages the answer rests on in `evidence`',
        };
      const all = await fetchAll(urls);
      const dead = all.filter((p) => !p.ok && mustLoad(p));
      const got = all.filter((p) => p.ok);
      if (dead.length)
        return {
          ok: false,
          detail: `cited page${dead.length > 1 ? 's' : ''} did not load: ${dead
            .map((p) => `${p.url} (${p.error ?? `HTTP ${p.status}`})`)
            .join('; ')
            .slice(0, 400)}`,
        };
      for (const field of v.fields ?? []) {
        const vals = valuesAt(c.result, field);
        if (!vals.length)
          return {
            ok: false,
            detail: `\`${field}\` is empty — nothing to check against the pages`,
          };
        for (const val of vals) {
          if (!got.some((p) => valueOnPage(val, p))) {
            return {
              ok: false,
              detail: `${field} = ${JSON.stringify(String(val)).slice(0, 120)} does not appear on any cited page — copy values as the page states them, and cite the page that states them`,
            };
          }
        }
      }
      const skipped = all.length - got.length;
      return {
        ok: true,
        detail: `${got.length} page${got.length === 1 ? '' : 's'} loaded (${got.map((p) => p.via).join(',')})${skipped ? `; ${skipped} URL${skipped > 1 ? 's' : ''} in the result did not load` : ''}`,
      };
    }

    case 'email': {
      const check = need('checkEmail');
      const addrs = valuesAt(c.result, v.field).map(String);
      if (!addrs.length)
        return { ok: false, detail: `\`${v.field}\` has no address to check` };
      for (const a of addrs.slice(0, LIMITS.itemsPerWorkerMax)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
          return {
            ok: false,
            detail: `${JSON.stringify(a)} is not an email address`,
          };
        const r = await check(a);
        if (r.status === 'safe' || (r.status === 'risky' && v.allow_risky))
          continue;
        return {
          ok: false,
          detail: `${a} is ${r.status}${r.detail ? ` (${r.detail})` : ''} — only deliverable addresses pass${r.status === 'risky' ? '; role addresses like info@ are risky' : ''}`,
        };
      }
      return { ok: true, detail: `${addrs.length} deliverable` };
    }

    case 'command': {
      const r = await need('runCommand')(v.run, v.timeout_s * 1000, v.files);
      if (r.timedOut)
        return {
          ok: false,
          detail: `the check \`${v.run}\` did not finish in ${v.timeout_s}s`,
        };
      if (r.exitCode !== 0) {
        const { failureLine } = await import('./sandbox.js');
        return {
          ok: false,
          detail: `the check \`${v.run}\` failed (exit ${r.exitCode}): ${failureLine(r.output)}`,
        };
      }
      return { ok: true, detail: `\`${v.run}\` passed` };
    }

    case 'judge': {
      const urls = citedUrls();
      const got = urls.length && ctx.fetchPage ? await fetchAll(urls) : [];
      // A cited page that did not load is shown as such: a claim resting only on it is unsupported.
      const panel = await need('judge')({
        objective: task.objective,
        rubric: v.rubric,
        result: c.result,
        pages: got
          .filter((p) => p.ok || mustLoad(p))
          .map((p) => ({
            url: p.url,
            text: p.ok
              ? p.text
              : `(this cited page could not be loaded: ${p.error ?? `HTTP ${p.status}`})`,
          })),
      });
      const tally = panel.votes
        .map((x) => `${x.verdict}${x.readable ? '' : '?'}`)
        .join('/');
      return {
        ok: panel.accepted,
        detail: `${tally}: ${panel.reason}`.slice(0, 400),
        cost: panel.costUsd,
      };
    }
  }
  return {
    ok: false,
    detail: `unknown verifier ${(v as { kind: string }).kind}`,
  };
}

export async function verify(
  task: TaskSpec,
  raw: unknown,
  ctx: VerifyContext = {},
): Promise<Verdict> {
  const c = readContract(raw);
  if (typeof c === 'string')
    return {
      accepted: false,
      unverified: false,
      reason: c,
      checks: [{ kind: 'contract', ok: false, detail: c }],
    };

  const checks: Check[] = [];
  let costUsd = 0;
  const injected = instructionLikeText(c);
  if (injected) {
    // The quote goes to the audit record only. The reason reaches the boss's digest and the
    // retry prompt, and quoting the instructions there would deliver exactly what was caught.
    const reason =
      'injection_screen: the result contains text that reads as instructions to an AI — describe what a page says instead of copying instructions from it';
    return {
      accepted: false,
      unverified: false,
      reason,
      checks: [
        {
          kind: 'injection_screen',
          ok: false,
          detail: `matched: ${injected.slice(0, 160)}`,
        },
      ],
    };
  }
  checks.push({ kind: 'injection_screen', ok: true });

  const pages = new Map<string, Page>();
  const chain = [...task.verifier].sort(
    (a, b) => COST_RANK[a.kind] - COST_RANK[b.kind],
  );
  for (const v of chain) {
    let r: Step;
    try {
      r = await runOne(v, task, c, ctx, pages);
    } catch (e) {
      r = {
        ok: false,
        detail: `verifier crashed: ${String((e as Error)?.message ?? e)}`,
      };
    }
    costUsd += r.cost ?? 0;
    checks.push({ kind: v.kind, ok: r.ok, detail: r.detail });
    if (!r.ok)
      return {
        accepted: false,
        unverified: false,
        reason: `${v.kind}: ${r.detail ?? 'rejected'}`,
        checks,
        costUsd,
      };
  }
  if (task.verifier.length === 0)
    return {
      accepted: false,
      unverified: false,
      reason: 'no verifier ran',
      checks,
      costUsd,
    };
  const unverified = task.verifier.every((v) => v.kind === 'none');
  return { accepted: true, unverified, checks, costUsd };
}
