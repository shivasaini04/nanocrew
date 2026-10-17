/**
 * Stage 57 — an accepted worker's files, handed to its boss by reference.
 *
 * Phase 6 measured the alternative: three workers each wrote and tested a module, then the
 * boss re-typed all three into one reply, hit the model's 8,192-token output limit, and
 * wrote nothing (docs 19 §"Why the swarm lost", 5). Anthropic's research system returns
 * subagent output through the filesystem for the same reason (docs 13, 20). Here the
 * worker's files are copied into the boss's workspace when its result is accepted, and the
 * digest lists where — the boss copies or moves them, never re-types them.
 *
 * Only what the worker made is copied: the runtime's own folders and files are skipped, and
 * so is anything that is not a plain file — a worker controls its folder, and a symlink
 * there could point anywhere on the host.
 */
import fs from 'fs';
import path from 'path';

import { CHECK_FILES_DIR } from './sandbox.js';

/** Top-level entries of an attempt folder that belong to the runtime, not to the work. */
const RUNTIME_ENTRIES: ReadonlySet<string> = new Set([
  'sessions',
  'memory',
  'ipc',
  'skills',
  'tools',
  'knowledge',
  'IDENTITY.md',
  'mcp-servers.json',
  'result.json',
  'progress.json',
  'activity.json',
  CHECK_FILES_DIR,
]);
/** Runtime folders inside `workspace/`. */
const RUNTIME_WORKSPACE_ENTRIES: ReadonlySet<string> = new Set([
  'memory',
  'inbox',
  'attachments',
]);
/** Build and cache folders, wherever they appear. */
const SKIP_ANYWHERE: ReadonlySet<string> = new Set([
  '__pycache__',
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.cache',
]);

export const ARTIFACT_LIMITS = {
  files: 100,
  fileBytes: 2_000_000,
  totalBytes: 10_000_000,
};

export interface CopyResult {
  copied: string[];
  skipped: number;
}

/** Copy the files a worker made under `srcRoot` into `destDir`. Returns their paths relative to `destDir`. */
export function copyWorkerFiles(
  srcRoot: string,
  destDir: string,
  limits = ARTIFACT_LIMITS,
): CopyResult {
  const copied: string[] = [];
  let skipped = 0;
  let total = 0;

  const walk = (rel: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(srcRoot, rel), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (
        depth === 0 &&
        (RUNTIME_ENTRIES.has(e.name) || e.name.startsWith('.'))
      )
        continue;
      if (rel === 'workspace' && RUNTIME_WORKSPACE_ENTRIES.has(e.name))
        continue;
      if (SKIP_ANYWHERE.has(e.name)) continue;
      const full = path.join(srcRoot, childRel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        skipped++;
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 8) walk(childRel, depth + 1);
        continue;
      }
      if (!st.isFile()) {
        skipped++;
        continue;
      }
      if (
        copied.length >= limits.files ||
        st.size > limits.fileBytes ||
        total + st.size > limits.totalBytes
      ) {
        skipped++;
        continue;
      }
      const dest = path.join(destDir, childRel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(full, dest);
      total += st.size;
      copied.push(childRel);
    }
  };
  walk('', 0);
  return { copied, skipped };
}
