import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { AgentType } from '../types.js';

export interface WorkspaceFile {
  path: string; // relative to agent root
  size: number;
  modified: string; // ISO timestamp
  type: 'file' | 'dir';
}

export interface WorkspaceSnapshot {
  takenAt: Date;
  files: Map<string, { mtime: number; hash: string; size: number }>;
}

export interface FileDiff {
  path: string;
  eventType: 'create' | 'write' | 'delete';
  patch: string | null;
}

// ─── Type-specific subdirectory templates ────────────────────────────────────

const WORKSPACE_TEMPLATES: Record<AgentType, string[]> = {
  lead_hunter: [
    'workspace/leads',
    'workspace/research',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  outreach: [
    'workspace/outbox',
    'workspace/templates',
    'workspace/results',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  market_research: [
    'workspace/competitors',
    'workspace/trends',
    'workspace/reports',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  analytics: [
    'workspace/data',
    'workspace/reports',
    'workspace/dashboards',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  followup: [
    'workspace/queue',
    'workspace/history',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  content: [
    'workspace/drafts',
    'workspace/published',
    'workspace/calendar',
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
  custom: [
    'workspace/memory/episodes',
    'workspace/memory/knowledge',
    'identity-history',
  ],
};

// Seed files created for each agent type (relative path → content)
const SEED_FILES: Record<AgentType, Record<string, string>> = {
  lead_hunter: {
    'workspace/leads/pipeline.json': '[]',
    'workspace/leads/qualified.csv': 'company,contact,email,score,signals\n',
  },
  outreach: {
    'workspace/outbox/sent.jsonl': '',
    'workspace/results/replies.jsonl': '',
  },
  market_research: {},
  analytics: {},
  followup: {
    'workspace/queue/pending.json': '[]',
  },
  content: {
    'workspace/calendar/schedule.json': '[]',
  },
  custom: {},
};

// Files to exclude from diff tracking (too noisy)
const DIFF_EXCLUSIONS = ['workspace/memory/episodes'];

// Written to each agent root so the directory layout is self-explaining. The key idea:
// the ROOT holds agent *state* (read by the agent, owned by the orchestrator/runtime),
// while workspace/ is the agent's *writable working area*.
export const STRUCTURE_DOC = `# Agent directory layout

This folder is one agent. Two zones:

## Root — agent STATE (the runtime owns these; the agent mostly reads them)
- \`IDENTITY.md\`, \`SCHEMA.md\`, \`config.json\`, \`mcp-servers.json\` — who this agent is + its config.
- \`memory/\` — **canonical** long-term memory. \`MEMORY.md\` (a view synced from the DB) and
  \`memories.jsonl\` are injected into the agent each cycle. The agent does **not** write here directly.
- \`sessions/\` — full conversation/work transcripts (JSONL). Searchable via the \`session_search\` tool.
- \`tools/\` — the agent's **generated tools**, canonical + versioned (one folder per tool: \`manifest.yaml\`,
  \`src/\`, \`versions/\`, \`test_results.json\`).
- \`references/\` — pinned reference documents.
- \`identity-history/\` — past versions of IDENTITY.md.
- \`.nanocrew/\` — telemetry (internal).

## workspace/ — the agent's WORKING area (this is where its file tools write)
- The agent's output files live here (reports, drafts, data, etc.).
- \`workspace/memory/episodes/\` — daily episode logs the agent writes; the memory-distiller reads
  these to update the canonical \`memory/\` above. (This is the *write* side of memory — that's why
  memory appears both here and at the root: root = read-only canonical, workspace = agent-written.)
- \`workspace/memory/knowledge/\` — agent-curated knowledge notes.
- \`workspace/skills/\` — skills the agent authored via \`save_skill\` (its own how-to playbooks).
- role-specific folders (e.g. \`leads/\`, \`research/\`, \`drafts/\`) depending on the agent type.

Tools are saved at the root (\`tools/\`); skills are saved under \`workspace/skills/\` — that asymmetry is
just which component writes them. Build scratch from making a tool is cleaned up automatically.
`;

export class AgentWorkspaceManager {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Provision the full directory tree and seed files for an agent. Returns workspace root path.
   * Phase A5 Task 1.5 — accepts optional extra workspace folders on top of the type defaults.
   */
  provision(
    agentId: string,
    agentType: AgentType,
    customWorkspaceDirs?: Array<{ name: string }>,
  ): string {
    const agentRoot = this.getAgentRoot(agentId);
    const dirs = WORKSPACE_TEMPLATES[agentType] ?? WORKSPACE_TEMPLATES.custom;

    // Create directories (type defaults)
    for (const dir of dirs) {
      fs.mkdirSync(path.join(agentRoot, dir), { recursive: true });
    }

    // Phase A5 Task 1.5 — create custom workspace folders under workspace/
    // Names were sanitised at the API boundary; defensive re-check here.
    if (customWorkspaceDirs?.length) {
      for (const d of customWorkspaceDirs) {
        if (!/^[a-z0-9_-]+$/i.test(d.name) || d.name.length > 40) continue;
        fs.mkdirSync(path.join(agentRoot, 'workspace', d.name), {
          recursive: true,
        });
      }
    }

    // Always create a references/ sibling to workspace (Phase A5 Task 1.2 destination)
    fs.mkdirSync(path.join(agentRoot, 'references'), { recursive: true });

    // Seed initial files
    const seeds = SEED_FILES[agentType] ?? {};
    for (const [relPath, content] of Object.entries(seeds)) {
      const fullPath = path.join(agentRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        fs.writeFileSync(fullPath, content, 'utf-8');
      }
    }

    // Self-documenting layout so the dir tree isn't a mystery.
    fs.writeFileSync(
      path.join(agentRoot, 'STRUCTURE.md'),
      STRUCTURE_DOC,
      'utf-8',
    );

    return agentRoot;
  }

  /** Full path to the agent's root directory. */
  getAgentRoot(agentId: string): string {
    return path.join(this.baseDir, agentId);
  }

  /** Full path to the agent's workspace subdirectory. */
  getWorkspacePath(agentId: string): string {
    return path.join(this.getAgentRoot(agentId), 'workspace');
  }

  /** Read a file relative to the agent root. Returns null if missing. */
  readFile(agentId: string, relativePath: string): string | null {
    const fullPath = path.join(this.getAgentRoot(agentId), relativePath);
    try {
      return fs.readFileSync(fullPath, 'utf-8');
    } catch {
      return null;
    }
  }

  /** Write a file relative to the agent root (creates parent dirs if needed). */
  writeFile(agentId: string, relativePath: string, content: string): void {
    const fullPath = path.join(this.getAgentRoot(agentId), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  /** List all files recursively under the agent root. */
  listFiles(agentId: string, subdir?: string): WorkspaceFile[] {
    const base = subdir
      ? path.join(this.getAgentRoot(agentId), subdir)
      : this.getAgentRoot(agentId);
    if (!fs.existsSync(base)) return [];
    return this._walk(base, base);
  }

  /** Take a content-hash snapshot of the workspace (excluding noisy dirs). */
  snapshotWorkspace(agentId: string): WorkspaceSnapshot {
    const root = this.getAgentRoot(agentId);
    const files = new Map<
      string,
      { mtime: number; hash: string; size: number }
    >();
    if (!fs.existsSync(root)) return { takenAt: new Date(), files };
    this._snapshotDir(root, root, files);
    return { takenAt: new Date(), files };
  }

  /** Compute the diff between two snapshots. Returns FileDiff[] for changed files. */
  diffSnapshot(
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
  ): FileDiff[] {
    const diffs: FileDiff[] = [];
    const beforeKeys = new Set(before.files.keys());
    const afterKeys = new Set(after.files.keys());

    // Created files
    for (const p of afterKeys) {
      if (!beforeKeys.has(p)) {
        diffs.push({ path: p, eventType: 'create', patch: null });
      }
    }

    // Deleted files
    for (const p of beforeKeys) {
      if (!afterKeys.has(p)) {
        diffs.push({ path: p, eventType: 'delete', patch: null });
      }
    }

    // Modified files
    for (const p of afterKeys) {
      if (
        beforeKeys.has(p) &&
        before.files.get(p)!.hash !== after.files.get(p)!.hash
      ) {
        diffs.push({ path: p, eventType: 'write', patch: null });
      }
    }

    return diffs;
  }

  /** Archive current IDENTITY.md to identity-history/v{version}.md */
  archiveIdentityVersion(agentId: string, version: number): void {
    const identityPath = path.join(this.getAgentRoot(agentId), 'IDENTITY.md');
    const archiveDir = path.join(
      this.getAgentRoot(agentId),
      'identity-history',
    );
    const archivePath = path.join(archiveDir, `v${version}.md`);

    if (!fs.existsSync(identityPath)) return;
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.copyFileSync(identityPath, archivePath);
  }

  /** Append content to a file (creates it if it doesn't exist). */
  appendFile(agentId: string, relativePath: string, content: string): void {
    const fullPath = path.join(this.getAgentRoot(agentId), relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.appendFileSync(fullPath, content, 'utf-8');
  }

  /** List all archived IDENTITY.md versions from identity-history/. */
  listIdentityVersions(
    agentId: string,
  ): { version: number; path: string; modified: string }[] {
    const histDir = path.join(this.getAgentRoot(agentId), 'identity-history');
    if (!fs.existsSync(histDir)) return [];
    return fs
      .readdirSync(histDir)
      .filter((f) => f.match(/^v\d+\.md$/))
      .map((f) => {
        const fullPath = path.join(histDir, f);
        const stat = fs.statSync(fullPath);
        return {
          version: parseInt(f.replace(/[^0-9]/g, '')),
          path: `identity-history/${f}`,
          modified: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => a.version - b.version);
  }

  /** Check if the agent root exists. */
  exists(agentId: string): boolean {
    return fs.existsSync(this.getAgentRoot(agentId));
  }

  /** Remove the entire agent root directory. */
  remove(agentId: string): void {
    const root = this.getAgentRoot(agentId);
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  // ─── private helpers ────────────────────────────────────────────────────

  private _walk(root: string, current: string): WorkspaceFile[] {
    const results: WorkspaceFile[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        results.push({ path: rel, size: 0, modified: '', type: 'dir' });
        results.push(...this._walk(root, full));
      } else {
        try {
          const stat = fs.statSync(full);
          results.push({
            path: rel,
            size: stat.size,
            modified: stat.mtime.toISOString(),
            type: 'file',
          });
        } catch {
          /* skip inaccessible files */
        }
      }
    }
    return results;
  }

  private _snapshotDir(
    root: string,
    current: string,
    out: Map<string, { mtime: number; hash: string; size: number }>,
  ): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');

      // Skip excluded paths
      if (DIFF_EXCLUSIONS.some((excl) => rel.startsWith(excl))) continue;

      if (entry.isDirectory()) {
        this._snapshotDir(root, full, out);
      } else {
        try {
          const content = fs.readFileSync(full);
          const stat = fs.statSync(full);
          const hash = crypto
            .createHash('sha256')
            .update(content)
            .digest('hex');
          out.set(rel, { mtime: stat.mtimeMs, hash, size: stat.size });
        } catch {
          /* skip unreadable files */
        }
      }
    }
  }
}
