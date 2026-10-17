/**
 * Stage 42 — skill-inventory reader.
 *
 * Covers the lifecycle port, the sidecar/ledger/blob readers, the legacy-path
 * fallback, and a drift test that pins the TS thresholds to the Python ones.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  STALE_AFTER_DAYS,
  ARCHIVE_AFTER_DAYS,
  authoredSkillDirs,
  lifecycleState,
  readOrigins,
  readArchived,
  readLedger,
  readBlob,
  readLedgerEntryContents,
  telemetryFor,
  summarise,
} from './skill-inventory.js';

let agentRoot: string;

const NOW = new Date('2026-08-23T00:00:00Z');
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-skillinv-'));
});

afterEach(() => {
  fs.rmSync(agentRoot, { recursive: true, force: true });
});

function writeSidecar(skills: Record<string, unknown>, dir = 'skills') {
  const target = path.join(agentRoot, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(
    path.join(target, '.origins.json'),
    JSON.stringify({ version: 1, skills }),
  );
}

// ─── constant drift ──────────────────────────────────────────────────────────

describe('threshold constants', () => {
  it('match the Python definition they are copied from', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const py = path.resolve(
      here,
      '../../container/nanoagent/nanoagent/agent/skill_origins.py',
    );
    // If this file moved, the drift test is worthless — fail loudly rather than skip.
    expect(fs.existsSync(py), `expected skill_origins.py at ${py}`).toBe(true);
    const src = fs.readFileSync(py, 'utf-8');
    const stale = src.match(/^STALE_AFTER_DAYS\s*=\s*(\d+)/m);
    const archive = src.match(/^ARCHIVE_AFTER_DAYS\s*=\s*(\d+)/m);
    expect(stale?.[1]).toBeDefined();
    expect(archive?.[1]).toBeDefined();
    expect(Number(stale![1])).toBe(STALE_AFTER_DAYS);
    expect(Number(archive![1])).toBe(ARCHIVE_AFTER_DAYS);
  });
});

// ─── lifecycle ───────────────────────────────────────────────────────────────

describe('lifecycleState', () => {
  it('is active with no entry at all', () => {
    expect(lifecycleState(undefined, NOW)).toBe('active');
  });

  it('is active when neither timestamp is present', () => {
    expect(lifecycleState({ origin: 'user' }, NOW)).toBe('active');
  });

  it('falls back to created_at when never used', () => {
    expect(lifecycleState({ created_at: daysAgo(45) }, NOW)).toBe('stale');
  });

  it('prefers last_used_at over created_at', () => {
    expect(
      lifecycleState(
        { created_at: daysAgo(200), last_used_at: daysAgo(1) },
        NOW,
      ),
    ).toBe('active');
  });

  it('crosses to stale exactly at the threshold', () => {
    expect(lifecycleState({ last_used_at: daysAgo(29.9) }, NOW)).toBe('active');
    expect(lifecycleState({ last_used_at: daysAgo(30) }, NOW)).toBe('stale');
  });

  it('crosses to archived exactly at the threshold', () => {
    expect(lifecycleState({ last_used_at: daysAgo(89.9) }, NOW)).toBe('stale');
    expect(lifecycleState({ last_used_at: daysAgo(90) }, NOW)).toBe('archived');
  });

  it('pinned bypasses every transition', () => {
    expect(
      lifecycleState({ last_used_at: daysAgo(400), pinned: true }, NOW),
    ).toBe('active');
  });

  it('treats an unparseable timestamp as no timestamp', () => {
    expect(lifecycleState({ last_used_at: 'not-a-date' }, NOW)).toBe('active');
  });
});

// ─── telemetry ───────────────────────────────────────────────────────────────

describe('telemetryFor', () => {
  it('marks only background_review as agent-created', () => {
    expect(telemetryFor({ origin: 'background_review' }).agentCreated).toBe(
      true,
    );
    expect(telemetryFor({ origin: 'user' }).agentCreated).toBe(false);
    // Unattributed reads as user-owned on purpose — the curator must not eat it.
    expect(telemetryFor(undefined).agentCreated).toBe(false);
    expect(telemetryFor({ origin: 'subagent' }).agentCreated).toBe(false);
  });

  it('defaults counters to zero and origin to unknown', () => {
    const t = telemetryFor(undefined);
    expect(t.origin).toBe('unknown');
    expect(t.usageCount).toBe(0);
    expect(t.writeCount).toBe(0);
    expect(t.pinned).toBe(false);
    expect(t.idleDays).toBeNull();
  });

  it('reports whole idle days', () => {
    expect(telemetryFor({ last_used_at: daysAgo(3.5) }, NOW).idleDays).toBe(3);
  });
});

// ─── sidecar ─────────────────────────────────────────────────────────────────

describe('readOrigins', () => {
  it('returns {} when there is no sidecar', () => {
    expect(readOrigins(agentRoot)).toEqual({});
  });

  it('reads the current location', () => {
    writeSidecar({ alpha: { origin: 'user', usage_count: 2 } });
    expect(readOrigins(agentRoot).alpha.usage_count).toBe(2);
  });

  it('falls back to the legacy workspace/skills location', () => {
    writeSidecar(
      { legacy: { origin: 'user' } },
      path.join('workspace', 'skills'),
    );
    expect(Object.keys(readOrigins(agentRoot))).toEqual(['legacy']);
  });

  it('prefers the current location over the legacy one', () => {
    writeSidecar({ a: { usage_count: 9 } });
    writeSidecar({ a: { usage_count: 1 } }, path.join('workspace', 'skills'));
    expect(readOrigins(agentRoot).a.usage_count).toBe(9);
  });

  it('survives a corrupt sidecar', () => {
    fs.mkdirSync(path.join(agentRoot, 'skills'), { recursive: true });
    fs.writeFileSync(
      path.join(agentRoot, 'skills', '.origins.json'),
      '{"version":1,"skil',
    );
    expect(readOrigins(agentRoot)).toEqual({});
  });
});

describe('authoredSkillDirs', () => {
  it('lists the current root before the legacy path', () => {
    expect(authoredSkillDirs('/agents/x')).toEqual([
      path.join('/agents/x', 'skills'),
      path.join('/agents/x', 'workspace', 'skills'),
    ]);
  });
});

// ─── archive ─────────────────────────────────────────────────────────────────

describe('readArchived', () => {
  it('lists retired skill directories, sorted and de-duplicated', () => {
    const archive = path.join(agentRoot, 'skills', '.archive');
    fs.mkdirSync(path.join(archive, 'zeta'), { recursive: true });
    fs.mkdirSync(path.join(archive, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(archive, 'notes.txt'), 'x');
    fs.mkdirSync(
      path.join(agentRoot, 'workspace', 'skills', '.archive', 'alpha'),
      { recursive: true },
    );
    expect(readArchived(agentRoot)).toEqual(['alpha', 'zeta']);
  });

  it('returns [] when nothing was archived', () => {
    expect(readArchived(agentRoot)).toEqual([]);
  });
});

// ─── ledger + blobs ──────────────────────────────────────────────────────────

function writeLedger(lines: unknown[]) {
  const dir = path.join(agentRoot, 'skills');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.ledger.jsonl'),
    lines
      .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n') + '\n',
  );
}

describe('readLedger', () => {
  it('returns [] when there is no ledger', () => {
    expect(readLedger(agentRoot)).toEqual([]);
  });

  it('returns entries newest first', () => {
    writeLedger([
      { id: 'a1', ts: '2026-08-01T00:00:00Z', skill: 'one', action: 'create' },
      { id: 'b2', ts: '2026-08-02T00:00:00Z', skill: 'one', action: 'update' },
    ]);
    expect(readLedger(agentRoot).map((e) => e.id)).toEqual(['b2', 'a1']);
  });

  it('applies the limit after reversing', () => {
    writeLedger([
      { id: 'a1', ts: '2026-08-01T00:00:00Z' },
      { id: 'b2', ts: '2026-08-02T00:00:00Z' },
      { id: 'c3', ts: '2026-08-03T00:00:00Z' },
    ]);
    expect(readLedger(agentRoot, 2).map((e) => e.id)).toEqual(['c3', 'b2']);
  });

  it('skips a torn line without losing the rest', () => {
    writeLedger([
      { id: 'a1', ts: '2026-08-01T00:00:00Z' },
      '{"id":"broke',
      { id: 'c3', ts: '2026-08-03T00:00:00Z' },
    ]);
    expect(readLedger(agentRoot).map((e) => e.id)).toEqual(['c3', 'a1']);
  });

  it('defaults a missing actor rather than dropping the entry', () => {
    writeLedger([{ id: 'a1', ts: '2026-08-01T00:00:00Z' }]);
    expect(readLedger(agentRoot)[0].actor).toBe('unknown');
  });
});

describe('readBlob', () => {
  const digest = 'a'.repeat(64);

  it('reads a blob by digest', () => {
    const dir = path.join(agentRoot, 'skills', '.blobs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, digest), 'hello');
    expect(readBlob(agentRoot, digest)).toBe('hello');
  });

  it('returns null for null and for a missing blob', () => {
    expect(readBlob(agentRoot, null)).toBeNull();
    expect(readBlob(agentRoot, digest)).toBeNull();
  });

  it('refuses anything that is not a bare sha256 digest', () => {
    // The digest comes from a container-written file, so it is untrusted path input.
    expect(readBlob(agentRoot, '../../../../etc/passwd')).toBeNull();
    expect(readBlob(agentRoot, 'a'.repeat(63))).toBeNull();
    expect(readBlob(agentRoot, 'A'.repeat(64))).toBeNull();
    expect(readBlob(agentRoot, `${digest}/../x`)).toBeNull();
  });
});

describe('readLedgerEntryContents', () => {
  it('resolves before/after bodies', () => {
    const before = 'b'.repeat(64);
    const after = 'c'.repeat(64);
    const blobs = path.join(agentRoot, 'skills', '.blobs');
    fs.mkdirSync(blobs, { recursive: true });
    fs.writeFileSync(path.join(blobs, before), 'old body');
    fs.writeFileSync(path.join(blobs, after), 'new body');
    writeLedger([
      {
        id: 'e1',
        ts: '2026-08-01T00:00:00Z',
        skill: 's',
        action: 'update',
        before,
        after,
      },
    ]);

    const entry = readLedgerEntryContents(agentRoot, 'e1');
    expect(entry?.beforeContent).toBe('old body');
    expect(entry?.afterContent).toBe('new body');
  });

  it('returns null for an unknown entry id', () => {
    writeLedger([{ id: 'e1', ts: '2026-08-01T00:00:00Z' }]);
    expect(readLedgerEntryContents(agentRoot, 'nope')).toBeNull();
  });

  it('leaves content null when a create has no before blob', () => {
    writeLedger([
      {
        id: 'e1',
        ts: '2026-08-01T00:00:00Z',
        action: 'create',
        before: null,
        after: null,
      },
    ]);
    expect(readLedgerEntryContents(agentRoot, 'e1')?.beforeContent).toBeNull();
  });
});

// ─── summary ─────────────────────────────────────────────────────────────────

describe('summarise', () => {
  it('is all zeroes for an agent with nothing', () => {
    const s = summarise(agentRoot, [], NOW);
    expect(s.total).toBe(0);
    expect(s.ledgerEntries).toBe(0);
    expect(s.lastMutationAt).toBeNull();
  });

  it('rolls up lifecycle, provenance and usage', () => {
    writeSidecar({
      fresh: {
        origin: 'background_review',
        usage_count: 5,
        last_used_at: daysAgo(1),
      },
      idle: { origin: 'user', usage_count: 2, last_used_at: daysAgo(40) },
      dead: { origin: 'user', usage_count: 1, last_used_at: daysAgo(120) },
      kept: {
        origin: 'user',
        usage_count: 0,
        last_used_at: daysAgo(500),
        pinned: true,
      },
    });
    const s = summarise(agentRoot, ['fresh', 'idle', 'dead', 'kept'], NOW);
    expect(s.total).toBe(4);
    expect(s.agentCreated).toBe(1);
    expect(s.pinned).toBe(1);
    expect(s.active).toBe(2); // fresh + kept
    expect(s.stale).toBe(1);
    expect(s.archivedByLifecycle).toBe(1);
    expect(s.totalUses).toBe(8);
    expect(s.neverUsed).toBe(1); // kept
  });

  it('does not count a skill with no sidecar entry as never-used', () => {
    writeSidecar({
      known: { origin: 'user', usage_count: 3, last_used_at: daysAgo(1) },
    });
    const s = summarise(agentRoot, ['known', 'pre-telemetry'], NOW);
    expect(s.total).toBe(2);
    expect(s.neverUsed).toBe(0);
  });

  it('reports the newest mutation timestamp', () => {
    writeLedger([
      { id: 'a1', ts: '2026-08-01T00:00:00Z' },
      { id: 'b2', ts: '2026-08-05T00:00:00Z' },
    ]);
    const s = summarise(agentRoot, [], NOW);
    expect(s.ledgerEntries).toBe(2);
    expect(s.lastMutationAt).toBe('2026-08-05T00:00:00Z');
  });

  it('counts archived-on-disk separately from lifecycle-archived', () => {
    fs.mkdirSync(path.join(agentRoot, 'skills', '.archive', 'gone'), {
      recursive: true,
    });
    writeSidecar({ live: { origin: 'user', last_used_at: daysAgo(1) } });
    const s = summarise(agentRoot, ['live'], NOW);
    expect(s.archivedOnDisk).toBe(1);
    expect(s.archivedByLifecycle).toBe(0);
  });
});
