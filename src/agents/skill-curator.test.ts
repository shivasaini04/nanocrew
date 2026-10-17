/**
 * Stage 42 #4, cheap half — the orchestrator-side lifecycle sweep.
 *
 * The invariants here are the reason it is safe to run unattended, and they are the
 * same ones curator.py states: only agent-created skills, pinned bypasses everything,
 * archive never deletes, and every move is ledgered before it happens.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { sweep, sweepQuietly, summarise } = await import('./skill-curator.js');
const { readLedger, readBlob, readArchived } =
  await import('./skill-inventory.js');

let agentRoot: string;
const NOW = new Date('2026-08-23T00:00:00Z');
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-curator-'));
});

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true });
});

function skill(name: string, body = '# how to do the thing') {
  const dir = path.join(agentRoot, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

function sidecar(skills: Record<string, unknown>) {
  const dir = path.join(agentRoot, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.origins.json'),
    JSON.stringify({ version: 1, skills }),
  );
}

const agentWrote = (idleDays: number, extra: Record<string, unknown> = {}) => ({
  origin: 'background_review',
  created_at: daysAgo(idleDays + 10),
  last_used_at: daysAgo(idleDays),
  usage_count: 3,
  ...extra,
});

// ─── what it may touch ───────────────────────────────────────────────────────

describe('eligibility', () => {
  it('archives an agent-written skill idle past 90 days', () => {
    skill('old-trick');
    sidecar({ 'old-trick': agentWrote(120) });

    const r = sweep(agentRoot, { now: NOW });

    expect(r.archived).toEqual(['old-trick']);
    expect(fs.existsSync(path.join(agentRoot, 'skills', 'old-trick'))).toBe(
      false,
    );
    expect(readArchived(agentRoot)).toEqual(['old-trick']);
  });

  it('never touches a skill the user wrote, however old', () => {
    skill('user-rule');
    sidecar({ 'user-rule': { origin: 'user', last_used_at: daysAgo(900) } });

    const r = sweep(agentRoot, { now: NOW });

    expect(r.archived).toEqual([]);
    expect(
      fs.existsSync(path.join(agentRoot, 'skills', 'user-rule', 'SKILL.md')),
    ).toBe(true);
  });

  it('never touches a foreground assistant write', () => {
    skill('asked-for');
    sidecar({
      'asked-for': { origin: 'assistant_tool', last_used_at: daysAgo(900) },
    });

    expect(sweep(agentRoot, { now: NOW }).archived).toEqual([]);
  });

  it('never touches a skill with no sidecar entry', () => {
    // Unrecorded is user-owned by construction — it predates the sidecar or was
    // written by a path that never stamped one.
    skill('untracked');

    expect(sweep(agentRoot, { now: NOW }).archived).toEqual([]);
    expect(fs.existsSync(path.join(agentRoot, 'skills', 'untracked'))).toBe(
      true,
    );
  });

  it('pinned bypasses archiving entirely', () => {
    skill('kept');
    sidecar({ kept: agentWrote(900, { pinned: true }) });

    const r = sweep(agentRoot, { now: NOW });

    expect(r.archived).toEqual([]);
    expect(r.stale).toEqual([]);
    expect(fs.existsSync(path.join(agentRoot, 'skills', 'kept'))).toBe(true);
  });

  it('reports stale but leaves it alone', () => {
    skill('drifting');
    sidecar({ drifting: agentWrote(45) });

    const r = sweep(agentRoot, { now: NOW });

    expect(r.stale).toEqual(['drifting']);
    expect(r.archived).toEqual([]);
    expect(fs.existsSync(path.join(agentRoot, 'skills', 'drifting'))).toBe(
      true,
    );
  });

  it('leaves an active skill out of the report entirely', () => {
    skill('in-use');
    sidecar({ 'in-use': agentWrote(2) });

    const r = sweep(agentRoot, { now: NOW });

    expect(r).toMatchObject({ archived: [], stale: [], skipped: [] });
  });
});

// ─── the audit trail ─────────────────────────────────────────────────────────

describe('ledgering', () => {
  it('records the retirement as the curator, with the body recoverable', () => {
    skill('old-trick', 'THE ORIGINAL BODY');
    sidecar({ 'old-trick': agentWrote(120) });

    sweep(agentRoot, { now: NOW });

    const entries = readLedger(agentRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: 'curator',
      action: 'delete',
      skill: 'old-trick',
      after: null,
    });
    // Archive is recoverable — the point of never deleting.
    expect(readBlob(agentRoot, entries[0].before)).toBe('THE ORIGINAL BODY');
  });

  it('writes a timestamp in the same format the Python ledger uses', () => {
    skill('old-trick');
    sidecar({ 'old-trick': agentWrote(120) });

    sweep(agentRoot, { now: NOW });

    expect(readLedger(agentRoot)[0].ts).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    );
  });

  it('deduplicates blobs by content hash', () => {
    skill('a', 'SAME BODY');
    skill('b', 'SAME BODY');
    sidecar({ a: agentWrote(120), b: agentWrote(130) });

    sweep(agentRoot, { now: NOW });

    const blobs = fs.readdirSync(path.join(agentRoot, 'skills', '.blobs'));
    expect(blobs).toHaveLength(1);
    expect(readLedger(agentRoot).map((e) => e.before)).toEqual([
      blobs[0],
      blobs[0],
    ]);
  });

  it('leaves no .tmp files behind', () => {
    skill('old-trick');
    sidecar({ 'old-trick': agentWrote(120) });

    sweep(agentRoot, { now: NOW });

    const blobs = fs.readdirSync(path.join(agentRoot, 'skills', '.blobs'));
    expect(blobs.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ─── safety ──────────────────────────────────────────────────────────────────

describe('safety', () => {
  it('is idempotent — a second sweep does nothing', () => {
    skill('old-trick');
    sidecar({ 'old-trick': agentWrote(120) });

    sweep(agentRoot, { now: NOW });
    const second = sweep(agentRoot, { now: NOW });

    expect(second.archived).toEqual([]);
    expect(readLedger(agentRoot)).toHaveLength(1);
  });

  it('dryRun reports without moving anything', () => {
    skill('old-trick');
    sidecar({ 'old-trick': agentWrote(120) });

    const r = sweep(agentRoot, { now: NOW, dryRun: true });

    expect(r.archived).toEqual(['old-trick']);
    expect(r.dryRun).toBe(true);
    expect(fs.existsSync(path.join(agentRoot, 'skills', 'old-trick'))).toBe(
      true,
    );
    expect(readLedger(agentRoot)).toEqual([]);
  });

  it('skips an entry whose directory is already gone', () => {
    // The sidecar outlives a hand-deleted skill; that is not an error.
    sidecar({ ghost: agentWrote(120) });
    fs.mkdirSync(path.join(agentRoot, 'skills'), { recursive: true });

    const r = sweep(agentRoot, { now: NOW });

    expect(r.skipped).toEqual(['ghost']);
    expect(r.archived).toEqual([]);
  });

  it('replaces an existing archive entry of the same name', () => {
    fs.mkdirSync(path.join(agentRoot, 'skills', '.archive', 'old-trick'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(agentRoot, 'skills', '.archive', 'old-trick', 'SKILL.md'),
      'PREVIOUS',
    );
    skill('old-trick', 'CURRENT');
    sidecar({ 'old-trick': agentWrote(120) });

    sweep(agentRoot, { now: NOW });

    const archived = path.join(
      agentRoot,
      'skills',
      '.archive',
      'old-trick',
      'SKILL.md',
    );
    expect(fs.readFileSync(archived, 'utf-8')).toBe('CURRENT');
  });

  it('does nothing on an agent that has no skills directory', () => {
    expect(sweep(agentRoot, { now: NOW })).toMatchObject({
      archived: [],
      stale: [],
    });
  });

  it('sweepQuietly swallows a failure instead of failing the cycle', () => {
    expect(
      sweepQuietly(path.join(agentRoot, 'nope'), 'agent-1'),
    ).not.toBeUndefined();
  });
});

describe('summarise', () => {
  it('reads as a sentence in both modes', () => {
    expect(
      summarise({ archived: ['a'], stale: ['b'], skipped: [], dryRun: false }),
    ).toBe('Curator: archived 1, 1 going stale.');
    expect(
      summarise({ archived: [], stale: [], skipped: [], dryRun: true }),
    ).toBe('Curator: would archive 0.');
  });
});

// ─── parity with the Python it mirrors ───────────────────────────────────────

describe('parity with curator.py', () => {
  it('uses the same archive directory, ledger action and actor', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const agentDir = path.resolve(
      here,
      '../../container/nanoagent/nanoagent/agent',
    );

    const curatorPy = fs.readFileSync(
      path.join(agentDir, 'curator.py'),
      'utf-8',
    );
    expect(curatorPy).toMatch(/^ARCHIVE_DIR_NAME = "\.archive"$/m);

    const ledgerPy = fs.readFileSync(
      path.join(agentDir, 'skill_ledger.py'),
      'utf-8',
    );
    expect(ledgerPy).toMatch(/^DELETE = "delete"$/m);
    expect(ledgerPy).toMatch(/^LEDGER_NAME = "\.ledger\.jsonl"$/m);
    expect(ledgerPy).toMatch(/^BLOB_DIR_NAME = "\.blobs"$/m);

    const originPy = fs.readFileSync(
      path.join(agentDir, 'tool_origin.py'),
      'utf-8',
    );
    expect(originPy).toMatch(/^CURATOR = "curator"$/m);
    // The curator's allowlist is exactly background_review — not "anything not user".
    expect(originPy).toMatch(/return origin == BACKGROUND_REVIEW/);
  });
});
