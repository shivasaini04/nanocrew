/**
 * Stage 30 — per-client WhatsApp sessions (multi-tenant "tag method").
 *
 * Each connected client gets their OWN Baileys socket + auth dir (store/wa/<ownerId>/).
 * Inbound messages are owner-scoped: `@AgentName` resolves ONLY within that owner's agents
 * (parseMentions(text, ownerId)), then runs the agent and replies on the same chat — using
 * the client's own number (Model A / linked-device). Strictly isolated per tenant.
 *
 * Distinct from the legacy single-session channel (whatsapp.ts), which stays as-is.
 */
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadContentFromMessage,
  areJidsSameUser,
  isPnUser,
  jidDecode,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';

import { STORE_DIR, PROJECTS_DIR, DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { parseMentions } from '../agents/mention-parser.js';
import { fenceThirdPartyRequest } from '../provenance.js';
import {
  isAgentWhatsAppDmEnabled,
  getAgentGroupBinding,
  getProjectAgents,
  getGroupBindingsByJid,
  getAgentWhatsAppDmBinding,
  getAgentsByOwner,
} from '../db.js';
import { agentService } from '../agents/agent-registry.js';
import { getSocketIO } from '../api/instances.js';
import { userRoom } from '../api/socket-scope.js';

export type WaState = 'connecting' | 'qr' | 'connected' | 'disconnected';

/**
 * Stage 64 phase 1 — a 1:1 message the owner-notify service may want: an answer to an
 * approval or question it sent. Offered before the @mention handling; when the handler says
 * it was an answer, the message stops here.
 */
export interface OwnerInbound {
  /** The user whose linked session received it. */
  sessionOwnerId: string;
  /** The other party's phone number (digits), when WhatsApp gave one. */
  phoneDigits: string | null;
  fromMe: boolean;
  /** The session's own "Message yourself" chat. */
  selfChat: boolean;
  text: string;
  /** Id of the message this one quotes (a swipe-reply), if any. */
  quotedId: string | null;
}
type OwnerInboundHandler = (m: OwnerInbound) => Promise<boolean>;
let ownerInboundHandler: OwnerInboundHandler | null = null;

/** Digits of the first phone-number JID among these (a chat may be addressed by LID). */
function phoneDigitsOf(
  ...jids: Array<string | null | undefined>
): string | null {
  for (const j of jids) {
    if (j && isPnUser(j)) return jidDecode(j)?.user ?? null;
  }
  return null;
}

function waDir(ownerId: string): string {
  return path.join(STORE_DIR, 'wa', ownerId);
}

/** One client's WhatsApp connection. */
class WhatsAppSession {
  state: WaState = 'connecting';
  number: string | null = null;
  private sock?: WASocket;
  private stopped = false;
  // IDs of messages WE sent (agent replies) — so we skip them on echo without skipping
  // the owner's OWN @mentions (self-chat messages are also fromMe).
  private sentIds = new Set<string>();
  private rateLimits = new Map<string, number[]>();

  constructor(public readonly ownerId: string) {}

  private isRateLimited(chatJid: string): boolean {
    const now = Date.now();
    const windowMs = 2 * 60 * 1000; // 2 minutes
    const maxRequests = 5;

    let timestamps = this.rateLimits.get(chatJid) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);
    if (timestamps.length >= maxRequests) {
      return true;
    }
    timestamps.push(now);
    this.rateLimits.set(chatJid, timestamps);
    return false;
  }

  private emit() {
    getSocketIO()?.to(userRoom(this.ownerId)).emit('whatsapp:state', {
      state: this.state,
      number: this.number,
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    const dir = waDir(this.ownerId);
    fs.mkdirSync(dir, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
      version: undefined,
    }));
    const silent = logger.child(
      { baileys: true, ownerId: this.ownerId },
      { level: 'silent' },
    );

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, silent),
      },
      printQRInTerminal: false,
      logger: silent,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.state = 'qr';
        try {
          const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 264 });
          getSocketIO()
            ?.to(userRoom(this.ownerId))
            .emit('whatsapp:qr', { qr: dataUrl });
        } catch (e) {
          logger.warn(
            { err: String(e), ownerId: this.ownerId },
            'WA: QR render failed',
          );
        }
        this.emit();
      }

      if (connection === 'open') {
        this.state = 'connected';
        this.number = this.sock?.user?.id?.split(':')[0]?.split('@')[0] ?? null;
        logger.info(
          { ownerId: this.ownerId, number: this.number },
          'WA session connected',
        );
        this.emit();
      }

      if (connection === 'close') {
        const code = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        // NEVER process.exit here (multi-session) — just this owner's session.
        if (loggedOut || this.stopped) {
          this.state = 'disconnected';
          this.emit();
        } else {
          this.state = 'connecting';
          this.emit();
          setTimeout(() => {
            if (!this.stopped) this.start().catch(() => {});
          }, 5000);
        }
      }
    });

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        try {
          if (!msg.message) continue;
          const chatJid = msg.key.remoteJid;
          if (!chatJid || chatJid === 'status@broadcast') continue;
          // Skip only OUR OWN agent replies (avoid loops). We do NOT skip all fromMe —
          // the owner messaging themselves (@agent in a self-chat) is also fromMe and must work.
          if (msg.key.id && this.sentIds.has(msg.key.id)) continue;

          const content =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            '';

          const isGroup = chatJid.endsWith('@g.us');

          // Stage 64 phase 1: an answer to something owner-notify sent (an approval, a
          // question). Only 1:1 chats — a group is never where those go.
          if (!isGroup && content && ownerInboundHandler) {
            const me = this.sock?.user;
            const phoneDigits = phoneDigitsOf(chatJid, msg.key.remoteJidAlt);
            // The self-chat can arrive addressed by phone number or by LID, and `user.lid`
            // is not always populated — so the phone number is checked as well.
            const selfChat =
              !!msg.key.fromMe &&
              !!me &&
              (areJidsSameUser(chatJid, me.id) ||
                (!!me.lid && areJidsSameUser(chatJid, me.lid)) ||
                (!!phoneDigits && phoneDigits === this.number));
            const handled = await ownerInboundHandler({
              sessionOwnerId: this.ownerId,
              phoneDigits,
              fromMe: !!msg.key.fromMe,
              selfChat,
              text: content,
              quotedId:
                msg.message.extendedTextMessage?.contextInfo?.stanzaId ?? null,
            }).catch((err) => {
              logger.warn(
                { err: String(err), ownerId: this.ownerId },
                'WA: owner-inbound handler failed',
              );
              return false;
            });
            if (handled) continue;
          }

          // Triggers collection
          const triggers: Array<{
            agentId: string;
            agentName: string;
            agentEmoji: string;
            task: string;
            projectId?: string;
          }> = [];

          // Provenance: in a group the sender is whoever typed, which is not
          // necessarily the account that linked this session. `fromMe` is the one
          // reliable signal that the owner themselves sent it.
          const isThirdParty = isGroup && !msg.key.fromMe;
          const senderLabel =
            msg.pushName || msg.key.participant || 'a group participant';
          let groupProjectId: string | undefined = undefined;
          let projectAgents: any[] = [];
          if (isGroup) {
            const bindings = getGroupBindingsByJid(chatJid, this.ownerId);
            const projectBinding = bindings.find(
              (b) => b.project_id && b.enabled,
            );
            if (projectBinding && projectBinding.project_id) {
              groupProjectId = projectBinding.project_id;
              projectAgents = getProjectAgents(groupProjectId);
            }
          }

          // OWNER-SCOPED: only this client's agents can be mentioned.
          const mentions = parseMentions(content, this.ownerId);
          if (mentions.length > 0) {
            for (const mention of mentions) {
              // Binding authorization (Stage 30 Phase 2):
              //  • Groups are default-DENY — an agent answers only where explicitly bound (Phase 3).
              //  • DMs/personal chats are default-ALLOW — the per-agent Channels toggle can disable it.
              let runProjectId: string | undefined = undefined;
              if (isGroup) {
                // If group is linked to a project, only agents assigned to the project can respond
                if (groupProjectId) {
                  if (!projectAgents.some((a) => a.id === mention.agentId)) {
                    continue; // Skip silently (Privacy & Security Guard)
                  }
                }
                const binding = getAgentGroupBinding(mention.agentId, chatJid);
                if (!binding) continue;
                if (binding.project_id) {
                  runProjectId = binding.project_id;
                }
              } else if (!isAgentWhatsAppDmEnabled(mention.agentId)) {
                continue;
              }
              triggers.push({
                agentId: mention.agentId,
                agentName: mention.agentName,
                agentEmoji: mention.agentEmoji || '🤖',
                task: mention.task,
                projectId: runProjectId,
              });
            }
          } else if (content) {
            // No explicit mentions. Check if any agents are bound to this chat with trigger_mode = 'all'
            if (isGroup) {
              const bindings = getGroupBindingsByJid(
                chatJid,
                this.ownerId,
              ).filter((b) => b.enabled && b.trigger_mode === 'all');
              for (const b of bindings) {
                // If the group is linked to a project, make sure the agent is in the project
                if (
                  groupProjectId &&
                  !projectAgents.some((a) => a.id === b.agent_id)
                ) {
                  continue;
                }
                const agent = agentService.getAgent(b.agent_id);
                if (agent && agent.status !== 'paused') {
                  triggers.push({
                    agentId: b.agent_id,
                    agentName: agent.name,
                    agentEmoji: agent.emoji || '🤖',
                    task: content,
                    projectId: b.project_id || undefined,
                  });
                }
              }
            } else {
              // DM check: find all DM bindings for this owner's agents where trigger_mode = 'all'
              const all = getAgentsByOwner(this.ownerId);
              for (const agent of all) {
                if (agent.status === 'paused') continue;
                const b = getAgentWhatsAppDmBinding(agent.id);
                if (b && b.enabled && b.trigger_mode === 'all') {
                  triggers.push({
                    agentId: agent.id,
                    agentName: agent.name,
                    agentEmoji: agent.emoji || '🤖',
                    task: content,
                    projectId: b.project_id || undefined,
                  });
                }
              }
            }
          }

          // Privacy & Security Guard: If no valid triggers are resolved, we discard the message immediately.
          // We do NOT log any user message content or process it further.
          if (triggers.length === 0) continue;

          // Loop & Cost Protection: sliding window rate limiter check
          if (this.isRateLimited(chatJid)) {
            logger.warn(
              { ownerId: this.ownerId, chatJid },
              'WA: rate limit exceeded, skipping message processing',
            );
            continue;
          }

          // Handle Image Download / Multi-modal attachment if present
          const imageMsg = msg.message.imageMessage;
          let fileContext: string | undefined = undefined;

          for (const t of triggers) {
            let currentFileContext: string | undefined = fileContext;

            if (imageMsg && !currentFileContext) {
              try {
                const stream = await downloadContentFromMessage(
                  imageMsg,
                  'image',
                );
                let buffer = Buffer.from([]);
                for await (const chunk of stream) {
                  buffer = Buffer.concat([buffer, chunk]);
                }

                // Determine directories
                const uploadDir = t.projectId
                  ? path.join(PROJECTS_DIR, t.projectId, 'workspace', 'uploads')
                  : path.join(
                      DATA_DIR,
                      'agents',
                      t.agentId,
                      'workspace',
                      'uploads',
                    );
                const cycleBase = t.projectId
                  ? '/workspace/shared/uploads'
                  : '/workspace/group/workspace/uploads';

                fs.mkdirSync(uploadDir, { recursive: true });
                const ext = imageMsg.mimetype === 'image/png' ? 'png' : 'jpg';
                const fname = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
                fs.writeFileSync(path.join(uploadDir, fname), buffer);

                const savedPath = `${cycleBase}/${fname}`;
                currentFileContext = `### 🖼️ Attached image\nThe user attached 1 image. Use the **read_image** tool on the path below to view it, then respond based on what you see:\n- \`${savedPath}\``;
                logger.info(
                  { chatJid, path: savedPath },
                  'WA: downloaded and saved message image',
                );
              } catch (err) {
                logger.warn(
                  { err: String(err), ownerId: this.ownerId },
                  'WA: failed to download image message',
                );
              }
            }

            logger.info(
              {
                ownerId: this.ownerId,
                chatJid,
                agent: t.agentName,
                thirdParty: isThirdParty,
              },
              'WA: dispatching trigger',
            );
            const replyFn = async (text: string) => {
              await this.sendMessage(chatJid, text);
            };
            // A group message can come from anyone in the group, not just the owner.
            // Fence it so a participant cannot issue instructions to someone else's
            // agent simply by tagging it — the request stays actionable, but as a
            // reported request rather than as the owner's own words.
            const task = isThirdParty
              ? fenceThirdPartyRequest(senderLabel, t.task)
              : t.task;
            const combinedPrompt = currentFileContext
              ? `${task}\n\n${currentFileContext}`
              : task;

            agentService
              .runCycle(
                t.agentId,
                'custom',
                combinedPrompt,
                t.projectId,
                replyFn,
                undefined,
                {
                  source: 'whatsapp',
                  userMessage: content,
                  humanRequested: true,
                },
              )
              .catch((err) =>
                logger.warn(
                  {
                    ownerId: this.ownerId,
                    agentId: t.agentId,
                    err: String(err?.message ?? err),
                  },
                  'WA cycle execution failed',
                ),
              );
          }
        } catch (e) {
          logger.warn(
            { err: String(e), ownerId: this.ownerId },
            'WA: inbound handler error',
          );
        }
      }
    });
  }

  /**
   * Send a message on this client's linked device. The agent identity header is added
   * upstream by agent-service (so the dashboard and WhatsApp stay consistent), so `text`
   * is sent verbatim here. `sender` is kept for direct/system sends that need a header.
   */
  async sendMessage(
    jid: string,
    text: string,
    sender?: { agentName: string; agentEmoji: string },
  ): Promise<string | null> {
    if (!this.sock || this.state !== 'connected') return null;
    const body = sender
      ? `${sender.agentEmoji} *${sender.agentName}*\n${text}`
      : text;
    try {
      const sent = await this.sock.sendMessage(jid, { text: body });
      const id = sent?.key?.id;
      if (id) {
        this.sentIds.add(id);
        if (this.sentIds.size > 300)
          this.sentIds = new Set([...this.sentIds].slice(-150)); // cap
      }
      return id ?? null;
    } catch (e) {
      logger.warn({ err: String(e), ownerId: this.ownerId }, 'WA: send failed');
      return null;
    }
  }

  async stop(wipe = false): Promise<void> {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {
      /* may already be gone */
    }
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.state = 'disconnected';
    if (wipe) {
      try {
        fs.rmSync(waDir(this.ownerId), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }

  async getGroups(): Promise<Array<{ jid: string; name: string }>> {
    if (!this.sock || this.state !== 'connected') {
      throw new Error('WhatsApp connection is not active');
    }
    const groups = await this.sock.groupFetchAllParticipating();
    return Object.values(groups).map((g) => ({
      jid: g.id,
      name: g.subject,
    }));
  }
}

class WhatsAppSessionManager {
  private sessions = new Map<string, WhatsAppSession>();

  /** Start (or restart) a client's session; QR + state are pushed over socket.io. */
  async connect(ownerId: string): Promise<void> {
    let s = this.sessions.get(ownerId);
    if (s) {
      if (s.state === 'connected') return;
      // If it was stuck in connecting/qr state, stop and wipe to allow a clean restart
      await s.stop(true);
      this.sessions.delete(ownerId);
    }
    s = new WhatsAppSession(ownerId);
    this.sessions.set(ownerId, s);
    await s.start();
  }

  /** Stage 64 phase 1: owner-notify's hook for answers arriving on any session. */
  setOwnerInboundHandler(fn: OwnerInboundHandler | null): void {
    ownerInboundHandler = fn;
  }

  /** Send from one owner's linked session. The sent message id, or null. */
  async send(
    ownerId: string,
    jid: string,
    text: string,
  ): Promise<string | null> {
    const s = this.sessions.get(ownerId);
    if (!s || s.state !== 'connected') return null;
    return s.sendMessage(jid, text);
  }

  status(ownerId: string): { state: WaState; number: string | null } {
    const s = this.sessions.get(ownerId);
    return s
      ? { state: s.state, number: s.number }
      : { state: 'disconnected', number: null };
  }

  async disconnect(ownerId: string): Promise<void> {
    const s = this.sessions.get(ownerId);
    if (s) await s.stop(true);
    this.sessions.delete(ownerId);
  }

  async getGroups(
    ownerId: string,
  ): Promise<Array<{ jid: string; name: string }>> {
    const s = this.sessions.get(ownerId);
    if (!s || s.state !== 'connected') {
      throw new Error('WhatsApp session not connected');
    }
    return s.getGroups();
  }

  /** On boot, restore sessions that already have saved creds (so clients stay linked). */
  async restoreAll(): Promise<void> {
    const base = path.join(STORE_DIR, 'wa');
    if (!fs.existsSync(base)) return;
    for (const ownerId of fs.readdirSync(base)) {
      if (fs.existsSync(path.join(base, ownerId, 'creds.json'))) {
        logger.info({ ownerId }, 'WA: restoring saved session');
        this.connect(ownerId).catch((err) =>
          logger.warn({ ownerId, err: String(err) }, 'WA restore failed'),
        );
      }
    }
  }
}

export const whatsAppSessions = new WhatsAppSessionManager();
