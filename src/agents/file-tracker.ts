import fs from 'fs';
import path from 'path';
import { logAgentFileEvent } from '../db.js';
import { appendConversationEvent } from '../conversation-events.js';
import type { FileEventType } from '../types.js';
import {
  AgentWorkspaceManager,
  type WorkspaceSnapshot,
  type FileDiff,
} from './agent-workspace.js';

// ─── Unified diff generation ──────────────────────────────────────────────────

/**
 * Minimal Myers-like unified diff.
 * Returns a unified-diff string (--- a/path, +++ b/path, @@ … @@ hunks).
 */
export function generatePatch(
  beforeContent: string,
  afterContent: string,
  filePath: string,
): string {
  const beforeLines = beforeContent.split('\n');
  const afterLines = afterContent.split('\n');

  const hunks = _diffHunks(beforeLines, afterLines);
  if (hunks.length === 0) return '';

  const lines: string[] = [`--- a/${filePath}`, `+++ b/${filePath}`];

  for (const hunk of hunks) {
    lines.push(hunk.header);
    lines.push(...hunk.lines);
  }

  return lines.join('\n') + '\n';
}

interface Hunk {
  header: string;
  lines: string[];
}

function _diffHunks(before: string[], after: string[]): Hunk[] {
  // Build edit script using LCS
  const lcs = _lcs(before, after);
  const edits = _buildEdits(before, after, lcs);

  if (edits.every((e) => e.type === '=')) return [];

  // Group edits into hunks (context = 3 lines)
  const CONTEXT = 3;
  const hunks: Hunk[] = [];

  let i = 0;
  while (i < edits.length) {
    if (edits[i].type === '=') {
      i++;
      continue;
    }

    // Find start of hunk
    const start = Math.max(0, i - CONTEXT);
    // Find end of hunk (last non-equal edit + CONTEXT)
    let end = i;
    while (end < edits.length && edits[end].type !== '=') end++;
    end = Math.min(edits.length, end + CONTEXT);

    // Check that this hunk doesn't overlap with next changed region
    let j = end;
    while (j < edits.length && edits[j].type === '=' && j < end + CONTEXT * 2)
      j++;
    if (j < edits.length && edits[j].type !== '=') {
      end = Math.min(edits.length, j + CONTEXT);
    }

    const hunkEdits = edits.slice(start, end);
    i = end;

    const beforeStart =
      hunkEdits.find((e) => e.beforeLine !== undefined)?.beforeLine ?? 1;
    const afterStart =
      hunkEdits.find((e) => e.afterLine !== undefined)?.afterLine ?? 1;
    const beforeCount = hunkEdits.filter((e) => e.type !== '+').length;
    const afterCount = hunkEdits.filter((e) => e.type !== '-').length;

    const header = `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`;
    const lines = hunkEdits.map((e) => {
      if (e.type === '+') return `+${e.text}`;
      if (e.type === '-') return `-${e.text}`;
      return ` ${e.text}`;
    });

    hunks.push({ header, lines });
  }

  return hunks;
}

interface Edit {
  type: '=' | '+' | '-';
  text: string;
  beforeLine?: number;
  afterLine?: number;
}

function _buildEdits(before: string[], after: string[], lcs: string[]): Edit[] {
  const edits: Edit[] = [];
  let bi = 0,
    ai = 0,
    li = 0;

  while (bi < before.length || ai < after.length) {
    if (
      li < lcs.length &&
      bi < before.length &&
      before[bi] === lcs[li] &&
      ai < after.length &&
      after[ai] === lcs[li]
    ) {
      edits.push({
        type: '=',
        text: before[bi],
        beforeLine: bi + 1,
        afterLine: ai + 1,
      });
      bi++;
      ai++;
      li++;
    } else if (
      ai < after.length &&
      (li >= lcs.length || after[ai] !== lcs[li])
    ) {
      edits.push({ type: '+', text: after[ai], afterLine: ai + 1 });
      ai++;
    } else {
      edits.push({ type: '-', text: before[bi], beforeLine: bi + 1 });
      bi++;
    }
  }

  return edits;
}

/** Compute LCS of two string arrays. O(n*m) — fine for typical source files. */
function _lcs(a: string[], b: string[]): string[] {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = m,
    j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--;
    else j--;
  }
  return result;
}

// ─── Binary / oversized file guard ─────────────────────────────────────────────
// generatePatch() does a naive line-based LCS diff (O(n*m) DP table) — fine for
// source files, catastrophic for anything else. Reading a binary file (e.g. a
// numpy .npz array) with 'utf-8' encoding doesn't error — it silently produces a
// garbled string of comparable byte length, which then gets diffed as if it were
// text and the result gets JSON.stringify'd (DB storage, the /file-events API,
// dashboard fetches). A workload that writes hundreds of binary result files in
// one cycle (e.g. one .npz per simulation run) turned this into a real production
// incident: enough oversized diff_patch strings accumulating in one JSON.stringify
// call exhausted the orchestrator's V8 heap and crashed the whole process with
// "FatalProcessOutOfMemory" — not just that one agent's session, the entire
// platform, since orchestrator is shared across every tenant.
const BINARY_EXTENSIONS = new Set([
  'npz',
  'npy',
  'pyc',
  'pyo',
  'so',
  'dylib',
  'dll',
  'exe',
  'bin',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'ico',
  'webp',
  'tiff',
  'pdf',
  'zip',
  'tar',
  'gz',
  'bz2',
  '7z',
  'rar',
  'db',
  'sqlite',
  'sqlite3',
  'parquet',
  'feather',
  'pickle',
  'pkl',
  'mp3',
  'mp4',
  'wav',
  'avi',
  'mov',
  'woff',
  'woff2',
  'ttf',
  'otf',
]);
// Above this, even a genuine text file isn't worth line-diffing synchronously —
// a large log or data dump would hit the same O(n*m) blowup as a binary file.
const MAX_DIFFABLE_BYTES = 512 * 1024; // 512KB

function isBinaryPath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

/** Cheap binary sniff: a NUL byte in the first few KB is not valid in any text
 *  encoding nanocrew's tools write, so its presence is a reliable binary signal
 *  even for extensions not in the static list above. */
function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

// ─── FileTracker ──────────────────────────────────────────────────────────────

export class FileTracker {
  private workspace: AgentWorkspaceManager;

  constructor(agentsBaseDir: string) {
    this.workspace = new AgentWorkspaceManager(agentsBaseDir);
  }

  /** Take a snapshot of the agent's workspace. Delegates to AgentWorkspaceManager. */
  snapshot(agentId: string): WorkspaceSnapshot {
    return this.workspace.snapshotWorkspace(agentId);
  }

  /**
   * Compute diffs between two snapshots.
   * For write/create events, reads the actual file content to generate a unified patch.
   * Binary and oversized files are recorded (event type still correct) but never
   * diffed — see the guard comment above.
   */
  diff(
    agentId: string,
    before: WorkspaceSnapshot,
    after: WorkspaceSnapshot,
  ): FileDiff[] {
    const rawDiffs = this.workspace.diffSnapshot(before, after);
    const agentRoot = this.workspace.getAgentRoot(agentId);
    const result: FileDiff[] = [];

    for (const d of rawDiffs) {
      if (d.eventType === 'delete') {
        result.push({ path: d.path, eventType: 'delete', patch: null });
        continue;
      }

      const absPath = path.join(agentRoot, d.path);

      if (isBinaryPath(d.path)) {
        result.push({ path: d.path, eventType: d.eventType, patch: null });
        continue;
      }

      let rawBuf: Buffer | null = null;
      try {
        const stat = fs.statSync(absPath);
        if (stat.size > MAX_DIFFABLE_BYTES) {
          result.push({ path: d.path, eventType: d.eventType, patch: null });
          continue;
        }
        rawBuf = fs.readFileSync(absPath);
      } catch {
        /* unreadable */
      }

      if (rawBuf && looksBinary(rawBuf)) {
        result.push({ path: d.path, eventType: d.eventType, patch: null });
        continue;
      }

      // For create/write: generate patch
      const afterContent = rawBuf ? rawBuf.toString('utf-8') : '';

      let beforeContent = '';
      if (d.eventType === 'write') {
        // We don't have the old content stored, so the patch shows full file as new
        // In a production system you'd store old content in snapshots
        beforeContent = '';
      }

      const patch = generatePatch(beforeContent, afterContent, d.path);
      result.push({
        path: d.path,
        eventType: d.eventType,
        patch: patch || null,
      });
    }

    return result;
  }

  /**
   * Persist file diff events to `agent_file_events` table.
   *
   * @param conversation Which conversation these changes belong to. MUST be the same
   *   JID the cycle's messages and steps go to — pass runCycle's streamJid. Defaults
   *   to the agent's own thread, exactly as _emitCycleChat does when no target is given.
   */
  persistEvents(
    agentId: string,
    cycleId: string,
    diffs: FileDiff[],
    conversation?: string,
  ): void {
    // Stage 35 dual-write: file changes are also appended to the conversation log, so
    // they're ordered against the messages and tool calls of the same cycle instead of
    // living in a third table the UI fetched separately (and, having no live transport
    // of their own, could only show once the cycle's result message already existed).
    // The dual-write lives here rather than inside logAgentFileEvent because db.ts is
    // imported by conversation-events.ts — writing it there would be a cycle.
    //
    // The fallback must match _emitCycleChat's (`agent:<id>`), not the cycle's
    // project. Resolving this independently — via the cycle's project_id — is what
    // split a project-scoped cycle across two conversations: with no explicit chatJid
    // (the scheduler, pipelines, handoffs) the messages went to the agent's thread
    // while the file changes went to the project's. The orphaned file events then
    // opened a turn in the project thread that no reply or error ever closed, so it
    // rendered as a turn spinning forever. One cycle's events must land in exactly one
    // conversation — that's the whole premise of this stage.
    const conv = conversation ?? `agent:${agentId}`;
    for (const d of diffs) {
      logAgentFileEvent({
        agent_id: agentId,
        cycle_id: cycleId,
        event_type: d.eventType as FileEventType,
        file_path: d.path,
        diff_patch: d.patch ?? undefined,
      });
      appendConversationEvent(conv, {
        type: 'file_change',
        cycle_id: cycleId,
        role: 'assistant',
        file_path: d.path,
        diff_patch: d.patch ?? undefined,
        status: 'ok',
        metadata: JSON.stringify({
          event_type: d.eventType,
          agent_id: agentId,
        }),
      });
    }
  }
}
