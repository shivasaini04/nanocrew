/**
 * Projects API routes
 */
import { Router } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import {
  refTypeForFilename,
  sanitiseRefPath,
  rejectedUploads,
} from './agents.js';

import {
  createProject,
  getProject,
  getProjectByName,
  getActiveProjectForChat,
  linkChatToProject,
  listProjects,
  updateProject,
  setProjectLeadAgent,
  linkAgentToProject,
  unlinkAgentFromProject,
  getProjectAgents,
  getAgentProjects,
  storeChatMetadata,
  storeMessageDirect,
  getAgent,
  getProjectGroupBindings,
  linkGroupToProject,
  unlinkGroupFromProject,
  setProjectGroupEnabled,
} from '../../db.js';
import { Project } from '../../types.js';
import { setRowOwner, countUserProjects, getUserById } from '../../db.js';
import { PROJECTS_DIR, planProjectLimit, hasActivePlan } from '../../config.js';
import { logger } from '../../logger.js';
import { getSocketIO } from '../server.js';
import { ownsResource, filterOwned } from '../middleware/ownership.js';
import { whatsAppSessions } from '../../channels/whatsapp-session.js';
import { searchAgentMemoryRanked } from '../../agents/memory-retrieval.js';
import { appendChatMessageEvent } from '../../conversation-events.js';

export const projectsRouter = Router();

// Same early-reject as the agent upload — see agents.ts's referenceUpload for why this
// drops rather than errors, and why it is a memory fix rather than a security one. This
// one matters slightly more: the per-file limit here is 25MB, not 10.
const projectUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (refTypeForFilename(file.originalname)) return cb(null, true);
    const r = req as unknown as { _rejectedUploads?: string[] };
    (r._rejectedUploads ??= []).push(file.originalname);
    cb(null, false);
  },
});

// ─── Data isolation (Stage 28, Phase 5) ──────────────────────────────────────
// Guard every /projects/:id* route by ownership. Registered before the route
// handlers so it runs first. The :id param is overloaded across this router
// (project id here, but AGENT id in /agents/:id/projects), so we scope the guard
// to the /projects/:id path specifically rather than using router.param('id').
// '/projects/active' is a literal sub-route (not an id), so it's exempt.
projectsRouter.use('/projects/:id', (req, res, next) => {
  if (req.params.id === 'active') return next();
  const proj = getProject(req.params.id);
  if (!proj || !ownsResource(req, proj.owner_id)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  (req as any).ownedProject = proj;
  next();
});

/** POST /api/projects/:id/workspace/files — upload files/folders into the project's
 *  shared workspace. Project-folder model: you + the crew work the same tree. */
projectsRouter.post(
  '/projects/:id/workspace/files',
  projectUpload.array('files', 300),
  async (req, res) => {
    try {
      const projectId = String(req.params.id);
      const project = getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (uploaded.length === 0)
        return res.status(400).json({ error: 'No files provided' });

      const wsDir = path.join(PROJECTS_DIR, projectId, 'workspace');
      const targetDir =
        sanitiseRefPath(String((req.body as any)?.dir ?? '')) ?? '';
      const baseDir = path.join(wsDir, targetDir);
      fs.mkdirSync(baseDir, { recursive: true });

      let relPaths: string[] = [];
      try {
        relPaths = JSON.parse(String((req.body as any)?.paths ?? '[]'));
      } catch {
        /* fall back to originalname */
      }

      const added: string[] = [];
      // Seeded with whatever the fileFilter dropped before parsing — never buffered, so
      // the loop below cannot see them.
      const skipped: string[] = [...rejectedUploads(req)];
      for (let i = 0; i < uploaded.length; i++) {
        const f = uploaded[i];
        const rawName = (relPaths[i] && String(relPaths[i])) || f.originalname;
        const type = refTypeForFilename(rawName);
        const rel = sanitiseRefPath(rawName);
        if (!type || !rel) {
          skipped.push(f.originalname);
          continue;
        }
        const destPath = path.join(baseDir, rel);
        if (!path.resolve(destPath).startsWith(path.resolve(wsDir))) {
          skipped.push(f.originalname);
          continue;
        }
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, f.buffer);
        added.push(path.posix.join(targetDir, rel));
      }

      if (added.length === 0) {
        return res.status(400).json({
          error:
            'No supported files — text, code, data and pdf only; binaries rejected',
          skipped,
        });
      }
      res.json({ added, skipped });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  },
);

/** GET /api/projects — list all projects */
projectsRouter.get('/projects', (req, res) => {
  try {
    const projects = filterOwned(req, listProjects());
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** GET /api/projects/active?chatJid=... — active project for a chat */
projectsRouter.get('/projects/active', (req, res) => {
  try {
    const chatJid = req.query.chatJid as string;
    if (!chatJid) return res.status(400).json({ error: 'chatJid required' });
    const project = getActiveProjectForChat(chatJid);
    // Don't reveal a project the caller doesn't own.
    if (project && !ownsResource(req, project.owner_id)) return res.json(null);
    res.json(project ?? null);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** GET /api/projects/:id — single project */
projectsRouter.get('/projects/:id', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** POST /api/projects — create project (DB row + on-disk workspace) */
projectsRouter.post('/projects', (req, res) => {
  try {
    const { name, chat_jid } = req.body as { name: string; chat_jid?: string };
    if (!name) return res.status(400).json({ error: 'name required' });
    // Plan project-cap gate. Admins and unlimited (Business) tiers pass.
    if (req.user) {
      const owner = getUserById(req.user.id);
      if (owner && owner.role !== 'admin') {
        if (!hasActivePlan(owner.plan)) {
          return res.status(403).json({
            error:
              'Choose a plan to activate your crew before creating projects.',
          });
        }
        const limit = planProjectLimit(owner.plan);
        if (countUserProjects(req.user.id) >= limit) {
          return res.status(403).json({
            error: `You've reached your plan's limit of ${limit} projects. Upgrade to add more.`,
          });
        }
      }
    }
    const now = new Date().toISOString();
    const id = `proj_${Date.now()}_${randomUUID().split('-')[0]}`;
    const project: Project = {
      id,
      name,
      chat_jid: chat_jid ?? `project:${id}`,
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    createProject(project);
    // Stage 28 — the creating user owns the new project.
    if (req.user) {
      setRowOwner('projects', id, req.user.id);
      project.owner_id = req.user.id;
    }

    // Initialize on-disk workspace so file APIs / cycles can find the project immediately
    // (mirrors the bootstrap in src/index.ts that runs for chat-created projects).
    try {
      const contextDir = path.join(PROJECTS_DIR, id, 'context');
      const workspaceDir = path.join(PROJECTS_DIR, id, 'workspace');
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      const brief = `# Project: ${name}\n\nID: ${id}\nCreated: ${now}\n\n## File Storage Rules\n\n- **ALL project files MUST be created in \`/workspace/shared/\`** — this is the persistent project workspace shared across all jobs and sessions.\n- Your session state (memory, logs) lives in \`/workspace/group/\` — do not mix project files there.\n\n## Example\n\n\`\`\`bash\n# Correct — persistent project workspace\necho "hello" > /workspace/shared/hello.txt\n\`\`\`\n`;
      fs.writeFileSync(path.join(contextDir, 'PROJECT.md'), brief, 'utf-8');
    } catch (e) {
      logger.warn(
        { projectId: id, err: e },
        'Project on-disk init failed (DB row created)',
      );
    }

    res.status(201).json(project);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** PATCH /api/projects/:id — update name or status */
projectsRouter.patch('/projects/:id', (req, res) => {
  try {
    const { name, status } = req.body as {
      name?: string;
      status?: 'active' | 'archived';
    };
    updateProject(req.params.id, { name, status });
    const updated = getProject(req.params.id);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** PATCH /api/projects/:id/lead-agent — set or clear the lead agent for project chat routing */
projectsRouter.patch('/projects/:id/lead-agent', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { agentId } = req.body as { agentId: string | null };
    setProjectLeadAgent(req.params.id, agentId ?? null);
    getSocketIO()?.emit('project:lead_agent_changed', {
      projectId: req.params.id,
      agentId: agentId ?? null,
    });
    res.json({ ok: true, leadAgentId: agentId ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/projects/:id/link — link a chat to a project */
projectsRouter.post('/projects/:id/link', (req, res) => {
  try {
    const { chat_jid } = req.body as { chat_jid: string };
    if (!chat_jid) return res.status(400).json({ error: 'chat_jid required' });
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    linkChatToProject(req.params.id, chat_jid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ─── Workspace file endpoints ─────────────────────────────────────────────────

const SKIP_FILES = new Set([
  'identity.md',
  'claude.md',
  'activity.json',
  'file-events.json',
]);

// Agent-private plumbing that can appear under a project's shared workspace — never
// project files, so hide them from the project listing.
const SKIP_DIRS = new Set([
  'sessions',
  'tools',
  'memory',
  'logs',
  'inbox',
  '.nanocrew',
  '.git',
  'node_modules',
  '__pycache__',
]);

const MAX_INLINE_BYTES = 200 * 1024; // 200 KB — larger files get a placeholder

async function readWorkspaceDir(
  dir: string,
  prefix: string,
  files: Array<{
    filename: string;
    content: string;
    sizeBytes: number;
    modifiedAt: string;
  }>,
) {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const tasks: Promise<void>[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      tasks.push(
        readWorkspaceDir(
          path.join(dir, entry.name),
          prefix ? `${prefix}/${entry.name}` : entry.name,
          files,
        ),
      );
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name.toLowerCase())) continue;
      const filePath = path.join(dir, entry.name);
      const displayName = prefix ? `${prefix}/${entry.name}` : entry.name;
      tasks.push(
        (async () => {
          try {
            const stat = await fs.promises.stat(filePath);
            const content =
              stat.size <= MAX_INLINE_BYTES
                ? await fs.promises.readFile(filePath, 'utf-8')
                : '<File too large to preview inline>';
            files.push({
              filename: displayName,
              content,
              sizeBytes: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            });
          } catch {
            files.push({
              filename: displayName,
              content: '<Binary or unreadable file>',
              sizeBytes: 0,
              modifiedAt: new Date().toISOString(),
            });
          }
        })(),
      );
    }
  }
  await Promise.all(tasks);
}

/** GET /api/projects/:id/workspace — list files written by agents in this project */
projectsRouter.get('/projects/:id/workspace', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });

    const workspaceDir = path.join(PROJECTS_DIR, req.params.id, 'workspace');
    if (!fs.existsSync(workspaceDir)) return res.json([]);

    const files: Array<{
      filename: string;
      content: string;
      sizeBytes: number;
      modifiedAt: string;
    }> = [];
    await readWorkspaceDir(workspaceDir, '', files);

    // Sort: most recently modified first
    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read project workspace' });
  }
});

/** GET /api/projects/:id/context — list read-only context files for this project */
projectsRouter.get('/projects/:id/context', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });

    const contextDir = path.join(PROJECTS_DIR, req.params.id, 'context');
    if (!fs.existsSync(contextDir)) return res.json([]);

    const files: Array<{
      filename: string;
      content: string;
      sizeBytes: number;
      modifiedAt: string;
    }> = [];
    await readWorkspaceDir(contextDir, '', files);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read project context' });
  }
});

// ─── Agent ↔ Project membership ───────────────────────────────────────────────

/** GET /api/projects/:id/agents — list agents assigned to this project */
projectsRouter.get('/projects/:id/agents', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json(getProjectAgents(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list project agents' });
  }
});

/** POST /api/projects/:id/agents — assign an agent to this project */
projectsRouter.post('/projects/:id/agents', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { agentId, role } = req.body as { agentId?: string; role?: string };
    if (!agentId) return res.status(400).json({ error: 'agentId required' });
    linkAgentToProject(agentId, req.params.id, role);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign agent to project' });
  }
});

/** DELETE /api/projects/:id/workspace/file — delete a file or folder from the shared
 *  workspace. `path` may name either — rmSync handles both (recursive removes a folder). */
projectsRouter.delete('/projects/:id/workspace/file', (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project || !ownsResource(req, project.owner_id)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const relPath = sanitiseRefPath(String(req.query.path ?? ''));
    if (!relPath) return res.status(400).json({ error: 'path required' });

    const wsDir = path.join(PROJECTS_DIR, req.params.id, 'workspace');
    const target = path.resolve(path.join(wsDir, relPath));
    if (!target.startsWith(path.resolve(wsDir))) {
      return res.status(403).json({ error: 'Path traversal rejected' });
    }

    if (!fs.existsSync(target))
      return res.status(404).json({ error: 'Not found' });
    fs.rmSync(target, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** DELETE /api/projects/:id/agents/:agentId — remove an agent from this project */
projectsRouter.delete('/projects/:id/agents/:agentId', (req, res) => {
  try {
    unlinkAgentFromProject(req.params.agentId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove agent from project' });
  }
});

/** GET /api/agents/:id/projects — list projects this agent is assigned to */
projectsRouter.get('/agents/:id/projects', (req, res) => {
  try {
    // :id here is an AGENT — the /projects/:id guard doesn't apply. Check agent ownership.
    const agent = getAgent(req.params.id);
    if (!agent || !ownsResource(req, agent.owner_id))
      return res.status(404).json({ error: 'Not found' });
    res.json(getAgentProjects(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Failed to list agent projects' });
  }
});

/** GET /api/projects/:id/memory/search — FTS5 search across all agents on this project */
projectsRouter.get('/projects/:id/memory/search', async (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    const { q, limit = '20' } = req.query as Record<string, string>;
    if (!q || !q.trim())
      return res.status(400).json({ error: 'q parameter required' });

    const agents = getProjectAgents(req.params.id);
    if (agents.length === 0) return res.json([]);

    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    const perAgent = Math.max(1, Math.ceil(lim / agents.length));

    const rows: unknown[] = [];
    for (const agent of agents) {
      const results = await searchAgentMemoryRanked(
        (agent as any).id,
        q,
        perAgent,
      );
      for (const r of results) {
        rows.push({
          ...(r as object),
          agent_name: (agent as any).name,
          agent_emoji: (agent as any).emoji,
        });
      }
    }

    rows.sort((a: any, b: any) => (a.search_rank ?? 0) - (b.search_rank ?? 0));
    res.json(rows.slice(0, lim));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/projects/:id/message — agent posts a message into the project group chat feed */
projectsRouter.post('/projects/:id/message', (req, res) => {
  try {
    const projectId = String(req.params.id);
    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { message, agentId } = req.body as {
      message?: string;
      agentId?: string;
    };
    if (!message?.trim())
      return res.status(400).json({ error: 'message required' });

    // Resolve sender display name from agent record if agentId provided
    let senderDisplay = 'Agent';
    if (agentId) {
      const agent = getAgent(agentId);
      if (agent) {
        senderDisplay = agent.emoji
          ? `${agent.emoji} ${agent.name}`
          : agent.name;
      }
    }

    const chatJid = project.chat_jid ?? `project:${projectId}`;
    const msgId = `proj_msg_${randomUUID()}`;
    const timestamp = new Date().toISOString();

    storeChatMetadata(chatJid, timestamp, project.name, 'project', true);
    storeMessageDirect({
      id: msgId,
      chat_jid: chatJid,
      sender: senderDisplay,
      sender_name: senderDisplay,
      content: message.trim(),
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });
    appendChatMessageEvent(chatJid, {
      content: message.trim(),
      sender: senderDisplay,
      source: 'project',
      legacyMsgId: msgId,
    });

    getSocketIO()?.emit('chat:message', {
      id: msgId,
      chatJid,
      text: message.trim(),
      timestamp,
      sender: senderDisplay,
    });

    logger.info(
      { projectId, agentId, sender: senderDisplay },
      'Agent posted to project group chat',
    );
    return res.json({ id: msgId, timestamp });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.get(
  '/projects/:id/channels/whatsapp/groups',
  async (req, res) => {
    try {
      const projectId = String(req.params.id);
      const ownerId = req.user!.id;
      const wa = whatsAppSessions.status(ownerId);
      const dbBindings = getProjectGroupBindings(projectId);

      // List all participating groups of this owner
      let fetched: any[] = [];
      if (wa.state === 'connected') {
        try {
          fetched = await whatsAppSessions.getGroups(ownerId);
        } catch (e) {
          // Ignore error and fall back to empty list for selection
        }
      }

      // Resolve names for project bound groups
      const activeGroups = dbBindings.map((b) => {
        const match = fetched.find((f) => f.jid === b.target_jid);
        return {
          id: b.id,
          jid: b.target_jid,
          name: match ? match.name : b.target_jid || 'Unknown Group',
          enabled: b.enabled,
          triggerMode: b.trigger_mode,
        };
      });

      res.json({
        state: wa.state,
        connected: wa.state === 'connected',
        number: wa.number,
        groups: activeGroups,
        availableGroups: fetched,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

projectsRouter.post('/projects/:id/channels/whatsapp/groups', (req, res) => {
  try {
    const projectId = String(req.params.id);
    const { groupJid } = req.body as { groupJid?: string };
    if (!groupJid) return res.status(400).json({ error: 'groupJid required' });
    linkGroupToProject(req.user!.id, projectId, groupJid);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

projectsRouter.put(
  '/projects/:id/channels/whatsapp/groups/:jid',
  (req, res) => {
    try {
      const projectId = String(req.params.id);
      const groupJid = req.params.jid;
      const { enabled, triggerMode } = req.body as {
        enabled?: boolean;
        triggerMode?: 'mention' | 'all';
      };
      if (typeof enabled !== 'boolean')
        return res.status(400).json({ error: 'enabled (boolean) required' });
      setProjectGroupEnabled(projectId, groupJid, enabled, triggerMode);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

projectsRouter.delete(
  '/projects/:id/channels/whatsapp/groups/:jid',
  (req, res) => {
    try {
      const projectId = String(req.params.id);
      const groupJid = req.params.jid;
      unlinkGroupFromProject(projectId, groupJid);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);
