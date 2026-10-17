/**
 * Stage 35 Phase 0 — the conversation event log's persistence primitives.
 *
 * These test the properties the whole design rests on: one ordered log per
 * conversation, a replayed event can't duplicate or reorder it, and a cursor
 * read returns exactly what a client hasn't seen.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  insertConversationEvent,
  getConversationEvents,
  getConversationHeadSeq,
  getConversationTailSeq,
  _rawDb,
  createAgent,
  createAgentCycle,
} from './db.js';
import type { AgentConfig } from './types.js';

const config: AgentConfig = {
  schedule: [],
  budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
  tools: [],
  goals: 'test',
  escalationRules: [],
};

function makeAgent() {
  return createAgent({
    name: 'Recruiter',
    type: 'lead_hunter',
    emoji: '🔍',
    status: 'idle',
    workspace: '/data/agents/t',
    config,
    identity_version: 1,
  });
}

beforeEach(() => {
  _initTestDatabase();
});

describe('conversation event log', () => {
  it('allocates gapless monotonic seq per conversation', () => {
    for (const type of ['user_msg', 'thinking', 'tool_call'] as const) {
      insertConversationEvent('agent:a1', { type, content: 'x' });
    }
    expect(getConversationEvents('agent:a1').map((e) => e.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(getConversationHeadSeq('agent:a1')).toBe(3);
  });

  it('numbers each conversation independently', () => {
    insertConversationEvent('agent:a1', { type: 'user_msg', content: 'one' });
    insertConversationEvent('agent:a2', { type: 'user_msg', content: 'two' });
    expect(getConversationEvents('agent:a1')[0].seq).toBe(1);
    expect(getConversationEvents('agent:a2')[0].seq).toBe(1);
    expect(getConversationHeadSeq('agent:empty')).toBe(0);
  });

  it('preserves interleaved order across event types — the whole point', () => {
    insertConversationEvent('agent:a1', {
      type: 'user_msg',
      content: 'find leads',
    });
    insertConversationEvent('agent:a1', {
      type: 'thinking',
      content: 'planning',
    });
    insertConversationEvent('agent:a1', {
      type: 'tool_call',
      tool_name: 'apollo',
    });
    insertConversationEvent('agent:a1', {
      type: 'tool_result',
      tool_name: 'apollo',
      tool_output: '12 leads',
    });
    insertConversationEvent('agent:a1', {
      type: 'file_change',
      file_path: 'leads.csv',
    });
    insertConversationEvent('agent:a1', {
      type: 'agent_msg',
      content: 'Found 12.',
    });
    expect(getConversationEvents('agent:a1').map((e) => e.type)).toEqual([
      'user_msg',
      'thinking',
      'tool_call',
      'tool_result',
      'file_change',
      'agent_msg',
    ]);
  });

  it('an error is an ordinary row, so a failed turn is always visible in the log', () => {
    insertConversationEvent('agent:a1', { type: 'user_msg', content: 'hi' });
    insertConversationEvent('agent:a1', {
      type: 'error',
      status: 'error',
      cycle_id: 'c1',
      content: 'Error calling LLM: Authentication Fails',
    });
    const events = getConversationEvents('agent:a1');
    expect(events).toHaveLength(2);
    // The distinguishing property vs the old model: the last thing in the log is the
    // failure itself, not a stale repeat of the previous successful reply.
    expect(events[1].type).toBe('error');
    expect(events[1].status).toBe('error');
    expect(events[1].content).toContain('Authentication Fails');
  });

  it('a replayed event updates in place — no duplicate, no renumber', () => {
    insertConversationEvent(
      'agent:a1',
      { type: 'tool_call', tool_name: 'apollo' },
      'ce-c1-0-call',
    );
    insertConversationEvent('agent:a1', { type: 'user_msg', content: 'next' });
    // Same idempotency key re-pushed (e.g. orchestrator restart replays the window)
    // with output now filled in.
    const replayed = insertConversationEvent(
      'agent:a1',
      { type: 'tool_call', tool_name: 'apollo', tool_output: '12 leads' },
      'ce-c1-0-call',
    );
    const events = getConversationEvents('agent:a1');
    expect(events).toHaveLength(2); // not 3 — no duplicate appended
    expect(replayed.seq).toBe(1); // kept its original position
    expect(events[0].tool_output).toBe('12 leads');
    expect(events[1].seq).toBe(2); // the later event was not renumbered
  });

  it('opening a long conversation returns the NEWEST page, not the oldest', () => {
    // The bug this pins: `after_seq=0` used to mean "first page ascending", so a
    // conversation longer than the limit showed its opening messages and could never
    // reach the recent ones. A real 2798-event thread rendered seq 1..1000 forever.
    for (let i = 1; i <= 30; i++)
      insertConversationEvent('agent:a1', {
        type: 'user_msg',
        content: `m${i}`,
      });

    const page = getConversationEvents('agent:a1', 0, 10);
    expect(page.map((e) => e.content)).toEqual([
      'm21',
      'm22',
      'm23',
      'm24',
      'm25',
      'm26',
      'm27',
      'm28',
      'm29',
      'm30',
    ]);
    // …and still ascending, so the renderer's ordering assumptions hold.
    expect(page.map((e) => e.seq)).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
  });

  it('before_seq pages back through history the first read deliberately skipped', () => {
    // The initial read returns only the newest page, because a full history is far too
    // much to hand a browser at once. before_seq is how the rest stays reachable.
    for (let i = 1; i <= 30; i++)
      insertConversationEvent('agent:a1', {
        type: 'user_msg',
        content: `m${i}`,
      });

    const newest = getConversationEvents('agent:a1', 0, 10);
    expect(newest[0].seq).toBe(21);

    const older = getConversationEvents('agent:a1', 0, 10, newest[0].seq);
    expect(older.map((e) => e.content)).toEqual([
      'm11',
      'm12',
      'm13',
      'm14',
      'm15',
      'm16',
      'm17',
      'm18',
      'm19',
      'm20',
    ]);

    const oldest = getConversationEvents('agent:a1', 0, 10, older[0].seq);
    expect(oldest[0].seq).toBe(1);
    // …and the client knows it has arrived: its oldest now equals the conversation's first.
    expect(getConversationTailSeq('agent:a1')).toBe(1);
    // Paging past the start yields nothing rather than wrapping or erroring.
    expect(getConversationEvents('agent:a1', 0, 10, 1)).toEqual([]);
  });

  it('caps heavy fields for transport but never alters the stored row', () => {
    // One event can carry a whole tool output. Unbounded, a single page serialised to
    // 241 MB and was JSON.stringify'd synchronously on an orchestrator shared by every
    // tenant — the documented way to OOM the platform.
    const huge = 'x'.repeat(50_000);
    insertConversationEvent('agent:a1', {
      type: 'tool_call',
      cycle_id: 'c1',
      tool_name: 'web_fetch',
      tool_output: huge,
      tool_input: huge,
      diff_patch: 'd'.repeat(100_000),
    });

    const [read] = getConversationEvents('agent:a1');
    expect(read.tool_output!.length).toBeLessThan(9_000);
    expect(read.tool_output).toContain('truncated — 50000 chars total');
    expect(read.diff_patch!.length).toBeLessThan(33_000);

    // The log itself is the audit trail — it keeps everything.
    const stored = _rawDb()
      .prepare('SELECT tool_output FROM conversation_events WHERE seq = 1')
      .get() as { tool_output: string };
    expect(stored.tool_output.length).toBe(50_000);
  });

  it('after_seq returns only unseen events — the reconnect backfill', () => {
    for (const c of ['a', 'b', 'c', 'd'])
      insertConversationEvent('agent:a1', { type: 'user_msg', content: c });
    expect(getConversationEvents('agent:a1', 2).map((e) => e.content)).toEqual([
      'c',
      'd',
    ]);
    expect(getConversationEvents('agent:a1', 4)).toEqual([]); // caught up
    // afterSeq=0 is "open the conversation" → the NEWEST page. This assertion used to
    // expect ['a','b'] — it was encoding the bug that left long threads stuck on their
    // oldest messages.
    expect(
      getConversationEvents('agent:a1', 0, 2).map((e) => e.content),
    ).toEqual(['c', 'd']);
  });

  it('the appended event is identical to the one a reload reads back', () => {
    // The returned object is what the socket broadcasts (live); the read endpoint
    // serves the row (reload). If those two differ in shape, live and reloaded
    // renderings of the same conversation diverge — the bug class this log exists to
    // remove — so they must be the same object, field for field.
    const appended = insertConversationEvent('agent:a1', {
      type: 'tool_call',
      cycle_id: 'c1',
      role: 'assistant',
      tool_name: 'apollo',
      tool_input: '{}',
    });
    expect(appended).toEqual(getConversationEvents('agent:a1')[0]);
  });

  it('appendConversationEvent persists and returns the event with no socket attached', async () => {
    // The producers dual-write through this wrapper, and it runs in contexts where
    // getSocketIO() is undefined (tests, startup, workers). Persisting must not depend
    // on a socket being up — a dropped broadcast is recoverable via the read cursor,
    // a dropped row is not.
    const { appendConversationEvent } =
      await import('./conversation-events.js');
    const saved = appendConversationEvent('agent:a1', {
      type: 'agent_msg',
      content: 'hello',
    });
    expect(saved).not.toBeNull();
    expect(saved!.seq).toBe(1);
    expect(getConversationEvents('agent:a1')).toHaveLength(1);
    // Generous timeout: this is the only test that imports the module for real, and
    // conversation-events → api/server drags in the whole server graph (several
    // seconds). That's import cost, not a hang.
  }, 30_000);

  it("keeps all of one cycle's events in a single conversation", () => {
    // The invariant a cycle's producers must satisfy. It was broken once: file changes
    // resolved their own conversation from the cycle's project_id while messages and
    // steps followed runCycle's streamJid, so a project-scoped cycle with no chatJid
    // filed its files under project:<pid> and everything else under agent:<id> — and
    // the orphaned file events opened a turn no reply ever closed.
    const conv = 'agent:a1';
    insertConversationEvent(conv, {
      type: 'user_msg',
      cycle_id: 'c1',
      content: 'go',
    });
    insertConversationEvent(conv, {
      type: 'tool_call',
      cycle_id: 'c1',
      tool_name: 'apollo',
    });
    insertConversationEvent(conv, {
      type: 'file_change',
      cycle_id: 'c1',
      file_path: 'leads.csv',
    });
    insertConversationEvent(conv, {
      type: 'agent_msg',
      cycle_id: 'c1',
      content: 'done',
    });

    const everywhere = [
      ...getConversationEvents('agent:a1'),
      ...getConversationEvents('project:p1'),
    ];
    const forCycle = everywhere.filter((e) => e.cycle_id === 'c1');
    expect(new Set(forCycle.map((e) => e.conversation)).size).toBe(1);
    // …and the turn is closed by a terminal event, so it can't render as forever-running.
    expect(forCycle[forCycle.length - 1].type).toBe('agent_msg');
  });
});
