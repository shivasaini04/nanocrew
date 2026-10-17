/**
 * Conversation event stream — the single write path (Stage 35).
 *
 * Everything that happens in a conversation — a user turn, an agent reply,
 * thinking, a tool call, a tool result, a file change, an error — is appended
 * here as one row in one ordered log, and broadcast as one socket event.
 *
 * Why this exists: conversational state used to be written to three tables
 * (`messages`, `cycle_steps`, `agent_file_events`) by several independent
 * producers, with no ordering key in common and no rule that a producer must
 * write anything at all. So a cycle whose LLM call failed wrote *nothing* the UI
 * read, and the chat pane just kept showing the previous reply — a failure that
 * looked exactly like the agent repeating itself (the launch-day Recruiter
 * incident, which cost hours of misdirected debugging).
 *
 * The invariant this module exists to enforce: **nothing writes conversational
 * state except through appendConversationEvent.** Given that, "something
 * happened but the log doesn't show it" is not a bug to be fixed but a state
 * that cannot be represented — every producer, on every path including every
 * error path, appends an event or there was no event.
 *
 * Phase 0 status: producers dual-write here alongside their existing writes to
 * the legacy tables. Nothing reads this stream yet, so a bug here cannot affect
 * users — that's the point of the phase. Legacy tables stay authoritative until
 * the read path switches over (Phase 2).
 */
import { getSocketIO } from './api/instances.js';
import { insertConversationEvent } from './db.js';
import { logger } from './logger.js';
import type { ConversationEvent, NewConversationEvent } from './types.js';

/**
 * Append one event to a conversation's log and broadcast it.
 *
 * @param conversation JID — `agent:<id>` or `project:<id>`
 * @param ev           the event; `type` is required, the rest are per-type
 * @param id           optional idempotency key for producers that may replay the
 *                     same logical event (see insertConversationEvent)
 * @returns the persisted event (with its allocated `seq`), or null if the append
 *          failed — callers dual-writing during Phase 0 ignore the return.
 */
/**
 * Mirror a plain chat message — one with no cycle context — into the log.
 *
 * For the several producers that write a message straight to `messages` via
 * storeMessageDirect (welcome messages, job results, sidecar/system notices, the
 * dashboard channel's own sends). They carry no cycle, no tool trace and no
 * kind, so they need none of _emitCycleChat's metadata; they just have to be in
 * the log, because a conversation missing half its messages is exactly the
 * fragmentation this stream exists to end.
 *
 * Only agent:/project: threads are conversations in this sense — WhatsApp/group
 * JIDs also flow through storeMessageDirect and are deliberately not mirrored.
 */
export function appendChatMessageEvent(
  chatJid: string,
  opts: {
    content: string;
    fromUser?: boolean;
    sender?: string;
    source?: string;
    legacyMsgId?: string;
  },
): ConversationEvent | null {
  if (!chatJid.startsWith('agent:') && !chatJid.startsWith('project:'))
    return null;
  if (!opts.content?.trim()) return null;
  return appendConversationEvent(chatJid, {
    type: opts.fromUser ? 'user_msg' : 'agent_msg',
    role: opts.fromUser ? 'user' : 'assistant',
    content: opts.content,
    status: 'ok',
    metadata: JSON.stringify({
      source: opts.source,
      sender: opts.sender,
      legacy_msg_id: opts.legacyMsgId,
    }),
  });
}

export function appendConversationEvent(
  conversation: string,
  ev: NewConversationEvent,
  id?: string,
): ConversationEvent | null {
  try {
    const saved = insertConversationEvent(conversation, ev, id);
    getSocketIO()?.emit('conversation:event', saved);
    return saved;
  } catch (err) {
    // Never let the new stream break the caller. During Phase 0 the legacy write
    // is what users actually see, so a failure here must stay invisible to them
    // and loud in the logs. This try/catch gets narrower once this stream becomes
    // the source of truth and a dropped event is a real user-visible loss.
    logger.error(
      { err, conversation, type: ev.type },
      'appendConversationEvent failed',
    );
    return null;
  }
}
