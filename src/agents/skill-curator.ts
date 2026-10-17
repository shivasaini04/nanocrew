/**
 * Stage 42 #4, cheap half — the orchestrator-side skill lifecycle sweep.
 *
 * Archives agent-created skills that have gone unused past the threshold. Pure date
 * arithmetic over files: no model, no network, no judgment, idempotent, safe on a
 * schedule. It is the direct counterpart of `container/nanoagent/nanoagent/agent/
 * curator.py::sweep`, deliberately reimplemented here rather than called there.
 *
 * Why here and not in the container
 * ---------------------------------
 * The stage 42 doc's Decision 1 put this half in the orchestrator — "once daily,
 * free, no container" — because a cycle spawns a container, works, and dies, so
 * there is no idle moment for a Hermes-style inactivity trigger. It shipped in
 * Python instead, reachable only through the `curate_skills` tool, whose documented
 * trigger is a `self_improve` cycle. But `self_improve` is handled entirely inside
 * `agent-service.ts` and returns before any container is launched, so that trigger
 * does not exist and the sweep had never run. This puts it where the decision said.
 *
 * Calling the Python directly was tried first and does not work: the orchestrator
 * image carries the `nanoagent` source but not its dependencies, and importing
 * anything under `nanoagent.agent` pulls in `loop.py`, which needs `loguru`.
 *
 * This module WRITES into agent workspaces, unlike its read-only sibling
 * `skill-inventory.ts`. That is the narrow exception Decision 1 authorises, and it
 * is bounded: it only ever touches skills that are agent-created, unpinned, and
 * untouched for 90 days — nothing a running cycle is plausibly mid-write on. It
 * archives, never deletes, and ledgers before it moves.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../logger.js';
import {
  skillsDir,
  readOrigins,
  telemetryFor,
  type SkillOrigin,
} from './skill-inventory.js';

/** Ledger action for a retirement, matching skill_ledger.DELETE. */
const LEDGER_DELETE = 'delete';
/** Ledger actor, matching tool_origin.CURATOR — "the curator archived this". */
const CURATOR_ACTOR = 'curator';

const ARCHIVE_DIR_NAME = '.archive';
const LEDGER_NAME = '.ledger.jsonl';
const BLOB_DIR_NAME = '.blobs';

export interface SweepResult {
  /** Skills moved into .archive/ (or that would be, under dryRun). */
  archived: string[];
  /** Past 30 days idle but not yet archivable — reported, deliberately untouched. */
  stale: string[];
  /** Eligible but the move failed. */
  skipped: string[];
  dryRun: boolean;
}

export function summarise(result: SweepResult): string {
  const verb = result.dryRun ? 'would archive' : 'archived';
  const parts = [`${verb} ${result.archived.length}`];
  if (result.stale.length) parts.push(`${result.stale.length} going stale`);
  if (result.skipped.length) parts.push(`${result.skipped.length} skipped`);
  return `Curator: ${parts.join(', ')}.`;
}

/**
 * Skills the curator may act on: agent-created, unpinned, and past active.
 *
 * The intersection is the whole point — being unused is not permission to touch
 * something the user wrote. An unrecorded skill is user-owned by construction, so
 * it never appears here.
 */
function curatable(
  origins: Record<string, SkillOrigin>,
  now: Date,
): Set<string> {
  const out = new Set<string>();
  for (const [name, entry] of Object.entries(origins)) {
    const t = telemetryFor(entry, now);
    if (!t.agentCreated) continue;
    if (t.lifecycle !== 'active') out.add(name);
  }
  return out;
}

/** Store content by sha256, returning the digest. Existing blobs are reused. */
function putBlob(dir: string, content: string): string {
  const digest = crypto
    .createHash('sha256')
    .update(content, 'utf-8')
    .digest('hex');
  const blobs = path.join(dir, BLOB_DIR_NAME);
  const target = path.join(blobs, digest);
  if (fs.existsSync(target)) return digest;
  fs.mkdirSync(blobs, { recursive: true });
  // Write-then-rename so a reader never sees a half-written blob under its digest.
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, target);
  return digest;
}

function recordRetirement(dir: string, name: string, before: string): void {
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    actor: CURATOR_ACTOR,
    skill: name,
    path: path.join('skills', name, 'SKILL.md'),
    action: LEDGER_DELETE,
    before: putBlob(dir, before),
    after: null,
  };
  fs.appendFileSync(
    path.join(dir, LEDGER_NAME),
    `${JSON.stringify(entry)}\n`,
    'utf-8',
  );
}

/** Move one skill into the archive, ledgering it first. Best-effort per skill. */
function archiveOne(dir: string, name: string): boolean {
  const source = path.join(dir, name);
  const skillFile = path.join(source, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return false;

  try {
    const content = fs.readFileSync(skillFile, 'utf-8');
    // Ledger BEFORE the move: a failed move then leaves a harmless extra entry,
    // whereas the reverse order could move a skill with no record of where it went.
    recordRetirement(dir, name, content);

    const target = path.join(dir, ARCHIVE_DIR_NAME, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target))
      fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(source, target);
    return true;
  } catch (err) {
    logger.debug({ skill: name, err: String(err) }, 'could not archive skill');
    return false;
  }
}

/**
 * Archive agent-created skills that have gone unused past the threshold.
 *
 * `agentRoot` is the agent's directory — the same path bind-mounted to
 * /workspace/group, so this reads the sidecar the agent itself writes.
 */
export function sweep(
  agentRoot: string,
  { now = new Date(), dryRun = false }: { now?: Date; dryRun?: boolean } = {},
): SweepResult {
  const result: SweepResult = { archived: [], stale: [], skipped: [], dryRun };
  const dir = skillsDir(agentRoot);
  if (!fs.existsSync(dir)) return result;

  const origins = readOrigins(agentRoot);
  const eligible = curatable(origins, now);

  for (const name of Object.keys(origins).sort()) {
    if (!eligible.has(name)) continue;
    const state = telemetryFor(origins[name], now).lifecycle;

    if (state === 'stale') {
      // Stale is a warning shelf, not an action: reported so a human can see what
      // is drifting, and left alone until it reaches archive age.
      result.stale.push(name);
      continue;
    }
    if (state !== 'archived') continue;
    if (dryRun) {
      result.archived.push(name);
      continue;
    }
    if (archiveOne(dir, name)) result.archived.push(name);
    else result.skipped.push(name);
  }

  return result;
}

/**
 * Sweep one agent, swallowing anything that goes wrong.
 *
 * Called from the `self_improve` path, which must not start failing because a
 * bookkeeping pass hit a permissions error on one workspace.
 */
export function sweepQuietly(
  agentRoot: string,
  agentId: string,
): SweepResult | null {
  try {
    const result = sweep(agentRoot);
    if (
      result.archived.length ||
      result.stale.length ||
      result.skipped.length
    ) {
      logger.info({ agentId, ...result }, summarise(result));
    }
    return result;
  } catch (err) {
    logger.warn({ agentId, err: String(err) }, 'skill lifecycle sweep failed');
    return null;
  }
}
