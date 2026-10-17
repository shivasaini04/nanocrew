import fs from 'fs';
import path from 'path';

import { DATA_DIR, IPC_POLL_INTERVAL, MAIN_GROUP_FOLDER } from './config.js';
import { AvailableGroup } from './container-runner.js';
import { deleteTask, getTaskById, updateTask } from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = [];
      const topLevel = await fs.promises.readdir(ipcBaseDir, {
        withFileTypes: true,
      });
      for (const entry of topLevel) {
        // `jobs` and `queue` held the job containers' IPC and the old swarm queue, both
        // removed in stage 57; a leftover directory must not be read as a group.
        if (
          !entry.isDirectory() ||
          entry.name === 'errors' ||
          entry.name === 'jobs' ||
          entry.name === 'queue'
        )
          continue;
        if (entry.name === 'agents') {
          // Agent-cycle IPC dirs live one level deeper: data/ipc/agents/{agentId}/
          const subAgents = await fs.promises.readdir(
            path.join(ipcBaseDir, 'agents'),
            { withFileTypes: true },
          );
          for (const agent of subAgents) {
            if (agent.isDirectory()) groupFolders.push(`agents/${agent.name}`);
          }
        } else if (entry.name === 'projects') {
          // Project IPC dirs live two levels deeper: data/ipc/projects/{projId}/{groupName}/
          const subProjects = await fs.promises.readdir(
            path.join(ipcBaseDir, 'projects'),
            { withFileTypes: true },
          );
          for (const proj of subProjects) {
            if (!proj.isDirectory()) continue;
            const projSubDirs = await fs.promises.readdir(
              path.join(ipcBaseDir, 'projects', proj.name),
              { withFileTypes: true },
            );
            for (const sub of projSubDirs) {
              if (sub.isDirectory())
                groupFolders.push(`projects/${proj.name}/${sub.name}`);
            }
          }
        } else {
          groupFolders.push(entry.name);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        let messageFiles: string[];
        try {
          messageFiles = (await fs.promises.readdir(messagesDir)).filter((f) =>
            f.endsWith('.json'),
          );
        } catch {
          messageFiles = [];
        }
        for (const file of messageFiles) {
          const filePath = path.join(messagesDir, file);
          try {
            const data = JSON.parse(
              await fs.promises.readFile(filePath, 'utf-8'),
            );
            if (data.type === 'message' && data.chatJid && data.text) {
              // Authorization: verify this group can send to this chatJid
              const targetGroup = registeredGroups[data.chatJid];
              if (
                isMain ||
                (targetGroup && targetGroup.folder === sourceGroup)
              ) {
                await deps.sendMessage(data.chatJid, data.text);
                logger.info(
                  { chatJid: data.chatJid, sourceGroup },
                  'IPC message sent',
                );
              } else {
                logger.warn(
                  { chatJid: data.chatJid, sourceGroup },
                  'Unauthorized IPC message attempt blocked',
                );
              }
            }
            await fs.promises.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC message',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fs.promises.mkdir(errorDir, { recursive: true });
            await fs.promises.rename(
              filePath,
              path.join(errorDir, `${sourceGroup.replace(/\//g, '_')}-${file}`),
            );
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        let taskFiles: string[];
        try {
          taskFiles = (await fs.promises.readdir(tasksDir)).filter((f) =>
            f.endsWith('.json'),
          );
        } catch {
          taskFiles = [];
        }
        for (const file of taskFiles) {
          const filePath = path.join(tasksDir, file);
          try {
            const data = JSON.parse(
              await fs.promises.readFile(filePath, 'utf-8'),
            );
            // Pass source group identity to processTaskIpc for authorization
            await processTaskIpc(data, sourceGroup, isMain, deps);
            await fs.promises.unlink(filePath);
          } catch (err) {
            logger.error(
              { file, sourceGroup, err },
              'Error processing IPC task',
            );
            const errorDir = path.join(ipcBaseDir, 'errors');
            await fs.promises.mkdir(errorDir, { recursive: true });
            await fs.promises.rename(
              filePath,
              path.join(errorDir, `${sourceGroup.replace(/\//g, '_')}-${file}`),
            );
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }
    }

    if (ipcWatcherRunning) setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export function stopIpcWatcher(): void {
  ipcWatcherRunning = false;
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      // Retired with the job system (stage 57, 2026-09-29). A scheduled task's only runner
      // queued it as a background job, and jobs are gone — storing one now would create a
      // task that never runs. Agents schedule work with their own timers (config.schedule).
      // pause/resume/cancel below still work on any rows that already exist.
      logger.warn(
        { sourceGroup, targetJid: data.targetJid },
        'schedule_task refused — legacy scheduled tasks are retired; use agent timers',
      );
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
