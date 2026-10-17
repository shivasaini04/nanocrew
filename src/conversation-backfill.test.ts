/**
 * Stage 35 Phase 5 — backfilling old conversations into the event log.
 *
 * Two layers: the pure reconstructor (buildBackfillEvents) on synthetic legacy
 * rows, and the DB driver (backfillConversationEvents) end-to-end against the
 * in-memory database, including its non-destructive and run-once guarantees.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildBackfillEvents } from './conversation-backfill.js';
import {
  _initTestDatabase,
  storeMessageDirect,
  storeChatMetadata,
  upsertCycleSteps,
  logAgentFileEvent,
  createAgent,
  createAgentCycle,
  backfillConversationEvents,
  getConversationEvents,
  insertConversationEvent,
  getRouterState,
} from './db.js';
import type { NewMessage } from './types.js';

function msg(over: Partial<NewMessage> & { id: string }): NewMessage {
  return {
    chat_jid: 'agent:a1',
    sender: 'x',
    sender_name: 'x',
    content: 'c',
    timestamp: '2026-01-01T00:00:00Z',
    is_from_me: false,
    ...over,
  };
}

describe('buildBackfillEvents (pure reconstruction)', () => {
  it('reconstructs a full turn: user prompt → steps → files → reply, in order', () => {
    const events = buildBackfillEvents({
      messages: [
        msg({ id: 'dash_msg_1', is_from_me: true, content: 'find leads' }),
        msg({ id: 'cyc-C1-start-aaaaaaaa', content: '⚙️ Running…' }),
        msg({ id: 'cyc-C1-result-bbbbbbbb', content: 'Found 12.' }),
      ],
      stepsByCycle: {
        C1: [
          { type: 'thinking', id: 'C1-0', content: 'planning' },
          {
            type: 'tool_call',
            id: 'C1-1',
            tool: 'apollo',
            input: '{"q":1}',
            output: '12 leads',
          },
        ],
      },
      fileEventsByCycle: {
        C1: [
          {
            id: 'f1',
            agent_id: 'a1',
            cycle_id: 'C1',
            event_type: 'create',
            file_path: 'leads.csv',
            timestamp: '',
          },
        ],
      },
    });

    expect(events.map((e) => e.type)).toEqual([
      'user_msg', // the prompt
      'agent_msg', // the start ack (hidden by the renderer, but preserved)
      'thinking', // steps come before the result
      'tool_call',
      'tool_result', // split out of the tool_call row's output
      'file_change',
      'agent_msg', // the reply
    ]);
    // The start ack carries the kind marker the renderer filters on.
    expect(JSON.parse(events[1].metadata!).kind).toBe('start');
    // The result is a real reply, not an ack.
    expect(events[6].content).toBe('Found 12.');
  });

  it('maps a fail message to an error event — a past failure stays a failure', () => {
    const events = buildBackfillEvents({
      messages: [
        msg({
          id: 'cyc-C9-fail-cccccccc',
          content: '⚠️ Cycle failed: Authentication Fails',
        }),
      ],
      stepsByCycle: {},
      fileEventsByCycle: {},
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].status).toBe('error');
    expect(events[0].content).toContain('Authentication Fails');
  });

  it('treats an untagged message as a plain user/agent turn', () => {
    const events = buildBackfillEvents({
      messages: [
        msg({ id: 'usr-ext-1', is_from_me: true, content: 'hi' }),
        msg({
          id: 'welcome_a1',
          is_from_me: false,
          content: 'Hi, I am your agent',
        }),
      ],
      stepsByCycle: {},
      fileEventsByCycle: {},
    });
    expect(events.map((e) => e.type)).toEqual(['user_msg', 'agent_msg']);
  });

  it("emits a cycle's body exactly once even if it has several messages", () => {
    const events = buildBackfillEvents({
      messages: [
        msg({ id: 'cyc-C1-start-aaaaaaaa', content: 'start' }),
        msg({ id: 'cyc-C1-result-bbbbbbbb', content: 'done' }),
      ],
      stepsByCycle: { C1: [{ type: 'thinking', id: 'C1-0', content: 'x' }] },
      fileEventsByCycle: {},
    });
    expect(events.filter((e) => e.type === 'thinking')).toHaveLength(1);
  });

  it('omits a tool_result when the legacy step had no output', () => {
    const events = buildBackfillEvents({
      messages: [msg({ id: 'cyc-C1-result-bbbbbbbb', content: 'done' })],
      stepsByCycle: {
        C1: [{ type: 'tool_call', id: 'C1-0', tool: 'apollo', input: '{}' }],
      },
      fileEventsByCycle: {},
    });
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'agent_msg']);
  });
});

describe('backfillConversationEvents (DB driver)', () => {
  let agentId: string;
  beforeEach(() => {
    _initTestDatabase();
    // A real agent — agent_file_events has an FK on agent_id. Its id is unrelated to
    // the conversation JIDs the tests use; the reconstruction keys off chat_jid.
    agentId = createAgent({
      name: 'A',
      type: 'custom',
      emoji: '🤖',
      status: 'idle',
      workspace: '/w',
      config: {
        schedule: [],
        budget: { daily: 5, monthly: 50, onExhaust: 'pause' },
        tools: [],
        goals: 'g',
        escalationRules: [],
      },
      identity_version: 1,
    }).id;
  });

  function seedLegacyConversation(jid: string) {
    // A real cycle row — agent_file_events also has an FK on cycle_id. Its generated
    // id is what the message tag and steps must key off.
    const C = createAgentCycle({
      agent_id: agentId,
      cycle_type: 'custom',
      status: 'completed',
      started_at: '2026-01-01T00:00:01Z',
      cost: 0,
      tasks_done: 1,
    }).id;
    storeChatMetadata(jid, '2026-01-01T00:00:00Z', 'Test', 'dashboard', false);
    storeMessageDirect({
      id: `dash_msg_${C}`,
      chat_jid: jid,
      sender: 'You',
      sender_name: 'You',
      content: 'find leads',
      timestamp: '2026-01-01T00:00:01Z',
      is_from_me: true,
    });
    storeMessageDirect({
      id: `cyc-${C}-result-bbbbbbbb`,
      chat_jid: jid,
      sender: 'Agent',
      sender_name: 'Agent',
      content: 'Found 12.',
      timestamp: '2026-01-01T00:00:03Z',
      is_from_me: false,
      is_bot_message: true,
    });
    upsertCycleSteps(agentId, C, [
      { seq: 0, step: { type: 'thinking', id: `${C}-0`, content: 'planning' } },
      {
        seq: 1,
        step: {
          type: 'tool_call',
          id: `${C}-1`,
          tool: 'apollo',
          input: '{}',
          output: '12 leads',
        },
      },
    ]);
    logAgentFileEvent({
      agent_id: agentId,
      cycle_id: C,
      event_type: 'create',
      file_path: 'leads.csv',
    });
  }

  it('folds a legacy conversation into an ordered event log', () => {
    const jid = `agent:${agentId}`;
    seedLegacyConversation(jid);

    const n = backfillConversationEvents();
    expect(n).toBe(1);

    const events = getConversationEvents(jid);
    expect(events.map((e) => e.type)).toEqual([
      'user_msg',
      'thinking',
      'tool_call',
      'tool_result',
      'file_change',
      'agent_msg',
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]); // gapless
    expect(events[0].content).toBe('find leads');
    expect(events[5].content).toBe('Found 12.');
  });

  it('is non-destructive: skips a conversation that already has events', () => {
    const jid = 'agent:already';
    seedLegacyConversation(jid);
    // Simulate the dual-write having already run for this thread.
    insertConversationEvent(jid, {
      type: 'user_msg',
      role: 'user',
      content: 'live event',
    });

    backfillConversationEvents();

    const events = getConversationEvents(jid);
    expect(events).toHaveLength(1); // untouched
    expect(events[0].content).toBe('live event');
  });

  it('runs once — a second call is a no-op even after new legacy data appears', () => {
    const jid = 'agent:once';
    seedLegacyConversation(jid);
    expect(backfillConversationEvents()).toBe(1);
    expect(getRouterState('stage35_backfill_v1')).toBe('done');

    // New legacy conversation appears after the marker is set.
    seedLegacyConversation('agent:late');
    expect(backfillConversationEvents()).toBe(0); // guard short-circuits
    expect(getConversationEvents('agent:late')).toHaveLength(0);
  });
});
