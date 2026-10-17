import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import {
  getRegisteredGroup,
  getChatHistory,
  getRouterState,
  setRouterState,
} from '../../db.js';
import { resetOrchestratorSession } from '../../orchestrator-bridge.js';
import { resolveGroupFolderPath } from '../../group-folder.js';
import type { Request, Response } from 'express';

export const chatRouter = Router();

// The archived-session endpoints below operate on arbitrary group folders by jid and are
// not used by the client dashboard — restrict them to the operator so a client can't read
// or delete another tenant's conversation archives. Returns 404 (not 403) to avoid leaking.
function operatorOnly(req: Request, res: Response): boolean {
  if (req.user?.role !== 'admin') {
    res.status(404).json({ error: 'Not found' });
    return false;
  }
  return true;
}

/**
 * POST /api/chat/session/reset
 * Clears the Claude Code session for a JID's group folder.
 * The next message will start a fresh session.
 */
chatRouter.post('/chat/session/reset', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const { jid, metadata } = req.body as { jid?: string; metadata?: any };
  if (!jid) return res.status(400).json({ error: 'jid required' });

  try {
    const group = getRegisteredGroup(jid);
    if (!group)
      return res
        .status(404)
        .json({ error: 'No registered group for this JID' });

    const groupDir = resolveGroupFolderPath(group.folder);

    // Only archive messages that belong to the CURRENT session (since last reset)
    const sessionStart = getRouterState(`session_start_${jid}`) ?? '';
    const messages = getChatHistory(jid, sessionStart);
    if (messages.length > 0) {
      const convoDir = path.join(groupDir, 'conversations');
      fs.mkdirSync(convoDir, { recursive: true });
      const dateStr = new Date()
        .toISOString()
        .slice(0, 19)
        .replace('T', '-')
        .replace(/:/g, '-');
      const filename = `${dateStr}.md`;
      const firstUser = messages.find((m) => m.is_from_me);
      const summary =
        ((firstUser ?? messages[0]).content ?? '')
          .slice(0, 70)
          .replace(/\n/g, ' ')
          .trim() || 'Conversation';
      const body = messages
        .map((m) => {
          const role = m.is_from_me ? 'You' : m.sender_name || 'NanoCrew';
          return `**${role}**\n\n${m.content}`;
        })
        .join('\n\n---\n\n');

      let footer = '';
      if (metadata) {
        footer = `\n\n<!-- metadata:${JSON.stringify(metadata)} -->`;
      }

      fs.writeFileSync(
        path.join(convoDir, filename),
        `# ${summary}\n\n${body}${footer}`,
        'utf-8',
      );
    }

    // Advance the session boundary — messages API will now only return messages after this point
    const now = new Date().toISOString();
    setRouterState(`session_start_${jid}`, now);

    resetOrchestratorSession(group.folder);
    res.json({ ok: true, folder: group.folder });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset session' });
  }
});

/**
 * GET /api/chat/sessions/:jid
 * Lists archived conversation files for a JID's group workspace.
 */
chatRouter.get('/chat/sessions/:jid', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const jid = decodeURIComponent(req.params.jid);

  try {
    const group = getRegisteredGroup(jid);
    if (!group)
      return res
        .status(404)
        .json({ error: 'No registered group for this JID' });

    const groupDir = resolveGroupFolderPath(group.folder);
    const convoDir = path.join(groupDir, 'conversations');

    if (!fs.existsSync(convoDir)) {
      return res.json({ sessions: [] });
    }

    const files = fs
      .readdirSync(convoDir)
      .filter((f) => f.endsWith('.md'))
      .map((filename) => {
        const filePath = path.join(convoDir, filename);
        const stat = fs.statSync(filePath);
        // First line of the file is the summary (set by the pre-compact hook)
        let summary = filename
          .replace(/\.md$/, '')
          .replace(/^\d{4}-\d{2}-\d{2}-/, '')
          .replace(/-/g, ' ');
        try {
          const firstLine = fs
            .readFileSync(filePath, 'utf-8')
            .split('\n')
            .find((l) => l.trim());
          if (firstLine) summary = firstLine.replace(/^#+\s*/, '').trim();
        } catch {
          /* use filename as fallback */
        }
        return {
          filename,
          summary,
          created_at: stat.mtime.toISOString(),
          size: stat.size,
        };
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    res.json({ sessions: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

/**
 * DELETE /api/chat/sessions/:jid/:filename
 * Deletes an archived conversation file.
 */
chatRouter.delete('/chat/sessions/:jid/:filename', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const jid = decodeURIComponent(req.params.jid);
  const filename = req.params.filename;

  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    !filename.endsWith('.md')
  ) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const group = getRegisteredGroup(jid);
    if (!group)
      return res
        .status(404)
        .json({ error: 'No registered group for this JID' });

    const groupDir = resolveGroupFolderPath(group.folder);
    const filePath = path.join(groupDir, 'conversations', filename);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'Session not found' });

    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

/**
 * GET /api/chat/sessions/:jid/:filename
 * Returns the content of a specific archived conversation file.
 */
chatRouter.get('/chat/sessions/:jid/:filename', (req, res) => {
  if (!operatorOnly(req, res)) return;
  const jid = decodeURIComponent(req.params.jid);
  const filename = req.params.filename;

  // Prevent path traversal
  if (
    filename.includes('/') ||
    filename.includes('\\') ||
    !filename.endsWith('.md')
  ) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  try {
    const group = getRegisteredGroup(jid);
    if (!group)
      return res
        .status(404)
        .json({ error: 'No registered group for this JID' });

    const groupDir = resolveGroupFolderPath(group.folder);
    const filePath = path.join(groupDir, 'conversations', filename);

    if (!fs.existsSync(filePath))
      return res.status(404).json({ error: 'Session not found' });

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ filename, content });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read session' });
  }
});
