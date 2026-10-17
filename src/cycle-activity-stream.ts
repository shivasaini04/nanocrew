/**
 * Cycle activity stream — Phase 2 of the activity rework.
 *
 * Replaces the file-poll transport (session-activity-watcher) for agent cycles.
 * The nanobot adapter PUSHes a *window* of the current activity-steps array to the
 * orchestrator (POST /api/agents/:id/cycles/:cycleId/steps, body: { startSeq, steps
 * }) as the cycle runs; this module:
 *   1. persists only the *new/changed* steps into the DB (cycle_steps — durable
 *      source of truth), and
 *   2. emits only the *new/changed* steps as `chat:activity` socket events, in real time.
 *
 * `startSeq` is the real sequence number `steps[0]` corresponds to — the adapter
 * only sends a bounded recent window (see nanocrew_adapter.py's _PUSH_WINDOW), not
 * the full cumulative array, so array index alone can't be used as the step's
 * sequence number the way it could when the adapter always sent everything from
 * index 0. (Older adapter images that still send the full array from the
 * beginning just get startSeq=0, which is the same thing.)
 *
 * We diff against what we already emitted/persisted per cycle so both the UI and
 * the DB write only the delta. Two compounding O(cycle_length^2) costs existed
 * here before this and the DB-side fix: full delete+reinsert on every push (DB
 * side, fixed by switching to upsertCycleSteps — see db.ts), and re-transmitting +
 * re-parsing the *entire* cumulative steps array (including full tool input/output
 * content) on every single push (wire side, fixed by the adapter's push window).
 * A real 900+ step research cycle made the wire-side cost the dominant one and
 * was confirmed as the trigger for a V8 heap-exhaustion crash that took down the
 * whole orchestrator process, not just that one agent's session.
 */
import { getSocketIO } from './api/instances.js';
import { upsertCycleSteps, type CycleStep } from './db.js';
import { appendConversationEvent } from './conversation-events.js';
import { logger } from './logger.js';

interface EmitState {
  emittedCount: number; // how many steps we've already announced
  resultsEmitted: Set<number>; // tool_call seqs whose output we've already streamed
}

const state = new Map<string, EmitState>();

// Per-cycle: which chatJid to emit to. Defaults to agent:{agentId} but can be
// overridden to a project JID so project-chat cycles get the full live timeline.
const cycleJid = new Map<string, string>();

function chatJidFor(agentId: string, cycleId?: string): string {
  if (cycleId) return cycleJid.get(cycleId) ?? `agent:${agentId}`;
  return `agent:${agentId}`;
}

/** Mark the start of a cycle's live stream (clears any prior UI state). */
export function startCycleStream(
  agentId: string,
  overrideJid?: string,
  cycleId?: string,
): void {
  if (cycleId && overrideJid) cycleJid.set(cycleId, overrideJid);
  const jid = overrideJid ?? `agent:${agentId}`;
  getSocketIO()?.emit('chat:activity', { chatJid: jid, type: 'start' });
}

/**
 * Ingest a pushed snapshot of the cycle's steps: persist + emit only the delta
 * (new steps, plus steps whose output just got filled in). Idempotent — each
 * DB row is upserted by its stable (cycleId, seq) key, so a re-push of
 * already-seen steps (e.g. after an orchestrator restart resets in-memory
 * state) just harmlessly re-writes the same rows.
 */
export function streamCycleSteps(
  agentId: string,
  cycleId: string,
  steps: CycleStep[],
  startSeq = 0,
): void {
  const io = getSocketIO();
  const chatJid = chatJidFor(agentId, cycleId);
  let st = state.get(cycleId);
  if (!st) {
    st = { emittedCount: 0, resultsEmitted: new Set() };
    state.set(cycleId, st);
  }

  // Single pass: figure out which rows are new or just got their output filled
  // in, then persist + emit only those — not the full cumulative array. seq
  // (not array index) is the identity of a step now that the array may be a
  // window starting partway through the cycle.
  const changed: Array<{ seq: number; step: CycleStep }> = [];

  for (let i = 0; i < steps.length; i++) {
    const seq = startSeq + i;
    const s = steps[i];
    const isNew = seq >= st.emittedCount;
    if (isNew) {
      changed.push({ seq, step: s });
      if (io) {
        if (s.type === 'thinking' && s.content) {
          io.emit('chat:activity', {
            chatJid,
            type: 'thinking',
            content: s.content,
          });
        } else if (s.type === 'tool_call' && s.tool) {
          io.emit('chat:activity', {
            chatJid,
            type: 'tool_call',
            callId: s.id ?? `tc-${seq}`,
            tool: s.tool,
            input: s.input ?? '{}',
          });
        }
      }
      // Stage 35 dual-write: the same step, as an entry in the conversation log.
      // A legacy cycle_steps row of type 'tool_call' carries the call AND its
      // eventual output in one row; here they're two ordered events, which is
      // what lets a call, its result and the text around it interleave by fact
      // rather than by the frontend guessing. Ids are keyed off (cycleId, seq)
      // so a re-push after an orchestrator restart updates rather than duplicates.
      if (s.type === 'thinking' && s.content) {
        appendConversationEvent(
          chatJid,
          {
            type: 'thinking',
            cycle_id: cycleId,
            role: 'assistant',
            content: s.content,
            status: 'ok',
          },
          `ce-${cycleId}-${seq}-thinking`,
        );
      } else if (s.type === 'tool_call' && s.tool) {
        appendConversationEvent(
          chatJid,
          {
            type: 'tool_call',
            cycle_id: cycleId,
            role: 'assistant',
            tool_name: s.tool,
            tool_input: s.input ?? '{}',
            status: 'ok',
            metadata: JSON.stringify({ call_id: s.id ?? `tc-${seq}` }),
          },
          `ce-${cycleId}-${seq}-call`,
        );
      }
    }
    // Stream the tool result the moment its output appears (whether the step is
    // new or was announced earlier with output=null and just got filled in).
    if (
      s.type === 'tool_call' &&
      s.output != null &&
      !st.resultsEmitted.has(seq)
    ) {
      st.resultsEmitted.add(seq);
      if (!isNew) changed.push({ seq, step: s }); // new ones already queued above
      if (io)
        io.emit('chat:activity', {
          chatJid,
          type: 'tool_result',
          callId: s.id ?? `tc-${seq}`,
          output: String(s.output),
        });
      appendConversationEvent(
        chatJid,
        {
          type: 'tool_result',
          cycle_id: cycleId,
          role: 'assistant',
          tool_name: s.tool,
          tool_output: String(s.output),
          status: 'ok',
          metadata: JSON.stringify({ call_id: s.id ?? `tc-${seq}` }),
        },
        `ce-${cycleId}-${seq}-result`,
      );
    }
  }
  const maxSeqSeen = startSeq + steps.length;
  if (maxSeqSeen > st.emittedCount) st.emittedCount = maxSeqSeen;

  if (changed.length > 0) {
    try {
      upsertCycleSteps(agentId, cycleId, changed);
    } catch (e) {
      logger.error({ err: e, agentId, cycleId }, 'upsertCycleSteps failed');
    }
  }
}

/**
 * stage44 doc 01, step 3 of 5: the live browser view's server half.
 *
 * The agent's react_loop POSTs its newest CDP screencast frame to
 * /api/agents/:id/cycles/:cycleId/frame (throttled to ~2fps on the agent side);
 * this relays it straight to the owning user's dashboard as `chat:frame`.
 *
 * Deliberately NOT persisted and NOT diffed, unlike streamCycleSteps above. A
 * frame is a live view of a browser that has already moved on — it has no value
 * after the moment it arrives, and cycle_steps is a durable record of what the
 * agent DID, which a 40KB JPEG of what a page looked like is not. Writing these
 * to the DB at 2fps would add thousands of rows and tens of MB per cycle to the
 * exact table whose growth already caused a V8 heap exhaustion (see this file's
 * header). Missing a frame costs the viewer 500ms of staleness; nothing else.
 *
 * Reuses chatJidFor so a project-chat cycle's frames follow the same override
 * its steps already do, and so socket-scope.ts's `chat:` branch derives the
 * owner from chatJid and routes this to that user's room only — a live view of
 * someone's browser session is exactly the kind of thing that must never
 * broadcast. Any new event name here that isn't `chat:`-prefixed would silently
 * go to admins only; that is why this is `chat:frame`.
 */
/**
 * The run has stopped and is waiting for a person (stage 49 phase 5.4).
 *
 * `chat:`-prefixed for exactly the reason the frame is: socket-scope.ts derives the
 * owner from chatJid and routes it to that user's room alone. An event name without the
 * prefix would silently go to admins only — and "come and drive my browser" must reach
 * the person who owns it, and only them.
 */
export function streamCycleTakeover(
  agentId: string,
  cycleId: string,
  reason: string,
): void {
  const chatJid = chatJidFor(agentId, cycleId);
  getSocketIO()?.emit('chat:takeover', { chatJid, agentId, cycleId, reason });
}

export function streamCycleFrame(
  agentId: string,
  cycleId: string,
  dataUrl: string,
  url = '',
  title = '',
): void {
  const chatJid = chatJidFor(agentId, cycleId);
  // `agentId` travels alongside chatJid (stage 49 phase 4). The dashboard now tracks
  // which agents have a live browser app-wide, not just on the open chat tab, and it
  // cannot derive the agent from the jid: `chatJidFor` returns a project-chat override
  // when a cycle has one, so `agent:<id>` only holds for the default case.
  getSocketIO()?.emit('chat:frame', {
    chatJid,
    agentId,
    cycleId,
    dataUrl,
    url,
    title,
  });
}

/** End a cycle's live stream and free its emit state. */
export function endCycleStream(agentId: string, cycleId: string): void {
  const jid = chatJidFor(agentId, cycleId);
  getSocketIO()?.emit('chat:activity', { chatJid: jid, type: 'done' });
  state.delete(cycleId);
  cycleJid.delete(cycleId);
}
