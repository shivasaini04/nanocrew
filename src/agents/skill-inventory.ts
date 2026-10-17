/**
 * Stage 42 — host-side reader for the agent learning-loop artifacts.
 *
 * Everything the learning loop produces lives in the agent workspace, not the DB:
 *
 *   <agentRoot>/skills/<name>/SKILL.md   the skill itself
 *   <agentRoot>/skills/.origins.json     provenance + usage telemetry sidecar
 *   <agentRoot>/skills/.ledger.jsonl     append-only mutation log
 *   <agentRoot>/skills/.blobs/<sha256>   content-addressed before/after bodies
 *   <agentRoot>/skills/.archive/<name>/  curator retirements
 *
 * The container writes them (see container/nanoagent/nanoagent/agent/skill_origins.py,
 * skill_ledger.py, tools/save_skill.py); the orchestrator only ever reads. Mutating
 * operations — rollback, archive, restore — stay inside the container so the host
 * never races a running cycle.
 *
 * <agentRoot> is bind-mounted to /workspace/group, which is the Python `workspace`
 * for regular cycles, so the sidecar the agent writes is the one this module reads.
 */
import fs from 'fs';
import path from 'path';

/**
 * DUPLICATED CONTRACT. The real definition of these thresholds is
 * container/nanoagent/nanoagent/agent/skill_origins.py — this is a second copy in a
 * second language, which is exactly the shape that produced the rename bugs before.
 * skill-inventory.test.ts parses the Python and fails if these drift.
 */
export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;

export type LifecycleState = 'active' | 'stale' | 'archived';

/** Raw sidecar entry, as written by skill_origins.py. */
export interface SkillOrigin {
  origin?: string;
  created_at?: string;
  updated_at?: string;
  write_count?: number;
  usage_count?: number;
  last_used_at?: string;
  pinned?: boolean;
}

export interface SkillTelemetry {
  origin: string;
  /**
   * True only when origin is exactly "background_review". An unattributed skill
   * reads as user-owned on purpose: the curator would rather leave a skill alone
   * than retire one a human wrote.
   */
  agentCreated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  writeCount: number;
  usageCount: number;
  lastUsedAt: string | null;
  pinned: boolean;
  lifecycle: LifecycleState;
  /** Whole days since last use (or creation). null when neither timestamp exists. */
  idleDays: number | null;
}

export interface LedgerEntry {
  id: string;
  ts: string;
  actor: string;
  skill: string;
  path: string;
  action: string;
  before: string | null;
  after: string | null;
}

export interface SkillInventorySummary {
  total: number;
  agentCreated: number;
  pinned: number;
  active: number;
  stale: number;
  archivedByLifecycle: number;
  archivedOnDisk: number;
  neverUsed: number;
  totalUses: number;
  ledgerEntries: number;
  lastMutationAt: string | null;
}

/** The current skills directory for an agent root. */
export function skillsDir(agentRoot: string): string {
  return path.join(agentRoot, 'skills');
}

/**
 * Directories to scan for authored skills, most-current first.
 *
 * The second entry is the legacy location. The API used to read only
 * <agentRoot>/workspace/skills while save_skill has always written to
 * <agentRoot>/skills, so any skill saved before this was fixed sits in one place
 * and was looked for in the other. Both are read; the current root wins on a
 * name collision.
 */
export function authoredSkillDirs(agentRoot: string): string[] {
  return [skillsDir(agentRoot), path.join(agentRoot, 'workspace', 'skills')];
}

function parseTs(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Faithful port of skill_origins.lifecycle_state. */
export function lifecycleState(
  entry: SkillOrigin | undefined,
  now: Date = new Date(),
  staleAfterDays = STALE_AFTER_DAYS,
  archiveAfterDays = ARCHIVE_AFTER_DAYS,
): LifecycleState {
  if (!entry || typeof entry !== 'object' || entry.pinned) return 'active';
  const last = parseTs(entry.last_used_at) ?? parseTs(entry.created_at);
  if (!last) return 'active';
  const idleDays = (now.getTime() - last.getTime()) / 86_400_000;
  if (idleDays >= archiveAfterDays) return 'archived';
  if (idleDays >= staleAfterDays) return 'stale';
  return 'active';
}

/** Read the provenance sidecar. Returns {} when absent or unparseable. */
export function readOrigins(agentRoot: string): Record<string, SkillOrigin> {
  for (const dir of authoredSkillDirs(agentRoot)) {
    const file = path.join(dir, '.origins.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const skills = parsed?.skills;
      if (skills && typeof skills === 'object')
        return skills as Record<string, SkillOrigin>;
    } catch {
      // A half-written sidecar is not worth failing a page render over.
    }
  }
  return {};
}

/** Normalise one sidecar entry into the shape the API and UI use. */
export function telemetryFor(
  entry: SkillOrigin | undefined,
  now: Date = new Date(),
): SkillTelemetry {
  const rawOrigin =
    typeof entry?.origin === 'string' && entry.origin
      ? entry.origin
      : 'unknown';
  const last = parseTs(entry?.last_used_at) ?? parseTs(entry?.created_at);
  return {
    origin: rawOrigin,
    agentCreated: rawOrigin === 'background_review',
    createdAt: entry?.created_at ?? null,
    updatedAt: entry?.updated_at ?? null,
    writeCount: typeof entry?.write_count === 'number' ? entry.write_count : 0,
    usageCount: typeof entry?.usage_count === 'number' ? entry.usage_count : 0,
    lastUsedAt: entry?.last_used_at ?? null,
    pinned: entry?.pinned === true,
    lifecycle: lifecycleState(entry, now),
    idleDays: last
      ? Math.floor((now.getTime() - last.getTime()) / 86_400_000)
      : null,
  };
}

/** Names of skills the curator has retired to .archive/. */
export function readArchived(agentRoot: string): string[] {
  const names = new Set<string>();
  for (const dir of authoredSkillDirs(agentRoot)) {
    const archive = path.join(dir, '.archive');
    if (!fs.existsSync(archive)) continue;
    try {
      for (const dirent of fs.readdirSync(archive, { withFileTypes: true })) {
        if (dirent.isDirectory()) names.add(dirent.name);
      }
    } catch {
      /* unreadable archive dir — report none rather than throwing */
    }
  }
  return [...names].sort();
}

/**
 * Read the mutation ledger, newest first.
 *
 * The file is append-only JSONL written oldest-first; the UI wants recent history
 * at the top, so the order is reversed here. `limit` is applied after reversing.
 */
export function readLedger(agentRoot: string, limit?: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const dir of authoredSkillDirs(agentRoot)) {
    const file = path.join(dir, '.ledger.jsonl');
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          entries.push({
            id: String(parsed.id ?? ''),
            ts: String(parsed.ts ?? ''),
            actor: String(parsed.actor ?? 'unknown'),
            skill: String(parsed.skill ?? ''),
            path: String(parsed.path ?? ''),
            action: String(parsed.action ?? ''),
            before: typeof parsed.before === 'string' ? parsed.before : null,
            after: typeof parsed.after === 'string' ? parsed.after : null,
          });
        }
      } catch {
        // Skip a torn line; a partial write shouldn't hide the rest of the history.
      }
    }
  }
  entries.reverse();
  return typeof limit === 'number' && limit > 0
    ? entries.slice(0, limit)
    : entries;
}

/**
 * Read one content-addressed blob.
 *
 * The digest comes out of a file the container wrote, so it is untrusted input to
 * a path join — anything that is not a bare sha256 hex digest is refused rather
 * than resolved.
 */
export function readBlob(
  agentRoot: string,
  digest: string | null,
): string | null {
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return null;
  for (const dir of authoredSkillDirs(agentRoot)) {
    const file = path.join(dir, '.blobs', digest);
    if (!fs.existsSync(file)) continue;
    try {
      return fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
  }
  return null;
}

/** A ledger entry with its before/after bodies resolved, for a diff view. */
export function readLedgerEntryContents(
  agentRoot: string,
  entryId: string,
):
  | (LedgerEntry & {
      beforeContent: string | null;
      afterContent: string | null;
    })
  | null {
  const entry = readLedger(agentRoot).find((e) => e.id === entryId);
  if (!entry) return null;
  return {
    ...entry,
    beforeContent: readBlob(agentRoot, entry.before),
    afterContent: readBlob(agentRoot, entry.after),
  };
}

/**
 * Roll everything up for the panel header.
 *
 * `names` is the list of skill directory names actually on disk — the sidecar can
 * carry entries for skills that were deleted, and a skill can exist with no sidecar
 * entry, so the two are counted against each other rather than either alone.
 */
export function summarise(
  agentRoot: string,
  names: string[],
  now: Date = new Date(),
): SkillInventorySummary {
  const origins = readOrigins(agentRoot);
  const ledger = readLedger(agentRoot);
  const summary: SkillInventorySummary = {
    total: names.length,
    agentCreated: 0,
    pinned: 0,
    active: 0,
    stale: 0,
    archivedByLifecycle: 0,
    archivedOnDisk: readArchived(agentRoot).length,
    neverUsed: 0,
    totalUses: 0,
    ledgerEntries: ledger.length,
    lastMutationAt: ledger[0]?.ts ?? null,
  };

  for (const name of names) {
    const entry = origins[name];
    const t = telemetryFor(entry, now);
    if (t.agentCreated) summary.agentCreated++;
    if (t.pinned) summary.pinned++;
    if (t.lifecycle === 'active') summary.active++;
    else if (t.lifecycle === 'stale') summary.stale++;
    else summary.archivedByLifecycle++;
    summary.totalUses += t.usageCount;
    // Only counted for skills the sidecar knows about — a skill with no entry has
    // no usage history to be missing, and counting it as "never used" would make
    // pre-telemetry skills look dead.
    if (entry && t.usageCount === 0) summary.neverUsed++;
  }

  return summary;
}
