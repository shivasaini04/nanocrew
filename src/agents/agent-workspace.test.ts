/**
 * Milestone 1.2 — AgentWorkspaceManager
 * Uses OS temp directories so tests are fully isolated and don't touch /data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { AgentWorkspaceManager } from './agent-workspace.js';

let tmpDir: string;
let mgr: AgentWorkspaceManager;
const AGENT_ID = 'agent-test-001';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocrew-ws-test-'));
  mgr = new AgentWorkspaceManager(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── provision ───────────────────────────────────────────────────────────────

describe('provision', () => {
  it('creates the agent root directory and returns its path', () => {
    const root = mgr.provision(AGENT_ID, 'lead_hunter');
    expect(fs.existsSync(root)).toBe(true);
    expect(root).toContain(AGENT_ID);
  });

  it('creates all required subdirectories for lead_hunter', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const root = mgr.getAgentRoot(AGENT_ID);
    expect(fs.existsSync(path.join(root, 'workspace/leads'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workspace/research'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workspace/memory/episodes'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, 'workspace/memory/knowledge'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, 'identity-history'))).toBe(true);
  });

  it('seeds pipeline.json and qualified.csv for lead_hunter', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const pipeline = mgr.readFile(AGENT_ID, 'workspace/leads/pipeline.json');
    const csv = mgr.readFile(AGENT_ID, 'workspace/leads/qualified.csv');
    expect(pipeline).toBe('[]');
    expect(csv).toContain('company');
  });

  it('creates all required subdirectories for outreach', () => {
    mgr.provision(AGENT_ID, 'outreach');
    const root = mgr.getAgentRoot(AGENT_ID);
    expect(fs.existsSync(path.join(root, 'workspace/outbox'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workspace/templates'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'workspace/results'))).toBe(true);
  });

  it('is idempotent — calling provision twice does not error', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    expect(() => mgr.provision(AGENT_ID, 'lead_hunter')).not.toThrow();
  });

  it('does not overwrite existing seed files on second provision', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(
      AGENT_ID,
      'workspace/leads/pipeline.json',
      '[{"company":"existing"}]',
    );
    mgr.provision(AGENT_ID, 'lead_hunter'); // second call
    const content = mgr.readFile(AGENT_ID, 'workspace/leads/pipeline.json');
    expect(content).toContain('existing');
  });
});

// ─── readFile / writeFile ────────────────────────────────────────────────────

describe('readFile / writeFile', () => {
  it('writeFile creates a file with content, readFile returns it', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\nLead Hunter');
    const content = mgr.readFile(AGENT_ID, 'IDENTITY.md');
    expect(content).toBe('## CORE\nLead Hunter');
  });

  it('readFile returns null for a non-existent file', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    expect(mgr.readFile(AGENT_ID, 'does-not-exist.md')).toBeNull();
  });

  it('writeFile creates parent directories automatically', () => {
    mgr.provision(AGENT_ID, 'custom');
    mgr.writeFile(AGENT_ID, 'workspace/deep/nested/file.txt', 'hello');
    expect(mgr.readFile(AGENT_ID, 'workspace/deep/nested/file.txt')).toBe(
      'hello',
    );
  });
});

// ─── listFiles ───────────────────────────────────────────────────────────────

describe('listFiles', () => {
  it('returns workspace files after provisioning', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const files = mgr.listFiles(AGENT_ID);
    const paths = files.map((f) => f.path);
    expect(paths.some((p) => p.includes('leads'))).toBe(true);
  });

  it('lists files in a subdir', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'workspace/leads/extra.json', '{}');
    const files = mgr.listFiles(AGENT_ID, 'workspace/leads');
    const names = files
      .filter((f) => f.type === 'file')
      .map((f) => path.basename(f.path));
    expect(names).toContain('pipeline.json');
    expect(names).toContain('extra.json');
  });

  it('returns empty array for non-existent subdir', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    expect(mgr.listFiles(AGENT_ID, 'workspace/no-such-dir')).toHaveLength(0);
  });
});

// ─── snapshotWorkspace / diffSnapshot ───────────────────────────────────────

describe('snapshotWorkspace / diffSnapshot', () => {
  it('snapshot captures existing files', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\nHello');
    const snap = mgr.snapshotWorkspace(AGENT_ID);
    expect(snap.files.size).toBeGreaterThan(0);
    expect(snap.takenAt).toBeInstanceOf(Date);
  });

  it('diffSnapshot detects a newly created file', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const before = mgr.snapshotWorkspace(AGENT_ID);
    mgr.writeFile(
      AGENT_ID,
      'workspace/leads/new.csv',
      'company,score\nTechCorp,87\n',
    );
    const after = mgr.snapshotWorkspace(AGENT_ID);
    const diffs = mgr.diffSnapshot(before, after);
    const created = diffs.find(
      (d) => d.eventType === 'create' && d.path.includes('new.csv'),
    );
    expect(created).toBeDefined();
  });

  it('diffSnapshot detects a modified file', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\nv1');
    const before = mgr.snapshotWorkspace(AGENT_ID);
    mgr.writeFile(
      AGENT_ID,
      'IDENTITY.md',
      '## CORE\nv1\n## LEARNED\nnew stuff',
    );
    const after = mgr.snapshotWorkspace(AGENT_ID);
    const diffs = mgr.diffSnapshot(before, after);
    const modified = diffs.find(
      (d) => d.eventType === 'write' && d.path.includes('IDENTITY'),
    );
    expect(modified).toBeDefined();
  });

  it('diffSnapshot detects a deleted file', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'workspace/tmp.txt', 'temp');
    const before = mgr.snapshotWorkspace(AGENT_ID);
    fs.unlinkSync(path.join(mgr.getAgentRoot(AGENT_ID), 'workspace/tmp.txt'));
    const after = mgr.snapshotWorkspace(AGENT_ID);
    const diffs = mgr.diffSnapshot(before, after);
    const deleted = diffs.find(
      (d) => d.eventType === 'delete' && d.path.includes('tmp.txt'),
    );
    expect(deleted).toBeDefined();
  });

  it('diffSnapshot returns empty array when nothing changed', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const before = mgr.snapshotWorkspace(AGENT_ID);
    const after = mgr.snapshotWorkspace(AGENT_ID);
    expect(mgr.diffSnapshot(before, after)).toHaveLength(0);
  });

  it('episodes directory is excluded from snapshots', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    const before = mgr.snapshotWorkspace(AGENT_ID);
    // Writing to episodes should NOT appear as a diff
    mgr.writeFile(
      AGENT_ID,
      'workspace/memory/episodes/2026-03-20.md',
      '# Episode',
    );
    const after = mgr.snapshotWorkspace(AGENT_ID);
    const diffs = mgr.diffSnapshot(before, after);
    const episodeDiff = diffs.find((d) => d.path.includes('episodes'));
    expect(episodeDiff).toBeUndefined();
  });
});

// ─── archiveIdentityVersion ──────────────────────────────────────────────────

describe('archiveIdentityVersion', () => {
  it('copies IDENTITY.md to identity-history/v{N}.md', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', '## CORE\nOriginal v1');
    mgr.archiveIdentityVersion(AGENT_ID, 1);
    const archived = mgr.readFile(AGENT_ID, 'identity-history/v1.md');
    expect(archived).toBe('## CORE\nOriginal v1');
  });

  it('does nothing if IDENTITY.md does not exist', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    expect(() => mgr.archiveIdentityVersion(AGENT_ID, 1)).not.toThrow();
  });

  it('creates incrementing version archives', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', 'v1 content');
    mgr.archiveIdentityVersion(AGENT_ID, 1);
    mgr.writeFile(AGENT_ID, 'IDENTITY.md', 'v2 content');
    mgr.archiveIdentityVersion(AGENT_ID, 2);
    expect(mgr.readFile(AGENT_ID, 'identity-history/v1.md')).toBe('v1 content');
    expect(mgr.readFile(AGENT_ID, 'identity-history/v2.md')).toBe('v2 content');
  });
});

// ─── exists / remove ─────────────────────────────────────────────────────────

describe('exists / remove', () => {
  it('exists returns false before provision', () => {
    expect(mgr.exists('brand-new-agent')).toBe(false);
  });

  it('exists returns true after provision', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    expect(mgr.exists(AGENT_ID)).toBe(true);
  });

  it('remove deletes the entire agent root', () => {
    mgr.provision(AGENT_ID, 'lead_hunter');
    mgr.remove(AGENT_ID);
    expect(mgr.exists(AGENT_ID)).toBe(false);
  });
});
