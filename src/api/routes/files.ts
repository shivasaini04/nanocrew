import { Router } from 'express';
import type { Request } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../../logger.js';
import { guardFileResponse } from '../file-serving.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import { PROJECTS_DIR, GROUPS_DIR, DATA_DIR } from '../../config.js';

const AGENTS_DIR = path.join(DATA_DIR, 'agents');
import {
  listWorkspaceFiles,
  getWorkspaceFileContent,
  listProjects,
  getProject,
  getAgent,
} from '../../db.js';
import { agentService } from '../../agents/agent-registry.js';
import { ownsResource, filterOwned } from '../middleware/ownership.js';

export const filesRouter = Router();

// ─── Data isolation (Stage 28, Phase 5) ──────────────────────────────────────
// Files are addressed by (context, contextId). A caller may only reach a context
// whose owning entity (agent/project) they own. main/dashboard workspaces are
// operator-level, so admin-only. Used to gate per-context reads and to filter the
// "scan everything" enumeration endpoints down to the caller's own entities.
function canAccessContext(
  req: Request,
  context: string,
  contextId?: string,
): boolean {
  switch (context) {
    case 'agent':
    case 'agentref':
      return !!contextId && ownsResource(req, getAgent(contextId)?.owner_id);
    case 'project':
      return !!contextId && ownsResource(req, getProject(contextId)?.owner_id);
    case 'main':
    case 'dashboard':
      return req.user?.role === 'admin';
    default:
      return false;
  }
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// `tools` and `skills` used to be in here too. They hold agent-authored code (dynamic
// tools, synthesized skills) — exactly the thing a user needs to see to debug or fix one,
// so hiding them by default worked against the point of a file browser. The rest stay
// hidden by default (raw session dumps, log rotation, internal config, memory, inbox) but
// are reachable with `showHidden=true` — see scanDir/buildTree below.
const SKIP_DIRS = new Set([
  'sessions',
  'logs',
  'memory',
  '.nanocrew',
  'identity-history',
  'inbox',
]);
const SKIP_FILES = new Set([
  'identity.md',
  'claude.md',
  'activity.json',
  'file-events.json',
  'memory.md',
  'history.md',
  '.gitkeep',
  'config.json',
  'schema.md',
]);
const SKIP_EXTENSIONS = new Set(['pyc']);

interface FileEntry {
  id: string;
  context: string;
  contextId: string;
  path: string;
  filename: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
}

/** Resolve the root directory for a given context + contextId. Returns null if invalid. */
function resolveContextDir(context: string, contextId?: string): string | null {
  try {
    switch (context) {
      case 'project':
        return contextId
          ? path.join(PROJECTS_DIR, contextId, 'workspace')
          : PROJECTS_DIR;
      case 'main':
        return resolveGroupFolderPath('main');
      case 'dashboard':
        return resolveGroupFolderPath('dashboard');
      case 'agent':
        return contextId
          ? path.join(AGENTS_DIR, contextId, 'workspace')
          : AGENTS_DIR;
      case 'agentref':
        // The agent's references/ folder (files the user uploaded), a sibling of workspace/.
        return contextId
          ? path.join(AGENTS_DIR, contextId, 'references')
          : AGENTS_DIR;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

interface ScanOpts {
  /** Skip nothing in SKIP_DIRS, and report directories that hold no files (see `emptyDirs`). */
  showHidden?: boolean;
  /** When set, filled with the relative paths of directories that (recursively) contain
   *  no files — normally invisible, since the tree is built by walking files. Only
   *  populated when `showHidden` is true; the default view has no use for an empty folder. */
  emptyDirs?: string[];
  limit?: number;
}

async function scanDir(
  dir: string,
  prefix: string,
  context: string,
  contextId: string,
  out: FileEntry[],
  opts: ScanOpts = {},
) {
  if (!fs.existsSync(dir)) return;
  const limit = opts.limit ?? 5000;

  // Manual BFS walk, one non-recursive readdir per directory (levels done in
  // parallel via Promise.all). fs.readdir's native `recursive: true` mode (Node
  // 20.1+) measured wildly variable — sub-100ms in isolation but 10-30+s under
  // real server load, long enough to stall the whole event loop (confirmed via a
  // heartbeat timer that also stopped ticking during the stall, not just this
  // route). Prunes SKIP_DIRS *before* descending instead of after walking the
  // whole tree, so it's a net win, not just a workaround.
  type Pending = {
    absPath: string;
    relPath: string;
    name: string;
    ext: string;
  };
  const pending: Pending[] = [];
  const keptDirs: string[] = []; // relative paths of directories not pruned by SKIP_DIRS
  const now = new Date().toISOString();

  let currentDirs: Array<{ abs: string; rel: string }> = [
    { abs: dir, rel: '' },
  ];
  while (currentDirs.length > 0 && pending.length < limit) {
    const results = await Promise.all(
      currentDirs.map((d) =>
        fs.promises
          .readdir(d.abs, { withFileTypes: true })
          .catch(() => [] as import('fs').Dirent[]),
      ),
    );
    const nextDirs: Array<{ abs: string; rel: string }> = [];
    for (let d = 0; d < currentDirs.length; d++) {
      const { abs: parentAbs, rel: parentRel } = currentDirs[d];
      for (const entry of results[d]) {
        if (pending.length >= limit) break;
        const name = entry.name;
        if (entry.isDirectory()) {
          if (!opts.showHidden && SKIP_DIRS.has(name.toLowerCase())) continue;
          const relDir = parentRel ? `${parentRel}/${name}` : name;
          keptDirs.push(relDir);
          nextDirs.push({ abs: path.join(parentAbs, name), rel: relDir });
          continue;
        }
        if (!entry.isFile()) continue;
        if (SKIP_FILES.has(name.toLowerCase())) continue;
        const ext = path.extname(name).replace('.', '').toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;

        const relPath = prefix
          ? parentRel
            ? `${prefix}/${parentRel}/${name}`
            : `${prefix}/${name}`
          : parentRel
            ? `${parentRel}/${name}`
            : name;
        pending.push({
          absPath: path.join(parentAbs, name),
          relPath,
          name,
          ext,
        });
      }
    }
    currentDirs = nextDirs;
  }

  // Parallel stat for size + mtime
  const stats = await Promise.all(
    pending.map((p) => fs.promises.stat(p.absPath).catch(() => null)),
  );
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    const st = stats[i];
    out.push({
      id: `${context}:${contextId}:${p.relPath}`,
      context,
      contextId,
      path: p.relPath,
      filename: p.name,
      extension: p.ext,
      sizeBytes: st?.size ?? 0,
      modifiedAt: st ? st.mtime.toISOString() : now,
      createdAt: st ? st.birthtime.toISOString() : now,
    });
  }

  if (opts.showHidden && opts.emptyDirs) {
    const filePaths = pending.map((p) => p.relPath);
    for (const relDir of keptDirs) {
      const fullRel = prefix ? `${prefix}/${relDir}` : relDir;
      const hasFile = filePaths.some(
        (fp) => fp === fullRel || fp.startsWith(`${fullRel}/`),
      );
      if (!hasFile) opts.emptyDirs.push(fullRel);
    }
  }
}

// ─── Unified file listing ─────────────────────────────────────────────────────

/**
 * GET /api/files?context=project|main|dashboard|agent&contextId=...
 * GET /api/files?chatJid=...   ← reads from workspace_files registry
 */
filesRouter.get('/files', async (req, res) => {
  try {
    const {
      context,
      contextId,
      chatJid,
      showHidden: showHiddenRaw,
    } = req.query as Record<string, string>;
    const showHidden = showHiddenRaw === '1' || showHiddenRaw === 'true';

    // chatJid mode: query the file registry
    if (chatJid && !context) {
      let ok = req.user?.role === 'admin';
      if (chatJid.startsWith('agent:'))
        ok = ownsResource(
          req,
          getAgent(chatJid.slice('agent:'.length))?.owner_id,
        );
      else if (chatJid.startsWith('project:'))
        ok = ownsResource(
          req,
          getProject(chatJid.slice('project:'.length))?.owner_id,
        );
      if (!ok) return res.status(404).json({ error: 'Not found' });
      const rows = listWorkspaceFiles({ chatJid });
      return res.json({ files: rows });
    }

    if (!context)
      return res.status(400).json({ error: 'context or chatJid required' });

    const dir = resolveContextDir(context, contextId);
    if (!dir) return res.status(400).json({ error: `Invalid context` });
    if (!fs.existsSync(dir)) return res.json({ files: [] });

    // Stage 28 — a specific context must be owned; main/dashboard are operator-only.
    const needsId = ['project', 'agent'].includes(context);
    if (contextId || !needsId) {
      if (!canAccessContext(req, context, contextId))
        return res.status(404).json({ error: 'Not found' });
    }

    const files: FileEntry[] = [];
    const emptyDirs: string[] = [];

    // Broad scan: if context expects an ID but none is given, scan subdirectories as IDs
    if (needsId && !contextId) {
      const folders = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const f of folders) {
        // Only scan entities the caller owns.
        if (
          f.isDirectory() &&
          !SKIP_DIRS.has(f.name.toLowerCase()) &&
          canAccessContext(req, context, f.name)
        ) {
          let workspaceDir = path.join(dir, f.name);
          // Projects have a nested 'workspace' folder
          if (context === 'project')
            workspaceDir = path.join(workspaceDir, 'workspace');

          await scanDir(workspaceDir, '', context, f.name, files, {
            showHidden,
            emptyDirs,
          });
        }
      }
    } else {
      await scanDir(dir, '', context, contextId ?? '', files, {
        showHidden,
        emptyDirs,
      });
    }

    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json({ files, emptyDirs });
  } catch (err) {
    logger.error({ err }, 'Failed to list files');
    res.status(500).json({ error: 'Failed to list files' });
  }
});

/**
 * GET /api/files/content?context=...&contextId=...&path=report.md
 * Returns raw file content as plain text.
 */
filesRouter.get('/files/content', async (req, res) => {
  try {
    const {
      context,
      contextId,
      path: filePath,
    } = req.query as Record<string, string>;
    if (!context || !filePath)
      return res.status(400).json({ error: 'context and path required' });
    if (!canAccessContext(req, context, contextId))
      return res.status(404).json({ error: 'Not found' });

    const dir = resolveContextDir(context, contextId);
    if (!dir) return res.status(400).json({ error: 'Invalid context' });

    // Security: resolve full path and ensure it stays inside the context dir
    const fullPath = path.resolve(dir, filePath);
    if (!fullPath.startsWith(path.resolve(dir))) {
      return res.status(403).json({ error: 'Path traversal denied' });
    }

    if (!fs.existsSync(fullPath))
      return res.status(404).json({ error: 'File not found' });

    // Stage 20 gap F — serve images as binary with the right content-type so they
    // can render inline (<img src=…>).
    const IMG_TYPES: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
    };
    const ext = path.extname(fullPath).toLowerCase();
    if (IMG_TYPES[ext]) {
      const buf = await fs.promises.readFile(fullPath);
      // These bytes were uploaded or written by an agent and are served from the
      // dashboard's own origin. image/svg+xml can carry <script>, and uploads have no
      // type filter — see file-serving.ts for what the audit found and why this
      // sandboxes rather than forcing a download.
      guardFileResponse(res, IMG_TYPES[ext]);
      return res.type(IMG_TYPES[ext]).send(buf);
    }

    // Found 2026-09-22: every OTHER file — including a real .xlsx or .docx someone just
    // clicked "Preview" on — was read with `'utf-8'`, which is a LOSSY decode for
    // anything that isn't actually UTF-8 text. A spreadsheet is a ZIP archive; forcing
    // its raw bytes through UTF-8 replaces every invalid sequence with U+FFFD before a
    // single byte leaves this server, so the client-side parser was never going to have
    // a chance — it reported "Unsupported ZIP Compression method NaN" on bytes that had
    // already been destroyed one layer back. Always read as a Buffer now; the content
    // is byte-for-byte what's on disk regardless of what MIME type is declared below,
    // and a text-consuming caller (`r.text()`) still gets correct UTF-8 text the same
    // as before for anything that actually is.
    const BINARY_MIME: Record<string, string> = {
      '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
      '.xls': 'application/vnd.ms-excel',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    const buf = await fs.promises.readFile(fullPath);
    // Neither of these types can execute script as a top-level document — see
    // SCRIPTABLE_TYPES in file-serving.ts — so `nosniff` (always applied by
    // guardFileResponse) is sufficient; they don't need the extra sandbox CSP.
    const mimeType = BINARY_MIME[ext] ?? 'text/plain';
    guardFileResponse(res, mimeType);
    res.type(mimeType).send(buf);
  } catch (err) {
    logger.error({ err }, 'Failed to read file content');
    res.status(500).json({ error: 'Failed to read file content' });
  }
});

// ─── Context cards ────────────────────────────────────────────────────────────

/**
 * GET /api/files/contexts
 * Returns one card per context entity (project, agent, main, dashboard)
 * with file count and last-modified timestamp — used for the Level 1 cards view.
 */
filesRouter.get('/files/contexts', async (req, res) => {
  try {
    interface ContextCard {
      context: string;
      contextId: string;
      name: string;
      subtitle?: string;
      fileCount: number;
      lastModified: string | null;
      status?: string;
      projectId?: string;
      projectName?: string;
    }

    // Quick recursive file count (no need to build full FileEntry objects)
    async function countDir(
      dir: string,
    ): Promise<{ count: number; lastModified: string | null }> {
      if (!fs.existsSync(dir)) return { count: 0, lastModified: null };
      let count = 0;
      let latest: Date | null = null as Date | null;

      async function walk(d: string) {
        const entries = await fs.promises
          .readdir(d, { withFileTypes: true })
          .catch(() => []);
        for (const e of entries) {
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name.toLowerCase()))
              await walk(path.join(d, e.name));
          } else if (
            e.isFile() &&
            !SKIP_FILES.has(e.name.toLowerCase()) &&
            !SKIP_EXTENSIONS.has(
              path.extname(e.name).replace('.', '').toLowerCase(),
            )
          ) {
            count++;
            try {
              const st = await fs.promises.stat(path.join(d, e.name));
              if (!latest || st.mtime > latest) latest = st.mtime;
            } catch {
              /**/
            }
          }
        }
      }
      await walk(dir);
      return { count, lastModified: latest ? latest.toISOString() : null };
    }

    const cards: ContextCard[] = [];

    // ── No-ID contexts (operator-level — admin only) ────────────────────────
    for (const [ctx, label] of (req.user?.role === 'admin'
      ? [
          ['main', 'Main'],
          ['dashboard', 'Dashboard'],
        ]
      : []) as ReadonlyArray<readonly [string, string]>) {
      try {
        const dir = resolveContextDir(ctx);
        if (dir) {
          const { count, lastModified } = await countDir(dir);
          if (count > 0)
            cards.push({
              context: ctx,
              contextId: '',
              name: label,
              fileCount: count,
              lastModified,
            });
        }
      } catch {
        /**/
      }
    }

    // ── Projects ───────────────────────────────────────────────────────────
    const projects = filterOwned(req, listProjects());
    await Promise.all(
      projects.map(async (p) => {
        const dir = path.join(PROJECTS_DIR, p.id, 'workspace');
        const { count, lastModified } = await countDir(dir);
        if (count > 0)
          cards.push({
            context: 'project',
            contextId: p.id,
            name: p.name || p.id,
            subtitle: p.status === 'archived' ? 'Archived' : 'Active',
            fileCount: count,
            lastModified,
            status: p.status,
          });
      }),
    );

    // ── Agents ─────────────────────────────────────────────────────────────
    const agents = filterOwned(req, agentService.getAllAgents());
    await Promise.all(
      agents.map(async (a) => {
        const dir = resolveContextDir('agent', a.id);
        if (!dir) return;
        const { count, lastModified } = await countDir(dir);
        if (count > 0)
          cards.push({
            context: 'agent',
            contextId: a.id,
            name: `${a.emoji ?? ''} ${a.name}`.trim(),
            fileCount: count,
            lastModified,
          });
      }),
    );

    // Sort by last modified descending
    cards.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return b.lastModified.localeCompare(a.lastModified);
    });

    res.json({ contexts: cards });
  } catch (err) {
    logger.error({ err }, 'Failed to list file contexts');
    res.status(500).json({ error: 'Failed to list file contexts' });
  }
});

// ─── File tree ────────────────────────────────────────────────────────────────

interface TreeNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  extension?: string;
  sizeBytes?: number;
  modifiedAt?: string;
  children?: TreeNode[];
  fileCount?: number;
}

function buildTree(files: FileEntry[], emptyDirs: string[] = []): TreeNode[] {
  const root: TreeNode = { name: '', type: 'dir', path: '', children: [] };

  function ensureDir(parts: string[]): TreeNode {
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      let dir = cur.children!.find((c) => c.name === seg && c.type === 'dir');
      if (!dir) {
        dir = {
          name: seg,
          type: 'dir',
          path: parts.slice(0, i + 1).join('/'),
          children: [],
          fileCount: 0,
        };
        cur.children!.push(dir);
      }
      cur = dir;
    }
    return cur;
  }

  for (const file of files) {
    const parts = file.path.split('/');
    const dir = ensureDir(parts.slice(0, -1));
    dir.children!.push({
      name: file.filename,
      type: 'file',
      path: file.path,
      extension: file.extension,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
    });
  }

  // Empty directories have no file to hang a node off, so they get one explicitly —
  // only populated when the caller asked to see them (`showHidden`).
  for (const emptyPath of emptyDirs) {
    ensureDir(emptyPath.split('/'));
  }

  function calcCount(node: TreeNode): number {
    if (node.type === 'file') return 1;
    const n = (node.children ?? []).reduce((s, c) => s + calcCount(c), 0);
    node.fileCount = n;
    return n;
  }
  calcCount(root);

  function sortNode(node: TreeNode) {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNode);
  }
  sortNode(root);

  return root.children ?? [];
}

/**
 * GET /api/files/tree?context=project&contextId=proj_123
 * Returns the folder tree for one context entity.
 */
filesRouter.get('/files/tree', async (req, res) => {
  try {
    const {
      context,
      contextId,
      showHidden: showHiddenRaw,
    } = req.query as Record<string, string>;
    const showHidden = showHiddenRaw === '1' || showHiddenRaw === 'true';
    if (!context) return res.status(400).json({ error: 'context required' });
    if (!canAccessContext(req, context, contextId))
      return res.status(404).json({ error: 'Not found' });

    const dir = resolveContextDir(context, contextId);
    if (!dir) return res.status(400).json({ error: 'Invalid context' });
    if (!fs.existsSync(dir)) return res.json({ tree: [] });

    const files: FileEntry[] = [];
    const emptyDirs: string[] = [];
    await scanDir(dir, '', context, contextId ?? '', files, {
      showHidden,
      emptyDirs,
    });
    res.json({ tree: buildTree(files, emptyDirs) });
  } catch (err) {
    logger.error({ err }, 'Failed to build file tree');
    res.status(500).json({ error: 'Failed to build file tree' });
  }
});

/**
 * GET /api/files/workspace-picker?chatJid=...
 * Returns grouped file scopes for the # mention popup.
 * Scopes: project shared (if chatJid is project:*), dashboard chat workspace,
 * and all agent workspaces.
 */
filesRouter.get('/files/workspace-picker', async (req, res) => {
  try {
    const { chatJid } = req.query as Record<string, string>;

    interface PickerFile {
      filename: string;
      path: string;
      sizeBytes: number;
      modifiedAt: string;
    }
    interface PickerScope {
      label: string;
      prefix: string; // used to build the #ref string: #prefix/path
      icon: string;
      agentId?: string;
      files: PickerFile[];
    }

    const scopes: PickerScope[] = [];

    // ── Project shared workspace ───────────────────────────────────────────
    if (
      chatJid?.startsWith('project:') &&
      ownsResource(req, getProject(chatJid.replace('project:', ''))?.owner_id)
    ) {
      const projectId = chatJid.replace('project:', '');
      const sharedDir = path.join(PROJECTS_DIR, projectId, 'workspace');
      if (fs.existsSync(sharedDir)) {
        const files: FileEntry[] = [];
        await scanDir(sharedDir, '', 'project', projectId, files);
        if (files.length > 0) {
          scopes.push({
            label: 'Project Shared',
            prefix: 'shared',
            icon: '🗂️',
            files: files.slice(0, 50).map((f) => ({
              filename: f.filename,
              path: f.path,
              sizeBytes: f.sizeBytes,
              modifiedAt: f.modifiedAt,
            })),
          });
        }
      }
    }

    // ── Dashboard / chat workspace (operator-level — admin only) ────────────
    try {
      if (req.user?.role !== 'admin') throw new Error('skip');
      const chatDir = resolveGroupFolderPath('dashboard');
      if (fs.existsSync(chatDir)) {
        const files: FileEntry[] = [];
        await scanDir(chatDir, '', 'dashboard', '', files);
        if (files.length > 0) {
          scopes.push({
            label: '💬 Chat Workspace',
            prefix: 'chat',
            icon: '💬',
            files: files
              .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
              .slice(0, 50)
              .map((f) => ({
                filename: f.filename,
                path: f.path,
                sizeBytes: f.sizeBytes,
                modifiedAt: f.modifiedAt,
              })),
          });
        }
      }
    } catch {
      /* skip if group folder not configured */
    }

    // ── All agent workspaces (owned only) ──────────────────────────────────
    const agents = filterOwned(req, agentService.getAllAgents());
    await Promise.all(
      agents.map(async (agent) => {
        const agentDir = path.join(AGENTS_DIR, agent.id, 'workspace');
        if (!fs.existsSync(agentDir)) return;
        const files: FileEntry[] = [];
        await scanDir(agentDir, '', 'agent', agent.id, files);
        if (files.length === 0) return;
        scopes.push({
          label: `${agent.emoji ?? '🤖'} ${agent.name}`,
          prefix: agent.name,
          icon: agent.emoji ?? '🤖',
          agentId: agent.id,
          files: files
            .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))
            .slice(0, 30)
            .map((f) => ({
              filename: f.filename,
              path: f.path,
              sizeBytes: f.sizeBytes,
              modifiedAt: f.modifiedAt,
            })),
        });
      }),
    );

    res.json({ scopes });
  } catch (err) {
    logger.error({ err }, 'Failed to build workspace picker');
    res.status(500).json({ error: 'Failed to build workspace picker' });
  }
});

/**
 * POST /api/files/resolve-refs
 * Body: { refs: string[], chatJid?: string }
 * Resolves #ref strings to { ref, content, label } objects.
 * Used by dashboard channel to inject file context into agent prompts.
 */
filesRouter.post('/files/resolve-refs', async (req, res) => {
  try {
    const { refs, chatJid } = req.body as { refs: string[]; chatJid?: string };
    if (!Array.isArray(refs) || refs.length === 0)
      return res.json({ resolved: [] });

    const agents = filterOwned(req, agentService.getAllAgents());
    const projectId =
      chatJid?.startsWith('project:') &&
      ownsResource(req, getProject(chatJid.replace('project:', ''))?.owner_id)
        ? chatJid.replace('project:', '')
        : undefined;

    const resolved: Array<{ ref: string; label: string; content: string }> = [];

    for (const ref of refs) {
      // #shared/filename.md → project shared workspace
      if (ref.startsWith('shared/') && projectId) {
        const filePath = ref.slice('shared/'.length);
        const fullPath = path.resolve(
          path.join(PROJECTS_DIR, projectId, 'workspace'),
          filePath,
        );
        const safeBase = path.resolve(
          path.join(PROJECTS_DIR, projectId, 'workspace'),
        );
        if (fullPath.startsWith(safeBase) && fs.existsSync(fullPath)) {
          const content = await fs.promises.readFile(fullPath, 'utf-8');
          resolved.push({ ref, label: `shared/${filePath}`, content });
        }
        continue;
      }

      // #chat/filename.md → dashboard chat workspace
      if (ref.startsWith('chat/')) {
        try {
          const filePath = ref.slice('chat/'.length);
          const chatDir = resolveGroupFolderPath('dashboard');
          const fullPath = path.resolve(chatDir, filePath);
          const safeBase = path.resolve(chatDir);
          if (fullPath.startsWith(safeBase) && fs.existsSync(fullPath)) {
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            resolved.push({ ref, label: `💬 Chat / ${filePath}`, content });
          }
        } catch {
          /* skip */
        }
        continue;
      }

      // #AgentName/filename.md → agent workspace
      const slashIdx = ref.indexOf('/');
      if (slashIdx > 0) {
        const agentName = ref.slice(0, slashIdx);
        const filePath = ref.slice(slashIdx + 1);
        const agent = agents.find(
          (a) =>
            a.name === agentName ||
            a.name.toLowerCase() === agentName.toLowerCase(),
        );
        if (agent) {
          const agentDir = path.join(AGENTS_DIR, agent.id, 'workspace');
          const fullPath = path.resolve(agentDir, filePath);
          if (
            fullPath.startsWith(path.resolve(agentDir)) &&
            fs.existsSync(fullPath)
          ) {
            const content = await fs.promises.readFile(fullPath, 'utf-8');
            resolved.push({
              ref,
              label: `${agent.emoji ?? '🤖'} ${agent.name} / ${filePath}`,
              content,
            });
          }
        }
      }
    }

    res.json({ resolved });
  } catch (err) {
    logger.error({ err }, 'Failed to resolve file refs');
    res.status(500).json({ error: 'Failed to resolve file refs' });
  }
});

filesRouter.get('/groups/:folder/memory', async (req, res) => {
  try {
    // Stage 28 — group folders are an operator concept (WhatsApp routing); a client's
    // own agent memory is served by the isolated /api/agents/:id/memory route.
    if (req.user?.role !== 'admin')
      return res.status(404).json({ error: 'Not found' });
    const folder = req.params.folder;
    const groupPath = resolveGroupFolderPath(folder);
    const memoryDir = path.join(groupPath, 'memory');

    let memoryMd = '';
    let historyMd = '';

    const memoryPath = path.join(memoryDir, 'MEMORY.md');
    if (fs.existsSync(memoryPath)) {
      memoryMd = await fs.promises.readFile(memoryPath, 'utf-8');
    }

    const historyPath = path.join(memoryDir, 'HISTORY.md');
    if (fs.existsSync(historyPath)) {
      historyMd = await fs.promises.readFile(historyPath, 'utf-8');
    }

    res.json({ memoryMd, historyMd });
  } catch (error) {
    logger.error(
      { error, folder: req.params.folder },
      'Failed to read memory files',
    );
    res.status(500).json({ error: 'Failed to read memory files' });
  }
});

filesRouter.get('/groups/:folder/skills', async (req, res) => {
  try {
    if (req.user?.role !== 'admin')
      return res.status(404).json({ error: 'Not found' });
    const folder = req.params.folder;
    const groupPath = resolveGroupFolderPath(folder);
    const skillsDir = path.join(groupPath, 'skills');

    const skills: Array<{
      name: string;
      files: Array<{ filename: string; content: string }>;
    }> = [];

    if (fs.existsSync(skillsDir)) {
      const entries = await fs.promises.readdir(skillsDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('__')) {
          // ignore __pycache__ etc
          const skillPath = path.join(skillsDir, entry.name);
          const skillFiles = await fs.promises.readdir(skillPath);

          const files = [];
          for (const file of skillFiles) {
            if (file.endsWith('.py') || file.endsWith('.md')) {
              const content = await fs.promises.readFile(
                path.join(skillPath, file),
                'utf-8',
              );
              files.push({ filename: file, content });
            }
          }

          skills.push({ name: entry.name, files });
        }
      }
    }

    res.json(skills);
  } catch (error) {
    logger.error(
      { error, folder: req.params.folder },
      'Failed to read skills directory',
    );
    res.status(500).json({ error: 'Failed to read skills files' });
  }
});
