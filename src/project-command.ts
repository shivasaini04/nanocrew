import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { GROUPS_DIR, PROJECTS_DIR } from './config.js';
import {
  createProject,
  getProjectByName,
  getProject,
  linkChatToProject,
  linkAgentToProject,
  getAllAgents,
  getProjectAgents,
  listProjects,
  getActiveProjectForChat,
} from './db.js';
import type { RegisteredGroup } from './types.js';
import { logger } from './logger.js';

export interface ProjectCommandDeps {
  /** Send a chat message back into the originating chat. */
  sendMessage: (jid: string, text: string) => Promise<void> | void;
  /**
   * For dashboard/agent chats: set the project context in the current chat
   * (stays in the same chat, updates the project picker pill).
   */
  emitProjectContextSet: (p: {
    chatJid: string;
    projectId: string;
    projectName: string;
  }) => void;
  /**
   * Legacy: for WhatsApp/group chats that still navigate to a project:<id> chat.
   * Only called when chatJid is NOT a dashboard-style chat.
   */
  emitProjectOpened: (p: {
    projectId: string;
    projectJid: string;
    projectName: string;
  }) => void;
  /** Register an in-memory group so the orchestrator loop polls the new project chat (legacy path). */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

/**
 * Handle `/project start|open|add|list` commands.
 *
 * Dashboard/agent chats (`agent:`, `dash:`) use the redirect approach:
 *   - Stay in the current chat
 *   - Emit `project:context:set` to update the project picker pill
 *   - Link the chat JID to the project so getActiveProjectForChat() works
 *
 * WhatsApp/group chats use the legacy approach:
 *   - Navigate to a dedicated `project:<id>` chat
 *
 * @returns true if handled, false otherwise.
 */
export async function handleProjectCommand(
  chatJid: string,
  rawText: string,
  deps: ProjectCommandDeps,
): Promise<boolean> {
  const text = rawText.trim();
  if (!text.toLowerCase().startsWith('/project')) return false;

  const {
    sendMessage,
    emitProjectContextSet,
    emitProjectOpened,
    registerGroup,
  } = deps;
  const parts = text.split(/\s+/);
  const subCmd = parts[1]?.toLowerCase();
  const projectName = parts.slice(2).join(' ').trim();

  const isDashboardLike =
    chatJid.startsWith('dash:') || chatJid.startsWith('agent:');

  // ── /project start <name> ──────────────────────────────────────────────────
  if (subCmd === 'start' && projectName) {
    const projectId = `proj_${Date.now()}_${randomUUID().split('-')[0]}`;
    const now = new Date().toISOString();

    if (isDashboardLike) {
      // Redirect approach: the agent chat IS the project chat.
      // No separate project:<id> JID; no group registration.
      createProject({
        id: projectId,
        name: projectName,
        chat_jid: chatJid,
        status: 'active',
        created_at: now,
        updated_at: now,
      });

      // Provision project workspace + context brief
      const contextDir = path.join(PROJECTS_DIR, projectId, 'context');
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(path.join(PROJECTS_DIR, projectId, 'workspace'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(contextDir, 'PROJECT.md'),
        `# Project: ${projectName}\n\nID: ${projectId}\nCreated: ${now}\n\n## File Storage Rules\n\n- **ALL project files MUST be created in \`/workspace/shared/\`** — this is the persistent project workspace shared across all jobs and sessions.\n- Your session state (memory, logs) lives in \`/workspace/group/\` — do not mix project files there.\n`,
      );

      // Link this chat to the project so getActiveProjectForChat() works as fallback
      linkChatToProject(projectId, chatJid);

      // Tell the frontend to set project context (stays in current chat, updates picker pill)
      emitProjectContextSet({ chatJid, projectId, projectName });

      await sendMessage(
        chatJid,
        `🗂️ Project *"${projectName}"* created.\n\nThis chat is now in project mode — every message and job runs in the shared project workspace.\n[project-id:${projectId}]`,
      );
    } else {
      // Legacy: WhatsApp/group — create a separate project:<id> chat
      const projectJid = `project:${projectId}`;
      createProject({
        id: projectId,
        name: projectName,
        chat_jid: projectJid,
        status: 'active',
        created_at: now,
        updated_at: now,
      });

      const contextDir = path.join(PROJECTS_DIR, projectId, 'context');
      fs.mkdirSync(contextDir, { recursive: true });
      fs.mkdirSync(path.join(PROJECTS_DIR, projectId, 'workspace'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(contextDir, 'PROJECT.md'),
        `# Project: ${projectName}\n\nID: ${projectId}\nCreated: ${now}\n\n## File Storage Rules\n\n- **ALL project files MUST be created in \`/workspace/shared/\`**\n`,
      );

      const projectFolder = `projects/${projectId}/group`;
      const groupDir = path.join(PROJECTS_DIR, projectId, 'group');
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, '.project-identity'), projectId);

      const globalIdentityPath = path.join(GROUPS_DIR, 'global', 'IDENTITY.md');
      const globalIdentity = fs.existsSync(globalIdentityPath)
        ? fs.readFileSync(globalIdentityPath, 'utf-8')
        : '';
      const projectIdentity = globalIdentity
        ? globalIdentity.replace(
            /Files you create are saved in `[^`]+`[^\n]*/,
            `Files you create are saved in \`/workspace/shared/\`. This is the persistent project workspace shared across all jobs and sessions. Your session state (memory, logs) is in \`/workspace/group/\` — do NOT mix project files there.`,
          )
        : `# ${projectName}\n\nFiles you create are saved in \`/workspace/shared/\`. This is the persistent project workspace.`;
      fs.writeFileSync(path.join(groupDir, 'IDENTITY.md'), projectIdentity);

      registerGroup(projectJid, {
        name: projectName,
        folder: projectFolder,
        trigger: '',
        added_at: now,
        requiresTrigger: false,
      });
      emitProjectOpened({ projectId, projectJid, projectName });

      await sendMessage(
        chatJid,
        `Project *"${projectName}"* created.\n\nAll jobs spawned in this chat will share a workspace at \`/workspace/shared/\`.\n[project-id:${projectId}]`,
      );
    }
    logger.info({ chatJid, projectId, projectName }, '/project start handled');

    // ── /project open <name> ───────────────────────────────────────────────────
  } else if (subCmd === 'open' && projectName) {
    const project = getProjectByName(projectName);
    if (!project) {
      await sendMessage(
        chatJid,
        `No active project named *"${projectName}"* found. Use \`/project start ${projectName}\` to create it.`,
      );
      return true;
    }

    if (isDashboardLike) {
      // Redirect: link this chat and set context picker
      linkChatToProject(project.id, chatJid);
      emitProjectContextSet({
        chatJid,
        projectId: project.id,
        projectName: project.name,
      });
      await sendMessage(
        chatJid,
        `🗂️ Now in project *"${project.name}"* mode.\n\nMessages and jobs run in the shared project workspace.\n[project-id:${project.id}]`,
      );
    } else if (project.chat_jid?.startsWith('project:')) {
      emitProjectOpened({
        projectId: project.id,
        projectJid: project.chat_jid,
        projectName: project.name,
      });
      await sendMessage(
        chatJid,
        `Opening project *"${project.name}"* chat.\n[project-id:${project.id}]`,
      );
    } else {
      linkChatToProject(project.id, chatJid);
      await sendMessage(
        chatJid,
        `Joined project *"${project.name}"*.\n\nJobs spawned here will share \`/workspace/shared/\`.\n[project-id:${project.id}]`,
      );
    }

    // ── /project add <AgentName> [to <ProjectName>] ────────────────────────────
  } else if (subCmd === 'add' && projectName) {
    const toIdx = parts.findIndex((p) => p.toLowerCase() === 'to');
    const agentNamePart =
      toIdx > 2 ? parts.slice(2, toIdx).join(' ').trim() : projectName;
    const targetProjectName =
      toIdx > 2
        ? parts
            .slice(toIdx + 1)
            .join(' ')
            .trim()
        : undefined;

    const agents = getAllAgents();
    const targetAgent = agents.find(
      (a) => a.name.toLowerCase() === agentNamePart.toLowerCase(),
    );
    if (!targetAgent) {
      await sendMessage(
        chatJid,
        `_No agent named *"${agentNamePart}"* found._`,
      );
      return true;
    }

    let targetProject = targetProjectName
      ? getProjectByName(targetProjectName)
      : undefined;
    if (!targetProject && !targetProjectName) {
      // Infer from current chat context
      targetProject = getActiveProjectForChat(chatJid);
      if (!targetProject && chatJid.startsWith('project:')) {
        targetProject =
          getProject(chatJid.replace('project:', '')) ?? undefined;
      }
    }
    if (!targetProject) {
      await sendMessage(
        chatJid,
        `_No active project in this chat. Specify: \`/project add ${agentNamePart} to <ProjectName>\`_`,
      );
      return true;
    }

    linkAgentToProject(targetAgent.id, targetProject.id);
    await sendMessage(
      chatJid,
      `✅ *${targetAgent.emoji ?? '🤖'} ${targetAgent.name}* added to project *"${targetProject.name}"*.\nThey appear on the bulletin board and their memory is searchable by crew.`,
    );
    logger.info(
      { agentId: targetAgent.id, projectId: targetProject.id },
      '/project add handled',
    );

    // ── /project list ──────────────────────────────────────────────────────────
  } else if (subCmd === 'list') {
    const projects = listProjects('active');
    if (projects.length === 0) {
      await sendMessage(
        chatJid,
        `_No active projects. Use \`/project start <name>\` to create one._`,
      );
    } else {
      const lines = projects.map((p) => {
        const members = getProjectAgents(p.id);
        const memberNames =
          members.map((a) => `${a.emoji ?? '🤖'} ${a.name}`).join(', ') ||
          'no agents yet';
        return `• *${p.name}* \`${p.id}\` — ${memberNames}`;
      });
      await sendMessage(chatJid, `*Active projects:*\n${lines.join('\n')}`);
    }

    // ── usage ──────────────────────────────────────────────────────────────────
  } else {
    await sendMessage(
      chatJid,
      `Usage:\n• \`/project start <name>\` — create a new project\n• \`/project open <name>\` — enter project mode in this chat\n• \`/project add <AgentName>\` — add an agent to the current project\n• \`/project list\` — list active projects and their members`,
    );
  }

  return true;
}
