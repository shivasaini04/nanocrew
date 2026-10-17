import './instrument.js'; // Sentry init — must be first (no-op unless SENTRY_DSN set)
import fs from 'fs';
import { createApiServer } from './api/server.js';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { whatsAppSessions } from './channels/whatsapp-session.js';
import { startOwnerNotify } from './owner-notify/index.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  closeDatabase,
  logTokenUsage,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getAgentByWhatsappJid,
  getActiveProjectForChat,
  getProject,
  listProjects,
  reconcileStuckCycles,
  backfillConversationEvents,
  getAllUsers,
  getAgent,
  expireOverdueHandoffs,
  getAgentCycleById,
  getCyclesByAgent,
} from './db.js';
import { notify } from './notifications.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher, stopIpcWatcher } from './ipc.js';
import { startSwarmService } from './swarm/service.js';
import {
  startFileEventWatcher,
  stopFileEventWatcher,
} from './file-event-watcher.js';
import {
  findChannel,
  formatMessages,
  formatOutbound,
} from './channels/outbound.js';
import {
  agentScheduler,
  agentService,
  resumeCycle,
} from './agents/agent-registry.js';
import {
  isDraining,
  startDraining,
  waitForIdle,
  decideResume,
  DRAIN_MAX_MS,
  RESUME_AFTER_BOOT_MS,
  RESUME_LOOP_WINDOW_MS,
} from './agents/drain.js';
import { startModelHealth } from './agents/model-health.js';
import { runConfigAuditDigest } from './agents/config-audit-digest.js';
import { daemonPool } from './agents/daemon-pool.js';
import { SCHEDULER_POLL_INTERVAL } from './config.js';
import { parseMentions, hasMentions } from './agents/mention-parser.js';
import { handleProjectCommand } from './project-command.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { startEgressGateway } from './agents/egress-gateway.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './channels/outbound.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel | undefined;
const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const rawPrompt = formatMessages(missedMessages);

  // For project chats, inject file storage rules directly into the prompt
  // so the agent always knows where to save files, regardless of CLAUDE.md loading.
  const projectForPrompt = chatJid.startsWith('project:')
    ? getProject(chatJid.replace('project:', ''))
    : null;
  const prompt = projectForPrompt
    ? `<system_note>You are in a dedicated project chat for project "${projectForPrompt.name}" (ID: ${projectForPrompt.id}).
FILE STORAGE RULE: Save all project files to /workspace/shared/ — this is the persistent project workspace.
Your session state (memory, logs) stays in /workspace/group/. Do not mix project files there.
Example: to create report.md, write it to /workspace/shared/report.md</system_note>

${rawPrompt}`
    : rawPrompt;

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  // For project: JIDs, mount the project workspace so the agent can use /workspace/shared/
  const chatProject = chatJid.startsWith('project:')
    ? getProject(chatJid.replace('project:', ''))
    : getActiveProjectForChat(chatJid);

  // Persist ONE message per agent turn. The adapter emits many partial token chunks
  // via print_output() during streaming, then one consolidated final via print_success()
  // which is the only one carrying `usage`. Previously we saved every chunk as a
  // separate DB row, producing ~80 single-token rows per turn — the chat bubble then
  // rendered just the last token ("✦"). Fix: stream chunks via socket for live preview,
  // commit only the final.
  let streamingBuf = '';
  const emitLivePreview = (text: string) => {
    // Emit a non-persisted preview event so the dashboard can show in-flight text
    // without inserting a DB row. The dashboard already listens for chat:typing;
    // adding a parallel chat:stream event for partial text.
    (channel as any).io?.emit?.('chat:stream', { chatJid, text });
  };

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );

        // Heuristic: the final consolidated message arrives with `usage` set
        // (emitted by print_success). Everything else is a partial token delta.
        const isFinal = !!(
          result.usage && Object.keys(result.usage).length > 0
        );

        if (text) {
          if (isFinal) {
            // Final consolidated — replace any accumulated text with the authoritative
            // version and persist once.
            await channel.sendMessage(chatJid, text);
            outputSentToUser = true;
            streamingBuf = '';
          } else {
            // Partial delta — accumulate and emit live preview only.
            streamingBuf += raw;
            emitLivePreview(streamingBuf);
          }
        }
        resetIdleTimer();
      }

      if (result.status === 'success') {
        // Note: every partial chunk from print_output also carries status='success',
        // so this block fires on every callback — do NOT use it as a "stream end"
        // signal. The only reliable end signal is `result.usage` being populated
        // (only emitted by print_success). Handled above in the isFinal branch.
        queue.notifyIdle(chatJid);

        if (result.usage && Object.keys(result.usage).length > 0) {
          logTokenUsage(
            result.newSessionId || sessions[group.folder] || 'unknown',
            chatJid,
            result.model,
            result.usage,
          );
        }
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    chatProject?.id,
    chatProject?.name,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // End-of-stream guard: if no final consolidated message arrived (e.g. provider
  // returned no usage info), fall back to the accumulated buffer so the user still
  // sees the response. Runs ONCE after runAgent completes — not during streaming —
  // so it can't fire prematurely.
  if (!outputSentToUser && streamingBuf.trim()) {
    const fallback = streamingBuf
      .replace(/<internal>[\s\S]*?<\/internal>/g, '')
      .trim();
    if (fallback) {
      await channel.sendMessage(chatJid, fallback);
      outputSentToUser = true;
    }
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

/**
 * Watch activity.json written by NanoCrew_adapter.py in real-time, emitting
 * chat:activity socket events as new thinking/tool_call steps appear.
 *
 * The Python adapter writes activity.json incrementally (one write per tool call),
 * so polling this file is the reliable way to get live activity on the dashboard.
 * The old JSONL-based watcher was reading session transcripts that are only flushed
 * after the full response, so no events fired during the agent run.
 */
function startSessionWatcher(groupDir: string, chatJid: string): () => void {
  let stopped = false;
  // Track how many steps we've already emitted so we only emit new ones.
  // Initialised to null until we read the file once (so we skip pre-existing steps).
  let baseline: number | null = null;
  let lastEmitted = 0;

  getSocketIO()?.emit('chat:activity', { chatJid, type: 'start' });

  const activityFile = path.join(groupDir, 'activity.json');

  const poll = () => {
    if (stopped) return;
    try {
      if (fs.existsSync(activityFile)) {
        const raw = fs.readFileSync(activityFile, 'utf-8');
        const data = JSON.parse(raw) as {
          steps?: Array<Record<string, unknown>>;
        };
        const steps = data.steps ?? [];

        if (baseline === null) {
          // First successful read: treat current length as baseline so we
          // only forward steps that are written DURING this agent run.
          baseline = steps.length;
          lastEmitted = steps.length;
        }

        // Detect file reset (new run started, step count dropped)
        if (steps.length < lastEmitted) {
          baseline = 0;
          lastEmitted = 0;
        }

        for (let i = lastEmitted; i < steps.length; i++) {
          const step = steps[i] as {
            type?: string;
            id?: string;
            tool?: string;
            input?: string;
            content?: string;
          };
          if (step.type === 'thinking' && step.content) {
            getSocketIO()?.emit('chat:activity', {
              chatJid,
              type: 'thinking',
              content: step.content,
            });
          } else if (step.type === 'tool_call' && step.tool) {
            getSocketIO()?.emit('chat:activity', {
              chatJid,
              type: 'tool_call',
              callId: step.id ?? `${step.tool}_${Date.now()}`,
              tool: step.tool,
              input: step.input ?? '{}',
            });
          }
        }
        lastEmitted = steps.length;
      }
    } catch {
      /* file not yet written or mid-write — try again next tick */
    }
    setTimeout(poll, 300);
  };

  setTimeout(poll, 300);
  return () => {
    stopped = true;
    getSocketIO()?.emit('chat:activity', { chatJid, type: 'done' });
  };
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  projectId?: string,
  projectName?: string,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }

        if (output.usage && Object.keys(output.usage).length > 0) {
          logTokenUsage(
            output.newSessionId || sessions[group.folder] || 'unknown',
            chatJid,
            output.model,
            output.usage,
          );
        }

        await onOutput(output);
      }
    : undefined;

  const groupPath = resolveGroupFolderPath(group.folder);
  const stopWatcher = startSessionWatcher(groupPath, chatJid);

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        projectId,
        projectName,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  } finally {
    stopWatcher();
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoCrew running (trigger: @${ASSISTANT_NAME})`);

  // Safeguard: if lastTimestamp is in the future (NTP/Clock issue), reset it
  const now = new Date().toISOString();
  if (lastTimestamp > now) {
    logger.warn(
      { lastTimestamp, now },
      'Message cursor is in the future, resetting to now',
    );
    lastTimestamp = now;
    saveState();
  }

  let heartbeatTicks = 0;

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      if (heartbeatTicks % 15 === 0) {
        logger.debug(
          { jidsCount: jids.length, loopPulse: true },
          'Message loop heartbeat',
        );
      }
      heartbeatTicks++;

      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info(
          {
            count: messages.length,
            firstMsg: messages[0].content.slice(0, 20),
          },
          'New messages detected in loop',
        );

        // Advance the "seen" cursor for all messages immediately to prevent duplicate detection
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate into groups
        const groupBatches = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const list = groupBatches.get(msg.chat_jid) || [];
          list.push(msg);
          groupBatches.set(msg.chat_jid, list);
        }

        // Process each group in PARALLEL to prevent head-of-line blocking
        await Promise.allSettled(
          Array.from(groupBatches.entries()).map(
            async ([chatJid, groupMessages]) => {
              try {
                // 1. Agent-linked JID routing
                const linkedAgent = getAgentByWhatsappJid(chatJid);
                if (linkedAgent) {
                  const channel = findChannel(channels, chatJid);
                  if (!channel) return;
                  const userText = groupMessages
                    .map((m) => m.content)
                    .join('\n');
                  const apiKey = process.env.ANTHROPIC_API_KEY;
                  if (apiKey) {
                    const { readFileSync, existsSync } = await import('fs');
                    const { DATA_DIR } = await import('./config.js');
                    const identityPath = `${DATA_DIR}/agents/${linkedAgent.id}/IDENTITY.md`;
                    const identityMd = existsSync(identityPath)
                      ? readFileSync(identityPath, 'utf-8')
                      : `You are ${linkedAgent.name}.`;
                    const systemPrompt =
                      identityMd +
                      '\n\nYou are replying to your manager via WhatsApp. Be concise.';
                    const resp = await fetch(
                      'https://api.anthropic.com/v1/messages',
                      {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'x-api-key': apiKey,
                          'anthropic-version': '2023-06-01',
                        },
                        body: JSON.stringify({
                          model: 'claude-3-5-sonnet-20240620',
                          max_tokens: 512,
                          system: systemPrompt,
                          messages: [{ role: 'user', content: userText }],
                        }),
                      },
                    );
                    if (resp.ok) {
                      const data = (await resp.json()) as any;
                      const reply: string =
                        data.content?.[0]?.text ?? '(no response)';
                      await channel.sendMessage(
                        chatJid,
                        `${linkedAgent.emoji ?? '🤖'} *${linkedAgent.name}*\n${reply}`,
                      );
                      lastAgentTimestamp[chatJid] =
                        groupMessages[groupMessages.length - 1].timestamp;
                      saveState();
                      return;
                    }
                  }
                }

                const group = registeredGroups[chatJid];
                if (!group) return;
                const channel = findChannel(channels, chatJid);
                if (!channel) return;

                // Project chat messages are handled exclusively by the dashboard channel socket handler.
                // Running the orchestrator here too would fire a second cycle (Nano) on top of
                // the project agent that the socket already dispatched to.
                if (chatJid.startsWith('project:')) {
                  const ts = groupMessages[groupMessages.length - 1]?.timestamp;
                  if (ts) {
                    lastAgentTimestamp[chatJid] = ts;
                    saveState();
                  }
                  return;
                }

                // Trigger check
                const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
                if (!isMainGroup && group.requiresTrigger !== false) {
                  const hasTrigger = groupMessages.some((m) =>
                    TRIGGER_PATTERN.test(m.content.trim()),
                  );
                  if (!hasTrigger) return;
                }

                // Get full conversation window for this group
                const allPending = getMessagesSince(
                  chatJid,
                  lastAgentTimestamp[chatJid] || '',
                  ASSISTANT_NAME,
                );
                const messagesToSend =
                  allPending.length > 0 ? allPending : groupMessages;
                const formatted = formatMessages(messagesToSend);

                // Use the last raw message from the incoming batch for slash command detection.
                // `formatted` is XML-wrapped so startsWith('/project') on it always fails.
                // `groupMessages` are the messages that just arrived (always from the user),
                // so we don't need to filter by is_from_me — which differs per channel anyway.
                const lastRawContent =
                  groupMessages[groupMessages.length - 1]?.content?.trim() ??
                  '';

                // Skip pure @mention messages — the dashboard socket handler already dispatched
                // these to agents directly. Without this guard the polling loop would also spawn
                // a full orchestrator container and Nano would produce a duplicate/hallucinated reply.
                if (hasMentions(lastRawContent)) {
                  const mentions = parseMentions(lastRawContent);
                  let remaining = lastRawContent;
                  for (const mention of mentions) {
                    const idx = remaining.indexOf(mention.task);
                    if (idx !== -1)
                      remaining =
                        remaining.slice(0, idx) +
                        remaining.slice(idx + mention.task.length);
                  }
                  if (
                    !remaining
                      .replace(/@[\w][\w\-]*(?:\s[\w\-]+){0,3}/g, '')
                      .trim()
                  ) {
                    lastAgentTimestamp[chatJid] =
                      messagesToSend[messagesToSend.length - 1].timestamp;
                    saveState();
                    return;
                  }
                }

                // /project command — create or open a project (shared with the dashboard
                // socket path so the Assistant "Nano" chat handles it identically).
                if (lastRawContent.toLowerCase().startsWith('/project')) {
                  await handleProjectCommand(chatJid, lastRawContent, {
                    sendMessage: (jid, text) => channel.sendMessage(jid, text),
                    emitProjectContextSet: (p) =>
                      getSocketIO()?.emit('project:context:set', p),
                    emitProjectOpened: (p) =>
                      getSocketIO()?.emit('project:opened', p),
                    registerGroup,
                  });
                  lastAgentTimestamp[chatJid] =
                    messagesToSend[messagesToSend.length - 1].timestamp;
                  saveState();
                  return;
                }

                // Pipe to active container or queue
                if (queue.sendMessage(chatJid, formatted)) {
                  lastAgentTimestamp[chatJid] =
                    messagesToSend[messagesToSend.length - 1].timestamp;
                  saveState();
                  channel.setTyping?.(chatJid, true).catch(() => {});
                } else {
                  queue.enqueueMessageCheck(chatJid);
                }
              } catch (groupError) {
                logger.error(
                  { chatJid, groupError },
                  'Error processing group in message loop',
                );
              }
            },
          ),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

import { DashboardChannel } from './channels/dashboard.js';
import { getSocketIO, setChannelSender } from './api/instances.js';
import * as runtime from './container-runtime.js';
import { registerSessionReset } from './orchestrator-bridge.js';
import { deleteSession } from './db.js';

/** Stage 64 phase 3: gather what decideResume() needs for one restart-cut cycle. */
function shouldResumeAfterRestart(cycleId: string, agentId: string): boolean {
  const cycle = getAgentCycleById(cycleId);
  if (!cycle) return false;
  const since = Date.now() - RESUME_LOOP_WINDOW_MS;
  const recentCuts = getCyclesByAgent(agentId, 50).filter(
    (x) =>
      x.id !== cycleId &&
      x.summary === 'Orchestrator restarted mid-cycle' &&
      !!x.ended_at &&
      Date.parse(x.ended_at) >= since,
  ).length;
  return decideResume(cycle, recentCuts);
}

async function main(): Promise<void> {
  logger.info(
    'STARTING MAIN, bypassing ensureContainerRuntimeRunning for API testing',
  );
  // await runtime.ensureContainerRuntimeRunning();
  logger.info('ensureContainerRuntimeRunning bypassed. Calling initDatabase');

  initDatabase();
  logger.info('initDatabase DONE');
  // One-time project-folder migration: references → workspace + pins (DB must be ready).
  try {
    agentService.migrateReferencesToPins();
  } catch (e) {
    logger.warn({ err: String(e) }, '[migrate] references→pins failed');
  }
  // One-time migration: give every existing agent a weekly self_improve entry so
  // memory distillation + identity evolution start working for pre-existing accounts,
  // not just agents created after this fix.
  try {
    await agentService.backfillSelfImproveSchedule();
  } catch (e) {
    logger.warn({ err: String(e) }, '[migrate] self_improve backfill failed');
  }
  // Stage 34 — grandfather pre-existing episode history into the new distillation ledger so
  // established agents don't try to process months of backlog on their first post-deploy run.
  try {
    await agentService.backfillEpisodeLedger();
  } catch (e) {
    logger.warn({ err: String(e) }, '[migrate] episode ledger backfill failed');
  }
  // Stage 35 — fold pre-existing conversations (messages + cycle_steps + file_events) into
  // the conversation_events log so old threads render under the new read path. One-time,
  // non-destructive (skips conversations the dual-write already populated).
  try {
    const n = backfillConversationEvents();
    if (n)
      logger.info(
        { conversations: n },
        '[migrate] conversation-events backfill done',
      );
  } catch (e) {
    logger.warn(
      { err: String(e) },
      '[migrate] conversation-events backfill failed',
    );
  }
  // Stage 28 — every account needs its own Recruiter to hire agents. Provision for any
  // user missing one (covers pre-existing accounts; signup provisions new ones directly).
  try {
    for (const u of getAllUsers()) {
      try {
        await agentService.ensureRecruiterAgent(u.id);
      } catch (e) {
        logger.warn(
          { err: String(e), userId: u.id },
          'ensureRecruiterAgent backfill failed',
        );
      }
    }
  } catch (e) {
    logger.warn({ err: String(e) }, 'Recruiter backfill loop failed');
  }
  loadState();

  if (!registeredGroups['dash:default']) {
    registerGroup('dash:default', {
      name: 'Dashboard Chat',
      folder: 'dashboard',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
    logger.info('Registered dash:default group in-memory');
  }

  // Re-register active project JIDs so they are picked up by the message loop
  for (const project of listProjects('active')) {
    const projectJid = project.chat_jid;
    if (projectJid?.startsWith('project:') && !registeredGroups[projectJid]) {
      const projectId = projectJid.replace('project:', '');
      registerGroup(projectJid, {
        name: project.name,
        folder: `projects/${projectId}/group`,
        trigger: '',
        added_at: project.created_at,
        requiresTrigger: false,
      });
      logger.info({ projectJid, projectId }, 'Re-registered project group');
    }
  }

  registerSessionReset((groupFolder) => {
    delete sessions[groupFolder];
    deleteSession(groupFolder);
  });

  const reconciledCycles = reconcileStuckCycles();
  if (reconciledCycles.length > 0) {
    logger.info(
      { count: reconciledCycles.length },
      'Reconciled stuck agent cycles from previous run',
    );
    for (const c of reconciledCycles) {
      const agent = getAgent(c.agent_id);
      // Stage 64 phase 3: a run a person asked for is started again, once, with a note to
      // check what the cut run already did. Scheduled runs come round again on their own.
      const resume = shouldResumeAfterRestart(c.id, c.agent_id);
      notify(
        'cycle_failed',
        `${agent?.name ?? 'Agent'} — orchestrator restarted mid-cycle`,
        `${c.cycle_type} started at ${c.started_at} never finished — the orchestrator process ` +
          `restarted while it was running (not an agent error). It was auto-marked failed on ` +
          (resume
            ? `reboot and has been started again.`
            : `reboot; a scheduled run comes round again on its next slot.`),
        c.agent_id,
        {
          cycleType: c.cycle_type,
          cycleId: c.id,
          reason: 'orchestrator_restart',
          resumed: resume,
        },
      );
      if (resume) {
        // After boot settles (daemons, WhatsApp, the relay's first requests).
        const t = setTimeout(() => {
          void resumeCycle(
            c.agent_id,
            c.cycle_type,
            c.id,
            `(This task was interrupted by a server restart at ${new Date().toISOString()}. ` +
              `Check what was already done — files, sends, approvals — before repeating anything.)`,
          );
        }, RESUME_AFTER_BOOT_MS);
        t.unref?.();
      }
    }
  }

  agentScheduler.initFromDb();
  // Stage 57 — resume delegated runs a restart interrupted.
  startSwarmService();
  setInterval(() => {
    // Shutting down: nothing new starts (stage 64 phase 3, agents/drain.ts).
    if (isDraining()) return;
    agentScheduler.tick().catch((err: unknown) => {
      logger.error({ err }, 'Agent scheduler tick error');
    });
  }, SCHEDULER_POLL_INTERVAL);
  logger.info(
    { intervalMs: SCHEDULER_POLL_INTERVAL },
    'Agent scheduler started',
  );

  // Stage 54 phase 1 — roll up what the agents changed about themselves.
  //
  // A plain 24h interval rather than a cron at a fixed hour: the window the digest reads
  // is the same 24h either way, and an interval survives a restart without needing to
  // remember whether today's run already happened. A restart just shifts the hour.
  const AUDIT_DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000;
  setInterval(() => {
    try {
      runConfigAuditDigest(24);
    } catch (err) {
      logger.error({ err }, '[audit-digest] run failed');
    }
  }, AUDIT_DIGEST_INTERVAL_MS);
  logger.info(
    { intervalMs: AUDIT_DIGEST_INTERVAL_MS },
    'Config audit digest scheduled',
  );

  // Stage 56 phase 4 — lapse questions nobody answered, and say so.
  //
  // Ten minutes rather than hourly: a deadline the sender only learns about an hour late
  // is a deadline that has already cost it a cycle. The sweep is a single indexed query
  // over rows that carry a deadline at all, so the cost of running it often is nil.
  const HANDOFF_EXPIRY_INTERVAL_MS = 10 * 60 * 1000;
  setInterval(() => {
    try {
      const expired = expireOverdueHandoffs();
      if (expired.length > 0) {
        logger.info(
          { count: expired.length },
          '[handoffs] expired unanswered requests past their deadline',
        );
      }
    } catch (err) {
      logger.error({ err }, '[handoffs] expiry sweep failed');
    }
  }, HANDOFF_EXPIRY_INTERVAL_MS);
  logger.info(
    { intervalMs: HANDOFF_EXPIRY_INTERVAL_MS },
    'Handoff deadline sweep scheduled',
  );

  const apiPort = parseInt(process.env.DASHBOARD_PORT || '3002', 10);
  const apiServerPort = createApiServer(apiPort);

  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  channels.push(
    new DashboardChannel({
      ...channelOpts,
      io: getSocketIO()!,
      registerGroup,
    }),
  );

  // Operator/main WhatsApp channel (legacy single-tenant bot) — only start it when
  // explicitly enabled. Multi-tenant clients use per-client WhatsApp (whatsAppSessions,
  // Stage 30) instead. Left unauthenticated, this channel loops its QR forever and floods
  // the logs, so it must stay OFF unless the operator opts in with WHATSAPP_ENABLED=true.
  if (process.env.WHATSAPP_ENABLED === 'true') {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
  } else {
    logger.info(
      'Operator WhatsApp channel disabled (set WHATSAPP_ENABLED=true to enable).',
    );
  }

  // Expose a sender to modules that have no constructor to be injected through —
  // specifically the agent-facing API routes, which is how an agent's send_whatsapp
  // tool reaches a real channel. Mirrors the sendMessage callbacks handed to the task
  // scheduler, IPC watcher and job worker below, including the formatOutbound pass.
  setChannelSender(async (jid, rawText, sender) => {
    const channel = findChannel(channels, jid);
    if (!channel) throw new Error(`No channel owns JID: ${jid}`);
    const text = formatOutbound(rawText);
    if (text) await channel.sendMessage(jid, text, sender);
  });

  for (const ch of channels) {
    logger.info({ channel: ch.name }, 'Connecting channel...');
    // Add a 60s safety timeout so the orchestrator can start even if a channel is lagging
    const connectionTimeout = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${ch.name} connection timeout`)),
        60000,
      ),
    );
    try {
      await Promise.race([ch.connect(), connectionTimeout]);
      logger.info({ channel: ch.name }, 'Channel connected');
    } catch (err) {
      logger.warn(
        { channel: ch.name, err },
        'Channel failed to connect within timeout, proceeding anyway',
      );
    }
  }

  if (process.env.WHATSAPP_ENABLED === 'true' && whatsapp) {
    logger.info('Syncing WhatsApp metadata for group discovery...');
    await whatsapp.syncGroupMetadata(true);
    const chats = getAllChats();
    for (const chat of chats) {
      if (chat.is_group && chat.channel === 'whatsapp') {
        registerGroup(chat.jid, {
          name: chat.name || chat.jid,
          folder: chat.jid.replace(/[^a-zA-Z0-9.-]/g, '_'),
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: true,
        });
      }
    }
    logger.info('WhatsApp groups registered from database');
  }

  if (!registeredGroups['dash:default']) {
    logger.info('Registering default dashboard chat group');
    registerGroup('dash:default', {
      name: 'Dashboard Chat',
      folder: 'dashboard',
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });
  }

  // Stage 30 — restore any per-client WhatsApp sessions that were previously linked.
  whatsAppSessions
    .restoreAll()
    .catch((err) => logger.warn({ err: String(err) }, 'WA: restoreAll failed'));

  // Stage 64 phase 1 — approvals, questions and failures reach the owner's phone, and a
  // reply there answers them.
  startOwnerNotify();

  // Stage 64 phase 3 — which models can actually answer (provider lists + balances), so a
  // run never starts on a retired model or an unfunded account (services/model-router.ts).
  startModelHealth();

  const shutdown = async (signal: string) => {
    if (isDraining()) return; // a second signal while already draining
    logger.info({ signal }, 'Shutdown signal received — draining...');

    // 1. Stop all subsystems from picking up new work
    startDraining();
    stopIpcWatcher();
    stopFileEventWatcher();

    // 2. Drain the legacy group queue (runtime A)
    await queue.shutdown(8000);

    // 2b. Stage 64 phase 3 — let agent cycles in flight finish, up to DRAIN_MAX_MS. The HTTP
    // server keeps serving: a running cycle still calls back (model relay, check-ins). One
    // still running at the deadline is cut, and a run a person asked for resumes after boot.
    const executing = () =>
      agentService
        .getAllAgents()
        .filter((a) => agentService.isExecutingCycle(a.id)).length;
    const drained = await waitForIdle(
      executing,
      DRAIN_MAX_MS,
      2000,
      (running, waitedMs) =>
        logger.info(
          {
            running,
            waitedSec: Math.round(waitedMs / 1000),
            maxSec: Math.round(DRAIN_MAX_MS / 1000),
          },
          'Shutdown: waiting for agent cycles to finish',
        ),
    );
    logger.info(
      {
        remaining: drained.remaining,
        waitedSec: Math.round(drained.waitedMs / 1000),
      },
      drained.remaining
        ? 'Shutdown: drain deadline reached — remaining cycles will be resumed after restart'
        : 'Shutdown: all agent cycles finished',
    );

    // 3. Disconnect channels (WhatsApp, dashboard WebSocket, etc.)
    for (const ch of channels) {
      try {
        await ch.disconnect();
      } catch {
        /* non-fatal */
      }
    }

    // 4. Tear down warm daemon containers
    daemonPool.shutdown();

    // 5. Close the SQLite connection cleanly
    closeDatabase();

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // The residential proxy's password stays in this process; agent containers get this
  // gateway and a per-agent key instead (egress-gateway.ts). Off when no proxy is set.
  startEgressGateway();

  logger.info('Starting subsystems (IPC)...');
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) =>
      whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });

  startFileEventWatcher();

  queue.setProcessMessagesFn(processGroupMessages);
  logger.info('Message queue processor set');

  recoverPendingMessages();
  logger.info('Unprocessed message recovery complete');

  logger.info('Starting message loop...');
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

const directUrl = new URL(import.meta.url).pathname;
const argvUrl = process.argv[1]
  ? new URL(`file://${process.argv[1]}`).pathname
  : null;

if (argvUrl && directUrl === argvUrl) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoCrew');
    process.exit(1);
  });
}
