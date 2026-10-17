/**
 * Backfill old conversations into the event log (Stage 35 Phase 5).
 *
 * The three legacy tables — `messages`, `cycle_steps`, `agent_file_events` — are the
 * complete record of everything that happened before the dual-write existed. This
 * folds them into `conversation_events` so a conversation that predates the stream
 * still renders under the new read path.
 *
 * It is best-effort by nature, and the doc says so: the three tables have no common
 * ordering key (that's the whole problem this stage fixes), so the exact historical
 * interleaving is reconstructed, not recovered. The rule used here — a cycle's steps
 * and file changes belong immediately before that cycle's result message — is a
 * faithful-enough approximation. New conversations are perfect; some old ones may
 * order slightly off. That is a cosmetic degradation of old threads, never a
 * correctness risk to new ones.
 *
 * Non-destructive: a conversation that already has events (i.e. the dual-write has
 * run for it) is skipped, never rewritten. On a fresh prod database — where the
 * table is empty at deploy — every conversation is backfilled cleanly. That
 * asymmetry is deliberate: the safe property for a migration that runs in prod is
 * that it can only ever ADD the history that's missing, never disturb live data.
 */
import type {
  NewConversationEvent,
  AgentFileEvent,
  NewMessage,
} from './types.js';
import type { CycleStep } from './db.js';

/** `cyc-<cycleId>-<kind>-<uuid8>` — the id _emitCycleChat tags a cycle message with. */
const CYCLE_MSG_ID = /^cyc-(.+)-(start|result|fail|msg)-[0-9a-f]{8}$/;

interface LegacyConversation {
  messages: NewMessage[]; // ordered by timestamp
  stepsByCycle: Record<string, CycleStep[]>; // ordered by seq
  fileEventsByCycle: Record<string, AgentFileEvent[]>;
}

/**
 * Reconstruct the ordered event list for one conversation from its legacy rows.
 * Pure — no DB, no seq assignment (the caller/insert path owns seq) — so the
 * reconstruction logic is testable on synthetic data.
 */
export function buildBackfillEvents(
  conv: LegacyConversation,
): NewConversationEvent[] {
  const events: NewConversationEvent[] = [];
  const cycleStepsEmitted = new Set<string>();

  // Emit a cycle's steps + file changes, once, in order — placed just before the
  // message that closes the cycle.
  const emitCycleBody = (cycleId: string) => {
    if (cycleStepsEmitted.has(cycleId)) return;
    cycleStepsEmitted.add(cycleId);
    for (const s of conv.stepsByCycle[cycleId] ?? []) {
      const callId = s.id ?? undefined;
      if (s.type === 'thinking') {
        events.push({
          type: 'thinking',
          cycle_id: cycleId,
          role: 'assistant',
          content: s.content ?? '',
          status: 'ok',
        });
      } else if (s.type === 'tool_call') {
        events.push({
          type: 'tool_call',
          cycle_id: cycleId,
          role: 'assistant',
          tool_name: s.tool,
          tool_input: s.input ?? '{}',
          status: 'ok',
          metadata: JSON.stringify({ call_id: callId }),
        });
        if (s.output != null) {
          events.push({
            type: 'tool_result',
            cycle_id: cycleId,
            role: 'assistant',
            tool_name: s.tool,
            tool_output: String(s.output),
            status: 'ok',
            metadata: JSON.stringify({ call_id: callId }),
          });
        }
      }
    }
    for (const f of conv.fileEventsByCycle[cycleId] ?? []) {
      events.push({
        type: 'file_change',
        cycle_id: cycleId,
        role: 'assistant',
        file_path: f.file_path,
        diff_patch: f.diff_patch ?? undefined,
        status: 'ok',
        metadata: JSON.stringify({ event_type: f.event_type }),
      });
    }
  };

  for (const m of conv.messages) {
    const tag = m.id.match(CYCLE_MSG_ID);
    if (!tag) {
      // A plain message with no cycle: a user turn, a welcome, a job notice.
      events.push({
        type: m.is_from_me ? 'user_msg' : 'agent_msg',
        role: m.is_from_me ? 'user' : 'assistant',
        content: m.content,
        status: 'ok',
        metadata: JSON.stringify({
          source: m.source,
          sender: m.sender_name,
          legacy_msg_id: m.id,
        }),
      });
      continue;
    }

    const [, cycleId, kind] = tag;
    if (kind === 'start') {
      // The "⚙️ Running…" ack — kept, and tagged so the renderer hides it exactly
      // as it does for a live cycle. Carries the sender for project attribution.
      events.push({
        type: 'agent_msg',
        cycle_id: cycleId,
        role: 'assistant',
        content: m.content,
        status: 'ok',
        metadata: JSON.stringify({
          kind: 'start',
          sender: m.sender_name,
          legacy_msg_id: m.id,
        }),
      });
      continue;
    }

    // A terminal cycle message (result / fail / msg): its steps and files came
    // first, so emit them, then the message itself.
    emitCycleBody(cycleId);
    events.push({
      type: kind === 'fail' ? 'error' : 'agent_msg',
      cycle_id: cycleId,
      role: 'assistant',
      content: m.content,
      status: kind === 'fail' ? 'error' : 'ok',
      metadata: JSON.stringify({
        kind,
        sender: m.sender_name,
        legacy_msg_id: m.id,
      }),
    });
  }

  return events;
}
