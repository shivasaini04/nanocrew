import { Server as SocketIOServer } from 'socket.io';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { logger } from '../logger.js';
import { randomUUID } from 'crypto';
import path from 'path';
import fs from 'fs';
import {
  storeMessageDirect,
  storeChatMetadata,
  getProject,
  getAgent,
  getProjectAgents,
  getLastCycleForProject,
} from '../db.js';
import {
  appendConversationEvent,
  appendChatMessageEvent,
} from '../conversation-events.js';
import { ASSISTANT_NAME, DATA_DIR, PROJECTS_DIR } from '../config.js';
import { parseMentions } from '../agents/mention-parser.js';
import { agentService, chatQueue } from '../agents/agent-registry.js';
import { startActivityWatcher } from '../session-activity-watcher.js';
import { handleProjectCommand } from '../project-command.js';
import { laneHintFromChoice } from '../agents/local-lane-routing.js';
import { localFollowups } from '../agents/local-followups.js';
import { browserBroker, derivePrincipal } from '../agents/browser-broker.js';

/**
 * Verbs that mean "do something", as opposed to "tell me something". Their presence
 * routes the turn down the full task path, which carries the plan-first / verification /
 * platform-conventions framing that conversational mode strips out.
 */
const WORK_VERBS = [
  'draft',
  'write',
  'create',
  'build',
  'make',
  'generate',
  'update',
  'add',
  'remove',
  'delete',
  'fix',
  'run',
  'send',
  'email',
  'post',
  'edit',
  'rename',
  'refactor',
  'install',
  'configure',
  'set up',
  'deploy',
  'schedule',
  'track',
  'monitor',
  'search',
  'find',
  'research',
  'look up',
  'check',
  'review',
  'analyz',
  'analys',
  'scrape',
  'crawl',
  'compile',
  'gather',
  'collect',
  'summarize',
  'summarise',
  'test',
  'audit',
  'compare',
  'extract',
  'download',
  'read ',
  'open ',
  'save',
];

/**
 * Should this chat turn use the conversational prompt (a natural reply) rather than the
 * task-cycle prompt (a work report)?
 *
 * The light/heavy router that used to make this call was deleted along with the
 * in-process runtime, which left `conversational` declared but never set — so every
 * "thanks" and "what did you find?" has been prompted as a task cycle and answered with
 * a work report. This is a deliberately timid replacement: it only ever *adds*
 * conversational mode, and returns false whenever it is unsure, so anything it declines
 * behaves exactly as it does today.
 *
 * Both hard exclusions matter: the conversational prompt drops project context entirely,
 * and a message carrying #file references is by definition about doing something with
 * those files.
 */
export function isConversationalTurn(
  message: string,
  ctx: { hasProject: boolean; hasFiles: boolean },
): boolean {
  if (ctx.hasProject || ctx.hasFiles) return false;
  const text = message.trim();
  if (!text) return false;
  if (text.split(/\s+/).length > 25) return false;
  const lower = text.toLowerCase();
  return !WORK_VERBS.some((v) => lower.includes(v));
}

export interface DashboardChannelOpts {
  io: SocketIOServer;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  /** Registers an in-memory group so the orchestrator loop polls a newly created project chat. */
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

export class DashboardChannel implements Channel {
  name = 'dashboard';
  private io: SocketIOServer;
  private onMessageCbk: OnInboundMessage;
  private onChatMetadataCbk: OnChatMetadata;
  private registerGroup: (jid: string, group: RegisteredGroup) => void;

  constructor(opts: DashboardChannelOpts) {
    this.io = opts.io;
    this.onMessageCbk = opts.onMessage;
    this.onChatMetadataCbk = opts.onChatMetadata;
    this.registerGroup = opts.registerGroup;
  }

  async connect(): Promise<void> {
    logger.info('DashboardChannel connected via Socket.IO');

    this.io.on('connection', (socket) => {
      // Fallback label for the generic (non-agent, non-project) routing path below —
      // reachable today only via the project-lookup-fails edge case (a stale tab
      // pointing at a deleted project). The standalone "Dashboard Chat" thread this
      // used to label was removed: nothing in the dashboard ever sent to it.
      const defaultName = 'Dashboard Chat';

      // Handle incoming messages from the dashboard UI
      socket.on(
        'chat:send',
        async (data: {
          chatJid: string;
          message: string;
          clientId?: string;
          projectId?: string;
          image?: string;
          images?: string[];
          browser?: string;
        }) => {
          try {
            const { chatJid, clientId, projectId } = data;
            // Stage 60 phase 1: the browser picker under the message box. The
            // operator decides per message — their own browser or the cloud's.
            const laneHint = laneHintFromChoice(data.browser);
            // Accept one or many images (back-compat with the single `image` field).
            const images = [
              ...(Array.isArray(data.images) ? data.images : []),
              ...(data.image ? [data.image] : []),
            ].filter(
              (s): s is string =>
                typeof s === 'string' && s.startsWith('data:image/'),
            );
            const message =
              data.message && data.message.trim()
                ? data.message
                : images.length
                  ? `I attached ${images.length === 1 ? 'an image' : `${images.length} images`} — please look and respond.`
                  : '';
            if (!message.trim() && images.length === 0) return;

            const msgId = `dash_msg_${randomUUID()}`;
            const timestamp = new Date().toISOString();

            // Resolve chat name: project JIDs use their project name,
            // agent JIDs use the agent's name.
            const chatName = chatJid.startsWith('project:')
              ? (getProject(chatJid.replace('project:', ''))?.name ??
                'Project Chat')
              : chatJid.startsWith('agent:')
                ? (agentService.getAgent(chatJid.slice('agent:'.length))
                    ?.name ?? 'Agent Chat')
                : defaultName;

            // Ensure the chat row exists before inserting a message (FK guard)
            storeChatMetadata(chatJid, timestamp, chatName, this.name, false);

            // 1. Store the user's message directly in the DB
            const userMsg = {
              id: msgId,
              chat_jid: chatJid,
              sender: 'User',
              sender_name: 'User',
              content: message,
              timestamp,
              is_from_me: true,
            };
            storeMessageDirect(userMsg);
            // Stage 35: the human's turn belongs in the conversation log too. This
            // is the one producer that writes a message straight to the DB rather
            // than through agent-service's emitters, so it had to be wired up
            // explicitly — without it the log holds every agent turn and none of
            // the prompts they were answering.
            appendConversationEvent(chatJid, {
              type: 'user_msg',
              role: 'user',
              content: message,
              status: 'ok',
              metadata: JSON.stringify({
                source: 'dashboard',
                legacy_msg_id: msgId,
              }),
            });

            // 2. Echo clientId back so the frontend can match its temp timer
            socket.emit('chat:ack', { id: clientId ?? msgId, timestamp });

            // 3. Resolve any #file references and build extraContext block
            let fileContext: string | undefined;
            // For project chats, auto-prefix bare filenames with "shared/" so
            // #notes.md (inserted by the autocomplete) resolves to the project workspace.
            const isProjectChat = chatJid.startsWith('project:');
            const fileRefs = [...message.matchAll(/#([\w\-./]+)/g)]
              .map((m) =>
                isProjectChat && !m[1].includes('/') ? `shared/${m[1]}` : m[1],
              )
              .filter((r) => r.includes('/'));
            if (fileRefs.length > 0) {
              try {
                const res = await fetch(
                  `http://localhost:${process.env.PORT ?? 3002}/api/files/resolve-refs`,
                  {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refs: fileRefs, chatJid }),
                  },
                );
                if (res.ok) {
                  const { resolved } = (await res.json()) as {
                    resolved: Array<{
                      ref: string;
                      label: string;
                      content: string;
                    }>;
                  };
                  if (resolved.length > 0) {
                    fileContext = resolved
                      .map((r) => {
                        const shown = r.content.slice(0, 8000);
                        // Same silent-cap gap as AgentProfilePage's client-side resolver —
                        // without a notice, the agent has no way to know it's looking at
                        // a partial file (found 2026-08-17).
                        const notice =
                          r.content.length > 8000
                            ? `\n_(truncated — showing the first 8000 of ${r.content.length} characters; use read_file to see the rest)_`
                            : '';
                        return `### 📎 File: ${r.label}\n\`\`\`\n${shown}\n\`\`\`${notice}`;
                      })
                      .join('\n\n');
                    logger.info(
                      { chatJid, refs: resolved.map((r) => r.ref) },
                      'File refs resolved and injected',
                    );
                  }
                }
              } catch (err) {
                logger.warn(
                  { err },
                  'Failed to resolve file refs — proceeding without file context',
                );
              }
            }

            // 3.6 Image attachments (paste/upload): save each into the chat's workspace and
            // instruct the agent to read_image them. Vision is wired to a multimodal model
            // (see loop.py), so the agent can actually see the pasted images.
            if (images.length) {
              try {
                const isProjChat = chatJid.startsWith('project:');
                const hostDir = isProjChat
                  ? path.join(
                      PROJECTS_DIR,
                      chatJid.slice('project:'.length),
                      'workspace',
                      'uploads',
                    )
                  : path.join(
                      DATA_DIR,
                      'agents',
                      chatJid.slice('agent:'.length),
                      'workspace',
                      'uploads',
                    );
                const cycleBase = isProjChat
                  ? '/workspace/shared/uploads'
                  : '/workspace/group/workspace/uploads';
                fs.mkdirSync(hostDir, { recursive: true });
                const savedPaths: string[] = [];
                images.forEach((img, idx) => {
                  const m = img.match(/^data:image\/(\w+);base64,(.+)$/);
                  if (!m) return;
                  const ext =
                    m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
                  const fname = `pasted_${Date.now()}_${idx}.${ext}`;
                  fs.writeFileSync(
                    path.join(hostDir, fname),
                    Buffer.from(m[2], 'base64'),
                  );
                  savedPaths.push(`${cycleBase}/${fname}`);
                });
                if (savedPaths.length) {
                  const list = savedPaths.map((p) => `- \`${p}\``).join('\n');
                  const imgNote = `### 🖼️ Attached image${savedPaths.length > 1 ? 's' : ''}\nThe user attached ${savedPaths.length} image${savedPaths.length > 1 ? 's' : ''}. Use the **read_image** tool on EACH path below to view ${savedPaths.length > 1 ? 'them' : 'it'}, then respond based on what you see:\n${list}`;
                  fileContext = fileContext
                    ? `${fileContext}\n\n${imgNote}`
                    : imgNote;
                  logger.info(
                    { chatJid, count: savedPaths.length },
                    'Chat images saved + read_image instructions injected',
                  );
                }
              } catch (err) {
                logger.warn({ err }, 'Failed to handle chat image attachments');
              }
            }

            // 3.5 Per-agent conversation (agent:<id>): the whole thread is scoped
            // to one agent. Route the message as a task to that agent's real
            // (nanobot) cycle and stream the result back into this thread.
            // Stage 20, Phase 0 — the chat_jid spine.
            if (chatJid.startsWith('agent:')) {
              const trimmed = message.trim();

              // Orchestrator commands work in the agent chat too, so the Assistant
              // "Nano" chat is a real command center. Handle them before the cycle
              // so they don't get routed to the agent as a plain task.
              if (trimmed.toLowerCase().startsWith('/project')) {
                await handleProjectCommand(chatJid, trimmed, {
                  sendMessage: (jid, text) => this.sendMessage(jid, text),
                  emitProjectContextSet: (p) =>
                    this.io.emit('project:context:set', p),
                  emitProjectOpened: (p) => this.io.emit('project:opened', p),
                  registerGroup: this.registerGroup,
                });
                return;
              }
              // Stage 57: /job is not coming back (phase 5, founder's call) — agents delegate on their own.
              if (trimmed.toLowerCase().startsWith('/job')) {
                await this.sendMessage(
                  chatJid,
                  `_There's no /job any more — just ask. An agent splits big work across parallel workers on its own, you can keep chatting while it works, and you can watch its runs under **Runs** in the sidebar._`,
                );
                return;
              }

              const agentId = chatJid.slice('agent:'.length);
              const agent = agentService.getAgent(agentId);
              if (!agent) {
                await this.sendMessage(chatJid, `_Agent not found._`);
                return;
              }
              // @mention inside an agent chat = hand off to that agent; the reply
              // streams back into THIS thread (doc 11). Stage 20.
              const agentMentions = parseMentions(message);
              if (agentMentions.length > 0) {
                for (const mention of agentMentions) {
                  await this.sendMessage(
                    chatJid,
                    `_Handing off to ${mention.agentEmoji} ${mention.agentName}…_`,
                  );
                  const mReplyFn = (text: string) =>
                    this.streamReply(chatJid, text, {
                      name: mention.agentName,
                      emoji: mention.agentEmoji,
                    });
                  this.runOrQueue(
                    chatJid,
                    { id: mention.agentId, name: mention.agentName },
                    mention.task,
                    () => {
                      const mAct = path.join(
                        DATA_DIR,
                        'agents',
                        mention.agentId,
                        'activity.json',
                      );
                      const mStop = startActivityWatcher(
                        this.io,
                        mAct,
                        chatJid,
                      );
                      return agentService
                        .runCycle(
                          mention.agentId,
                          'custom',
                          mention.task,
                          undefined,
                          mReplyFn,
                        )
                        .catch((err) => {
                          if (
                            /already running/i.test(String(err?.message ?? err))
                          )
                            throw err;
                          logger.warn(
                            {
                              agentId: mention.agentId,
                              err: String(err?.message ?? err),
                            },
                            'Agent-chat handoff failed',
                          );
                          this.sendMessage(
                            chatJid,
                            `_Handoff failed: ${String(err?.message ?? err)}_`,
                          );
                        })
                        .finally(() => mStop());
                    },
                  );
                }
                return;
              }

              const task = fileContext
                ? `${message}\n\n## Referenced Files\n\n${fileContext}`
                : message;

              // Stage 60 phase 6: "This computer" chosen, and the computer isn't
              // there. Keep the request and run it the moment the desktop app
              // connects, instead of answering "not connected" and losing it.
              if (laneHint === 'local') {
                const ownerId = (agent as { owner_id?: string | null })
                  .owner_id;
                const principal = ownerId ? derivePrincipal(ownerId) : '';
                if (
                  principal &&
                  browserBroker.onlineControllersFor(principal).length === 0
                ) {
                  localFollowups.add({
                    agentId,
                    principal,
                    task,
                    source: 'chat',
                    projectId: projectId || undefined,
                  });
                  await this.sendMessage(
                    chatJid,
                    "_Your computer isn't connected, so I've saved this and will start the moment the NanoCrew desktop app connects (within 24 hours). To run it now without your computer, switch the picker under the message box to **Cloud** and send it again._",
                  );
                  return;
                }
              }

              // Single grounded runtime: EVERY message runs a nanobot cycle.
              // The old light in-process runtime was removed — it had no real
              // tools and would confabulate (invent facts) on anything it
              // couldn't actually do. The warm daemon + deferred tools keep the
              // cycle fast enough that one runtime serves all messages.
              // Unified path: runCycle streams its own working-timeline + result
              // into this thread (chatJid === agent:<id>). It emits a (UI-hidden)
              // start marker, a live activity watcher, and the cyc-<id>-result
              // message that the chat hydrates into the inline timeline with its
              // persisted trace. Doing our own replyFn/watcher here would both
              // double-emit AND leave the result untagged (→ no trace → bubble).
              // projectId (from the chat project picker) → the cycle runs in that
              // project's shared workspace instead of the agent's private one.
              // A busy agent's message waits its turn — it used to get "Still working on
              // the previous request" and be dropped (stage 57 phase 5, chat-queue.ts).
              // Other failures surface as runCycle's own "⚠️ Cycle failed" message.
              this.runOrQueue(chatJid, agent, trimmed, () =>
                agentService.runCycle(
                  agentId,
                  'custom',
                  task,
                  projectId || undefined,
                  undefined,
                  undefined,
                  {
                    // A person typed this, so the source tools' what/when gates
                    // (rotation, cooldowns, write/contact gates) yield to them.
                    humanRequested: true,
                    laneHint,
                    conversational: isConversationalTurn(message, {
                      hasProject: !!projectId,
                      hasFiles: !!fileContext,
                    }),
                  },
                ),
              );
              return;
            }

            // 4. Check for @AgentName mentions — dispatch directly to those agents.
            // Project chats are skipped here: their @mention routing happens in step 5a
            // so the agent receives the correct projectId and runs in the project workspace.
            const mentions = parseMentions(message);
            if (mentions.length > 0 && !isProjectChat) {
              logger.info(
                { chatJid, mentions: mentions.map((m) => m.agentName) },
                'Dispatching @ mentions',
              );
              for (const mention of mentions) {
                await this.sendMessage(
                  chatJid,
                  `_Dispatching to ${mention.agentEmoji} ${mention.agentName}..._`,
                );
                const taskWithFiles = fileContext
                  ? `${mention.task}\n\n## Referenced Files\n\n${fileContext}`
                  : mention.task;
                const replyFn = (text: string) =>
                  this.sendMessage(chatJid, text, {
                    name: mention.agentName,
                    emoji: mention.agentEmoji,
                  });
                this.runOrQueue(
                  chatJid,
                  { id: mention.agentId, name: mention.agentName },
                  mention.task,
                  () =>
                    agentService.runCycle(
                      mention.agentId,
                      'custom',
                      taskWithFiles,
                      undefined,
                      replyFn,
                    ),
                  null,
                );
              }
              // Strip each mention's task text, then strip @Name tokens.
              // The old regex used \s in the char class which consumed task words,
              // leaving garbage residue that made every mention message fall through to the orchestrator.
              let remaining = message;
              for (const mention of mentions) {
                const idx = remaining.indexOf(mention.task);
                if (idx !== -1)
                  remaining =
                    remaining.slice(0, idx) +
                    remaining.slice(idx + mention.task.length);
              }
              const nonMentionText = remaining
                .replace(/@[\w][\w\-]*(?:\s[\w\-]+){0,3}/g, '')
                .trim();
              if (!nonMentionText) return;
            }

            // 5a. Project chat — @all broadcast, @agent routing, or lead-agent routing
            if (chatJid.startsWith('project:')) {
              const proj = getProject(chatJid.replace('project:', ''));
              if (proj) {
                const task = fileContext
                  ? `${message}\n\n## Referenced Files\n\n${fileContext}`
                  : message;

                // Stage 57: /job is not coming back (phase 5, founder's call) — agents delegate on their own.
                if (message.trim().toLowerCase().startsWith('/job')) {
                  await this.sendMessage(
                    chatJid,
                    `_There's no /job any more — just ask. An agent splits big work across parallel workers on its own, you can keep chatting while it works, and you can watch its runs under **Runs** in the sidebar._`,
                  );
                  return;
                }

                // @all broadcast — dispatch to every assigned agent
                if (/^@all\b/i.test(message.trim())) {
                  const broadcastTask = task.replace(/^@all\s*/i, '');
                  const projAgents = getProjectAgents(proj.id);
                  for (const pa of projAgents) {
                    this.runOrQueue(
                      chatJid,
                      pa,
                      broadcastTask,
                      () =>
                        agentService.runCycle(
                          pa.id,
                          'custom',
                          broadcastTask,
                          proj.id,
                          undefined,
                          undefined,
                          { chatJid, laneHint },
                        ),
                      null,
                    );
                  }
                  if (projAgents.length > 0) return;
                }

                // @agentname — fuzzy-resolve via parseMentions, then filter to project agents
                const parsedMentions = parseMentions(message);
                if (parsedMentions.length > 0) {
                  const projAgents = getProjectAgents(proj.id);
                  const projAgentIds = new Set(projAgents.map((a) => a.id));
                  const projectMentions = parsedMentions.filter((m) =>
                    projAgentIds.has(m.agentId),
                  );
                  const outsideMentions = parsedMentions.filter(
                    (m) => !projAgentIds.has(m.agentId),
                  );

                  if (projectMentions.length > 0) {
                    for (const mention of projectMentions) {
                      const pa = projAgents.find(
                        (a) => a.id === mention.agentId,
                      )!;
                      const taskWithFiles = fileContext
                        ? `${mention.task}\n\n## Referenced Files\n\n${fileContext}`
                        : mention.task;
                      this.runOrQueue(
                        chatJid,
                        pa,
                        mention.task,
                        () =>
                          agentService.runCycle(
                            pa.id,
                            'custom',
                            taskWithFiles,
                            proj.id,
                            undefined,
                            undefined,
                            { chatJid, laneHint },
                          ),
                        { name: pa.name, emoji: pa.emoji },
                      );
                    }
                    return;
                  }
                  if (outsideMentions.length > 0) {
                    const names = outsideMentions
                      .map((m) => `${m.agentEmoji} ${m.agentName}`)
                      .join(', ');
                    await this.sendMessage(
                      chatJid,
                      `_${names} is not assigned to this project. Add them via **Manage → Team**._`,
                    );
                    return;
                  }
                }

                // Continuation routing: "continue"/"retry"/etc. → last-active agent
                const CONTINUE_RE =
                  /^\s*(continue|go on|retry|resume|keep going|proceed|carry on)\s*[.!]?\s*$/i;
                if (CONTINUE_RE.test(message.trim())) {
                  const lastCycle = getLastCycleForProject(proj.id);
                  if (
                    lastCycle &&
                    (lastCycle.status === 'interrupted' ||
                      lastCycle.status === 'failed')
                  ) {
                    const lastAgent = getAgent(lastCycle.agent_id);
                    if (lastAgent && lastAgent.id !== proj.lead_agent_id) {
                      const resumeTask = lastCycle.resume_hint ?? task;
                      await this.sendMessage(
                        chatJid,
                        `_↩️ Resuming ${lastAgent.emoji} ${lastAgent.name}'s interrupted task…_`,
                      );
                      this.runOrQueue(
                        chatJid,
                        lastAgent,
                        'resume',
                        () =>
                          agentService.runCycle(
                            lastAgent.id,
                            'custom',
                            resumeTask,
                            proj.id,
                            undefined,
                            undefined,
                            { chatJid, laneHint },
                          ),
                        { name: lastAgent.name, emoji: lastAgent.emoji },
                      );
                      return;
                    }
                  }
                }

                // Default: route to lead agent
                const leadAgent = proj.lead_agent_id
                  ? getAgent(proj.lead_agent_id)
                  : null;
                if (leadAgent) {
                  this.runOrQueue(
                    chatJid,
                    leadAgent,
                    message.trim(),
                    () =>
                      agentService.runCycle(
                        leadAgent.id,
                        'custom',
                        task,
                        proj.id,
                        undefined,
                        undefined,
                        { chatJid, laneHint },
                      ),
                    { name: leadAgent.name, emoji: leadAgent.emoji },
                  );
                  return;
                }
                // No lead and no matching @mention — tell the user rather than silently leaking to the orchestrator
                await this.sendMessage(
                  chatJid,
                  `_No lead agent assigned. Use \`@AgentName task\` to route to a specific agent, or assign a lead via **Manage → Team**._`,
                );
                return;
              }
            }

            // 5. Trigger the main orchestrator pipeline (for non-mention or mixed messages)
            // Attach resolved file content to the message passed downstream
            const msgWithFiles = fileContext
              ? {
                  ...userMsg,
                  content: `${message}\n\n## Referenced Files\n\n${fileContext}`,
                }
              : userMsg;
            logger.info(
              { chatJid, message },
              'Dashboard channel received message',
            );
            await this.onMessageCbk(chatJid, msgWithFiles as any);
          } catch (error) {
            logger.error({ error }, 'Error handling dashboard chat:send event');
          }
        },
      );
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    sender?: { name: string; emoji?: string },
  ): Promise<void> {
    if (!text.trim()) return;

    const msgId = `dash_msg_${randomUUID()}`;
    const timestamp = new Date().toISOString();

    // Resolve sender display name
    const senderName = sender
      ? `${sender.emoji ?? '🤖'} ${sender.name}`
      : ASSISTANT_NAME;

    // Resolve chat name: project JIDs use their project name,
    // agent JIDs use the agent's name.
    const chatName = jid.startsWith('project:')
      ? (getProject(jid.replace('project:', ''))?.name ?? 'Project Chat')
      : jid.startsWith('agent:')
        ? (agentService.getAgent(jid.slice('agent:'.length))?.name ??
          'Agent Chat')
        : 'Dashboard Chat';

    // Ensure the chat row exists before inserting (FK guard)
    storeChatMetadata(jid, timestamp, chatName, this.name, false);

    // 1. Store the bot's response in the DB
    storeMessageDirect({
      id: msgId,
      chat_jid: jid,
      sender: senderName,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });
    appendChatMessageEvent(jid, {
      content: text,
      sender: senderName,
      source: 'dashboard',
      legacyMsgId: msgId,
    });
    // 2. Broadcast the message to all connected dashboard clients
    this.io.emit('chat:message', {
      id: msgId,
      chatJid: jid,
      text,
      timestamp,
      sender: senderName,
    });
  }

  // Stage 20 gap D — emit a reply with a fast progressive "type-out".
  // The nanobot produces replies whole (no real token stream), so we reveal the
  // completed text over ~0.7s for an alive feel. Persistence happens once with the
  // full text; the growing emits share one message id (frontend upserts by id).
  private async streamReply(
    jid: string,
    text: string,
    sender?: { name: string; emoji?: string },
  ): Promise<void> {
    const full = text.trim();
    if (!full) return;

    const msgId = `dash_msg_${randomUUID()}`;
    const timestamp = new Date().toISOString();
    const senderName = sender
      ? `${sender.emoji ?? '🤖'} ${sender.name}`
      : ASSISTANT_NAME;
    const chatName = jid.startsWith('project:')
      ? (getProject(jid.replace('project:', ''))?.name ?? 'Project Chat')
      : jid.startsWith('agent:')
        ? (agentService.getAgent(jid.slice('agent:'.length))?.name ??
          'Agent Chat')
        : 'Dashboard Chat';

    // Persist the full message once (history is authoritative even mid-stream).
    storeChatMetadata(jid, timestamp, chatName, this.name, false);
    storeMessageDirect({
      id: msgId,
      chat_jid: jid,
      sender: senderName,
      sender_name: senderName,
      content: full,
      timestamp,
      is_from_me: false,
      is_bot_message: true,
    });
    appendChatMessageEvent(jid, {
      content: full,
      sender: senderName,
      source: 'dashboard',
      legacyMsgId: msgId,
    });

    // Progressive reveal — ~20 frames, ~35ms each → ~0.7s total, regardless of length.
    const tokens = full.split(/(\s+)/); // keep whitespace tokens
    const frames = Math.min(20, Math.max(1, tokens.length));
    const step = Math.ceil(tokens.length / frames);
    let shown = '';
    for (let i = 0; i < tokens.length; i++) {
      shown += tokens[i];
      if (i % step === 0) {
        this.io.emit('chat:message', {
          id: msgId,
          chatJid: jid,
          text: shown,
          timestamp,
          sender: senderName,
        });
        await new Promise((r) => setTimeout(r, 35));
      }
    }
    // Final full emit (ensures the complete text is shown).
    this.io.emit('chat:message', {
      id: msgId,
      chatJid: jid,
      text: full,
      timestamp,
      sender: senderName,
    });
  }

  isConnected(): boolean {
    return true; // Socket.IO handles dynamic connections, channel itself is always "ready"
  }

  ownsJid(jid: string): boolean {
    return (
      jid.startsWith('dash:') ||
      jid.startsWith('project:') ||
      jid.startsWith('agent:')
    );
  }

  async disconnect(): Promise<void> {
    logger.info('DashboardChannel disconnected');
  }

  /**
   * Start an agent's turn now, or queue it behind the turn in flight — never drop it.
   *
   * A busy agent refuses a second turn, and every chat path used to answer that with a
   * notice or a log line and lose the message (chat-queue.ts). `typingAs` is who the typing
   * indicator shows: undefined for the thread's own agent, null for none.
   */
  private runOrQueue(
    chatJid: string,
    agent: { id: string; name: string },
    label: string,
    run: () => Promise<unknown>,
    typingAs?: { name: string; emoji?: string } | null,
  ): void {
    const start = (): Promise<unknown> => {
      if (typingAs !== null) void this.setTyping(chatJid, true, typingAs);
      return run().finally(() => {
        if (typingAs !== null) void this.setTyping(chatJid, false);
      });
    };
    const queue = (): void => {
      const r = chatQueue.enqueue({
        agentId: agent.id,
        label: label.slice(0, 80),
        start,
      });
      void this.sendMessage(
        chatJid,
        r.ok
          ? `_Queued — ${agent.name} is still on an earlier request and will start this as soon as it's done${r.position > 1 ? ` (${r.position - 1} ahead of it)` : ''}._`
          : `_Not queued: ${r.reason}. Send it again once ${agent.name} has caught up._`,
      );
    };
    if (chatQueue.mustWait(agent.id)) {
      queue();
      return;
    }
    start().catch((err) => {
      const m = String(err?.message ?? err);
      if (/already running/i.test(m))
        queue(); // lost the race for the slot
      else logger.warn({ agentId: agent.id, err: m }, 'Chat turn failed');
    });
  }

  async setTyping(
    jid: string,
    isTyping: boolean,
    agentInfo?: { name: string; emoji?: string },
  ): Promise<void> {
    this.io.emit('chat:typing', {
      chatJid: jid,
      isTyping,
      agentName: agentInfo?.name,
      agentEmoji: agentInfo?.emoji,
    });
  }
}
