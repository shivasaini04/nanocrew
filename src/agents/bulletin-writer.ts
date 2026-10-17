/**
 * BulletinWriter — maintains BULLETIN.md inside each project's shared workspace.
 *
 * The bulletin is the coordination primitive for multi-agent projects: it tells
 * every agent what other agents are doing, what files exist in the shared workspace,
 * and what handoffs are pending. The orchestrator writes it; agents only read it.
 *
 * Called after every successful agent cycle or job completion for a project.
 */

import fs from 'fs';
import path from 'path';

import { PROJECTS_DIR } from '../config.js';
import { getProjectAgents, getCyclesByAgent, getProject } from '../db.js';
import { logger } from '../logger.js';

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function listSharedFiles(sharedDir: string): string[] {
  try {
    if (!fs.existsSync(sharedDir)) return [];
    return fs
      .readdirSync(sharedDir)
      .filter((f) => f !== 'BULLETIN.md')
      .map((f) => {
        const stat = fs.statSync(path.join(sharedDir, f));
        const ts = new Date(stat.mtime)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ');
        return `- ${f}  (${ts})`;
      });
  } catch {
    return [];
  }
}

/**
 * Rebuild BULLETIN.md for a project. Safe to call concurrently — writes atomically.
 */
export function updateBulletin(
  projectId: string,
  triggerAgentId?: string,
): void {
  try {
    const project = getProject(projectId);
    if (!project) return;

    const sharedDir = path.join(PROJECTS_DIR, projectId, 'workspace');
    const bulletinPath = path.join(sharedDir, 'BULLETIN.md');

    fs.mkdirSync(sharedDir, { recursive: true });

    const agents = getProjectAgents(projectId);
    const now = new Date();
    const nowIso = now.toISOString();
    const todayDate = nowIso.slice(0, 10);

    // ── Active / Idle agents section ──────────────────────────────────────────
    const agentLines: string[] = [];
    const completionLines: string[] = [];

    for (const agent of agents) {
      const isActive =
        agent.status === 'running' && agent.id === triggerAgentId;
      const statusIcon = isActive ? '● WORKING' : '○ IDLE';
      const lastActive = agent.last_active
        ? `  (last active ${formatTimestamp(agent.last_active)})`
        : '';
      const roleLabel = agent.role ? ` [${agent.role}]` : '';
      agentLines.push(
        `- ${agent.emoji ?? '🤖'} ${agent.name}${roleLabel} — ${statusIcon}${lastActive}`,
      );

      // Recent completions: last 3 completed cycles for this agent today
      const cycles = getCyclesByAgent(agent.id, 20)
        .filter(
          (c) => c.status === 'completed' && c.started_at.startsWith(todayDate),
        )
        .slice(0, 3);
      for (const c of cycles) {
        const time = formatTimestamp(c.started_at);
        const summary = (c.summary ?? 'completed cycle').slice(0, 100);
        completionLines.push(
          `- ${time} — ${agent.emoji ?? '🤖'} ${agent.name}: ${summary}`,
        );
      }
    }

    // ── Shared files section ──────────────────────────────────────────────────
    const sharedFiles = listSharedFiles(sharedDir);

    // ── Compose bulletin ──────────────────────────────────────────────────────
    const updatedAt = nowIso.slice(0, 16).replace('T', ' ');
    const sections: string[] = [
      `# Project: ${project.name} [Updated: ${updatedAt}]`,
      '',
      '## Agents',
      ...(agentLines.length > 0 ? agentLines : ['- (no agents assigned yet)']),
    ];

    if (completionLines.length > 0) {
      sections.push('', '## Recent Work (today)', ...completionLines);
    }

    if (sharedFiles.length > 0) {
      sections.push('', '## Shared Files', ...sharedFiles);
    } else {
      sections.push(
        '',
        '## Shared Files',
        '- (none yet — write to /workspace/shared/ to share with other agents)',
      );
    }

    const content = sections.join('\n') + '\n';

    // Atomic write via tmp file
    const tmpPath = bulletinPath + '.tmp';
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, bulletinPath);

    logger.debug(
      { projectId, agentCount: agents.length },
      'BULLETIN.md updated',
    );
  } catch (err) {
    logger.warn({ projectId, err }, 'Failed to update BULLETIN.md — non-fatal');
  }
}
