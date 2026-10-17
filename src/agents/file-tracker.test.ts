/**
 * Milestone 1.5 — FileTracker
 * Tests: generatePatch, snapshot, diff (create/write/delete), persistEvents.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import {
  _initTestDatabase,
  getFileEventsByCycle,
  insertAgent,
  createAgentCycle,
} from '../db.js';
import { FileTracker, generatePatch } from './file-tracker.js';
import { AgentWorkspaceManager } from './agent-workspace.js';

let tmpDir: string;
let tracker: FileTracker;
let wsMgr: AgentWorkspaceManager;
const AGENT_ID = 'ft-test-001';

beforeEach(() => {
  _initTestDatabase();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-ft-test-'));
  tracker = new FileTracker(tmpDir);
  wsMgr = new AgentWorkspaceManager(tmpDir);
  wsMgr.provision(AGENT_ID, 'lead_hunter');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── generatePatch ───────────────────────────────────────────────────────────

describe('generatePatch', () => {
  it('returns empty string when content is identical', () => {
    const content = 'line1\nline2\nline3\n';
    expect(generatePatch(content, content, 'test.txt')).toBe('');
  });

  it('generates a patch for a single added line', () => {
    const before = 'line1\nline2\n';
    const after = 'line1\nline2\nline3\n';
    const patch = generatePatch(before, after, 'test.txt');
    expect(patch).toContain('--- a/test.txt');
    expect(patch).toContain('+++ b/test.txt');
    expect(patch).toContain('+line3');
  });

  it('generates a patch for a removed line', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nline3\n';
    const patch = generatePatch(before, after, 'test.txt');
    expect(patch).toContain('-line2');
  });

  it('generates a patch for a modified line', () => {
    const before = 'hello world\n';
    const after = 'hello earth\n';
    const patch = generatePatch(before, after, 'test.txt');
    expect(patch).toContain('-hello world');
    expect(patch).toContain('+hello earth');
  });

  it('includes the file path in the header', () => {
    const patch = generatePatch('a\n', 'b\n', 'workspace/leads/pipeline.json');
    expect(patch).toContain('--- a/workspace/leads/pipeline.json');
    expect(patch).toContain('+++ b/workspace/leads/pipeline.json');
  });
});

// ─── snapshot ────────────────────────────────────────────────────────────────

describe('snapshot', () => {
  it('captures files in the workspace', () => {
    wsMgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\n');
    const snap = tracker.snapshot(AGENT_ID);
    expect(snap.files.size).toBeGreaterThan(0);
    expect(snap.takenAt).toBeInstanceOf(Date);
  });

  it('returns an empty snapshot for a non-existent agent', () => {
    const snap = tracker.snapshot('non-existent-agent');
    expect(snap.files.size).toBe(0);
  });
});

// ─── diff ────────────────────────────────────────────────────────────────────

describe('diff', () => {
  it('detects a newly created file with a patch', () => {
    const before = tracker.snapshot(AGENT_ID);
    wsMgr.writeFile(
      AGENT_ID,
      'workspace/leads/new.csv',
      'company,score\nAcme,85\n',
    );
    const after = tracker.snapshot(AGENT_ID);

    const diffs = tracker.diff(AGENT_ID, before, after);
    const created = diffs.find(
      (d) => d.eventType === 'create' && d.path.includes('new.csv'),
    );
    expect(created).toBeDefined();
    expect(created!.patch).not.toBeNull();
    expect(created!.patch).toContain('+company,score');
  });

  it('detects a modified file', () => {
    wsMgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\nv1\n');
    const before = tracker.snapshot(AGENT_ID);
    wsMgr.writeFile(
      AGENT_ID,
      'IDENTITY.md',
      '## CORE\nv1\n## LEARNED\nnew info\n',
    );
    const after = tracker.snapshot(AGENT_ID);

    const diffs = tracker.diff(AGENT_ID, before, after);
    const modified = diffs.find(
      (d) => d.eventType === 'write' && d.path.includes('IDENTITY'),
    );
    expect(modified).toBeDefined();
  });

  it('detects a deleted file with null patch', () => {
    wsMgr.writeFile(AGENT_ID, 'workspace/tmp.txt', 'temp');
    const before = tracker.snapshot(AGENT_ID);
    fs.unlinkSync(path.join(tmpDir, AGENT_ID, 'workspace/tmp.txt'));
    const after = tracker.snapshot(AGENT_ID);

    const diffs = tracker.diff(AGENT_ID, before, after);
    const deleted = diffs.find(
      (d) => d.eventType === 'delete' && d.path.includes('tmp.txt'),
    );
    expect(deleted).toBeDefined();
    expect(deleted!.patch).toBeNull();
  });

  it('returns empty array when nothing changed', () => {
    const before = tracker.snapshot(AGENT_ID);
    const after = tracker.snapshot(AGENT_ID);
    expect(tracker.diff(AGENT_ID, before, after)).toHaveLength(0);
  });
});

// ─── persistEvents ───────────────────────────────────────────────────────────

describe('persistEvents', () => {
  it('inserts file events into agent_file_events table', () => {
    // Set up minimal DB state: need an agent row + cycle row
    const now = new Date().toISOString();
    insertAgent({
      id: AGENT_ID,
      name: 'Test',
      type: 'lead_hunter',
      status: 'running',
      workspace: tmpDir,
      config: {
        schedule: [],
        budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
        tools: [],
        goals: 'test',
        escalationRules: [],
      },
      identity_version: 1,
      created_at: now,
    });

    const cycle = createAgentCycle({
      agent_id: AGENT_ID,
      cycle_type: 'lead_search',
      status: 'running',
      started_at: now,
      cost: 0,
      tasks_done: 0,
    });

    const diffs = [
      {
        path: 'workspace/leads/new.csv',
        eventType: 'create' as const,
        patch: '+company,score\n+Acme,85\n',
      },
      { path: 'workspace/tmp.txt', eventType: 'delete' as const, patch: null },
    ];

    tracker.persistEvents(AGENT_ID, cycle.id, diffs);

    const events = getFileEventsByCycle(cycle.id);
    expect(events).toHaveLength(2);
    expect(
      events.some(
        (e) => e.event_type === 'create' && e.file_path.includes('new.csv'),
      ),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.event_type === 'delete' && e.file_path.includes('tmp.txt'),
      ),
    ).toBe(true);
    expect(events.find((e) => e.event_type === 'create')!.diff_patch).toContain(
      '+company,score',
    );
    expect(
      events.find((e) => e.event_type === 'delete')!.diff_patch,
    ).toBeNull();
  });

  it('persists zero events without error', () => {
    expect(() =>
      tracker.persistEvents(AGENT_ID, 'fake-cycle-id', []),
    ).not.toThrow();
  });
});
