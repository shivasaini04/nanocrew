/**
 * Stage 35 Phase 2 — folding the event log into turns.
 *
 * These encode the doc's verification criteria as tests: correct interleaving with
 * no heuristics, no stale-trace inheritance across turns, and a failed turn that is
 * always a distinct state — never a normal reply and never silence.
 */
import { describe, it, expect } from 'vitest';
import { buildTurns, mergeBySeq, isAckMarker, isNoiseFilePath, turnsEqual, type ConversationEvent, type AgentTurn, type TurnApproval } from './conversation-turns';

let seq = 0;
function ev(partial: Partial<ConversationEvent> & { type: ConversationEvent['type'] }): ConversationEvent {
    seq += 1;
    return {
        id: `e${seq}`, conversation: 'agent:a1', seq,
        created_at: new Date().toISOString(), ...partial,
    };
}
function reset() { seq = 0; }

describe('buildTurns — approval gates', () => {
    const meta = (o: Record<string, unknown>) => JSON.stringify({
        approval_id: 'ap1', action: 'click', timeout_ms: 1800000, ...o,
    });

    it('attaches a pending approval to the turn that raised it', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'user_msg', content: 'buy it' }),
            ev({ type: 'thinking', cycle_id: 'c1', content: 'planning' }),
            ev({ type: 'approval_request', cycle_id: 'c1', content: 'click Checkout', metadata: meta({ element: 'Checkout' }) }),
        ]);
        const turn = turns[1] as AgentTurn;
        expect(turn.approvals).toHaveLength(1);
        expect(turn.approvals[0].element).toBe('Checkout');
        expect(turn.approvals[0].decision).toBeUndefined();
        // The agent is blocked, not finished.
        expect(turn.active).toBe(true);
    });

    it('replaces the ask in place when it is decided, rather than adding a second card', () => {
        reset();
        // The server re-appends under the SAME event id and seq to update in place.
        const ask = ev({ type: 'approval_request', cycle_id: 'c1', content: 'click Checkout', metadata: meta({}) });
        const settled = { ...ask, metadata: meta({ decision: 'approved' }) };
        const turns = buildTurns([
            ev({ type: 'user_msg', content: 'buy it' }),
            settled,
        ]);
        const turn = turns[1] as AgentTurn;
        expect(turn.approvals).toHaveLength(1);
        expect(turn.approvals[0].decision).toBe('approved');
    });

    it('keeps an approval out of steps — it is not something the agent did', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'approval_request', cycle_id: 'c1', content: 'click Checkout', metadata: meta({}) }),
        ]);
        expect((turns[0] as AgentTurn).steps).toHaveLength(0);
    });

    it('ignores an approval event with no approval_id rather than rendering a broken card', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'approval_request', cycle_id: 'c1', content: 'x', metadata: '{}' }),
        ]);
        expect((turns[0] as AgentTurn).approvals).toHaveLength(0);
    });
});

describe('turnsEqual — approvals', () => {
    const base = (): AgentTurn => ({
        kind: 'agent', key: 'k', cycleId: 'c1', steps: [], files: [], approvals: [], active: true,
    });
    const ap = (decision?: 'approved' | 'denied' | 'expired') => ({
        id: 'e1', approvalId: 'ap1', action: 'click', description: 'click Checkout',
        createdAt: '2026-08-30T00:00:00Z', timeoutMs: 1800000, decision,
    });

    it('is false once a decision arrives, so the card re-renders', () => {
        expect(turnsEqual(
            { ...base(), approvals: [ap()] },
            { ...base(), approvals: [ap('approved')] },
        )).toBe(false);
    });

    it('is true when nothing about the approval changed', () => {
        expect(turnsEqual(
            { ...base(), approvals: [ap()] },
            { ...base(), approvals: [ap()] },
        )).toBe(true);
    });

    it('tolerates a turn built without the approvals field', () => {
        const legacy = { ...base() } as AgentTurn;
        delete (legacy as Partial<AgentTurn>).approvals;
        expect(turnsEqual(legacy, { ...base() })).toBe(true);
    });
});

describe('buildTurns', () => {
    it('splits user turns from agent turns and keeps log order', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'user_msg', content: 'find leads' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Found 12.' }),
            ev({ type: 'user_msg', content: 'thanks' }),
        ]);
        expect(turns.map(t => t.kind)).toEqual(['user', 'agent', 'user']);
        expect((turns[1] as AgentTurn).text).toBe('Found 12.');
    });

    it('interleaves thinking/tools/text into one turn by cycle_id, in seq order', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'user_msg', content: 'go' }),
            ev({ type: 'thinking', cycle_id: 'c1', content: 'planning' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo', tool_input: '{"q":1}', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_name: 'apollo', tool_output: '12 leads', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Found 12.' }),
        ]);
        const agent = turns[1] as AgentTurn;
        expect(agent.steps.map(s => s.name)).toEqual(['thinking', 'apollo']);
        expect(agent.steps[1].result).toBe('12 leads');   // result attached to its call
        expect(agent.text).toBe('Found 12.');
        expect(agent.active).toBe(false);
    });

    it('pairs each tool result with its OWN call, not the most recent one', () => {
        reset();
        // Tools dispatch concurrently, so results can arrive out of call order. Pairing
        // by call_id is what keeps inputs and outputs from being inverted.
        const turns = buildTurns([
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'read_file', tool_input: '{"p":"a"}', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'web_fetch', tool_input: '{"u":"b"}', metadata: '{"call_id":"t2"}' }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_output: 'PAGE', metadata: '{"call_id":"t2"}' }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_output: 'FILE', metadata: '{"call_id":"t1"}' }),
        ]);
        const steps = (turns[0] as AgentTurn).steps;
        expect(steps.find(s => s.name === 'read_file')!.result).toBe('FILE');
        expect(steps.find(s => s.name === 'web_fetch')!.result).toBe('PAGE');
    });

    it('never lets one turn inherit another turn\'s tool trace', () => {
        reset();
        // The old page seeded a new result's trace from a live-steps ref without
        // checking it belonged to that cycle. Here the cycle_id does the separating.
        const turns = buildTurns([
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'first' }),
            ev({ type: 'agent_msg', cycle_id: 'c2', content: 'second' }),
        ]);
        const second = turns[1] as AgentTurn;
        expect(second.text).toBe('second');
        expect(second.steps).toHaveLength(0);   // c1's apollo call must not leak in
    });

    it('renders a failed turn as a distinct error state — the whole point', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'user_msg', content: 'any update?' }),
            ev({ type: 'error', cycle_id: 'c2', status: 'error', content: '_⚠️ Cycle failed: Authentication Fails_' }),
        ]);
        const failed = turns[1] as AgentTurn;
        expect(failed.error).toContain('Authentication Fails');
        expect(failed.text).toBeUndefined();   // never presented as the agent's answer
        expect(failed.active).toBe(false);     // never left spinning
    });

    it('a failed turn is distinguishable from the previous successful reply', () => {
        reset();
        // The launch-day symptom: a failure that renders as nothing leaves the prior
        // reply as the newest thing on screen. Here the failure is its own last turn.
        const turns = buildTurns([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Just need the website URL.' }),
            ev({ type: 'user_msg', content: 'any update?' }),
            ev({ type: 'error', cycle_id: 'c2', status: 'error', content: 'Cycle failed: bad key' }),
        ]);
        expect(turns).toHaveLength(3);
        const last = turns[2] as AgentTurn;
        expect(last.kind).toBe('agent');
        expect(last.error).toBe('Cycle failed: bad key');
        expect(last.text).not.toBe('Just need the website URL.');
    });

    it('marks a turn active only until its answer or error arrives', () => {
        reset();
        const running = buildTurns([ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo' })]);
        expect((running[0] as AgentTurn).active).toBe(true);
        reset();
        const done = buildTurns([
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo' }),
            ev({ type: 'cycle_end', cycle_id: 'c1' }),
        ]);
        expect((done[0] as AgentTurn).active).toBe(false);
    });

    it('drops the trailing thinking that became the answer — no double-printed reply', () => {
        reset();
        // Real shape from a live cycle: the last thinking step and the reply are the same
        // text, because the runner builds the reply out of that thinking (stripping the
        // <summary>/<tasks_done> trailer). Rendering both showed the answer twice, with a
        // stray tasks_done number trailing the duplicate.
        const turns = buildTurns([
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'web_search', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_output: 'hits', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'thinking', cycle_id: 'c1', content: 'Raksha Bandhan falls on Aug 28.\n<summary>Answered</summary>\n<tasks_done>2</tasks_done>' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Raksha Bandhan falls on Aug 28.', metadata: '{"kind":"result"}' }),
        ]);
        const turn = turns[0] as AgentTurn;
        expect(turn.steps.map(s => s.name)).toEqual(['web_search']);   // thinking dropped
        expect(turn.text).toBe('Raksha Bandhan falls on Aug 28.');     // said exactly once
    });

    it('keeps the trailing thinking while the turn is still running', () => {
        reset();
        // Mid-cycle the thinking IS the live content — dropping it would blank the turn.
        const turns = buildTurns([
            ev({ type: 'thinking', cycle_id: 'c1', content: 'working on it' }),
        ]);
        const turn = turns[0] as AgentTurn;
        expect(turn.active).toBe(true);
        expect(turn.steps.map(s => s.name)).toEqual(['thinking']);
    });

    it('keeps the trailing thinking on a turn that failed with no answer', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'thinking', cycle_id: 'c1', content: 'trying' }),
            ev({ type: 'error', cycle_id: 'c1', status: 'error', content: 'Cycle failed: boom' }),
        ]);
        const turn = turns[0] as AgentTurn;
        expect(turn.steps.map(s => s.name)).toEqual(['thinking']);   // it's all there is
        expect(turn.error).toContain('boom');
    });

    it('keeps a mid-trace thinking step — only the trailing one became the answer', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'thinking', cycle_id: 'c1', content: 'planning' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'done', metadata: '{"kind":"result"}' }),
        ]);
        expect((turns[0] as AgentTurn).steps.map(s => s.name)).toEqual(['thinking', 'apollo']);
    });

    it('hides ack markers by their kind, not by regexing the prose', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: '_⚙️ Running custom cycle…_', metadata: '{"kind":"start"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Done.', metadata: '{"kind":"result"}' }),
        ]);
        expect((turns[0] as AgentTurn).text).toBe('Done.');
    });

    it('does not hide a real reply that merely looks like an ack', () => {
        reset();
        // The old regex (/^(⚙️|⌛)/) would have eaten this.
        const turns = buildTurns([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: '⚙️ Running the deploy now — here are the results.', metadata: '{"kind":"result"}' }),
        ]);
        expect((turns[0] as AgentTurn).text).toContain('here are the results');
    });

    it('attributes each turn to its own agent — a project thread has a whole team', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'sourced 12', metadata: '{"kind":"result","sender":"🧑‍💼 Recruiter"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c2', content: 'drafted the post', metadata: '{"kind":"result","sender":"✍️ Writer"}' }),
        ]);
        expect((turns[0] as AgentTurn).sender).toBe('🧑‍💼 Recruiter');
        expect((turns[1] as AgentTurn).sender).toBe('✍️ Writer');
    });

    it('knows the author from the start marker, before the reply arrives', () => {
        reset();
        // Attribution must not wait for the closing message, or a running turn in a
        // project thread renders under the wrong agent's name.
        const turns = buildTurns([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: '_⚙️ Running custom cycle…_', metadata: '{"kind":"start","sender":"🧑‍💼 Recruiter"}' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo' }),
        ]);
        const turn = turns[0] as AgentTurn;
        expect(turn.sender).toBe('🧑‍💼 Recruiter');
        expect(turn.active).toBe(true);
        expect(turn.text).toBeUndefined();   // the ack itself is still not shown
    });

    it('collects file changes onto their own cycle\'s turn', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'leads.csv', metadata: '{"event_type":"create"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'wrote it' }),
        ]);
        expect((turns[0] as AgentTurn).files.map(f => [f.file_path, f.event_type])).toEqual([['leads.csv', 'create']]);
    });

    it('hides the agent\'s internal bookkeeping from "files changed"', () => {
        reset();
        // These are the exact paths a real cycle emitted: a trivial "say hello" turn
        // that touched no work product still reported five file changes.
        const turns = buildTurns([
            ev({ type: 'file_change', cycle_id: 'c1', file_path: '.nanocrew/telemetry/session-agent-x.jsonl', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'activity.json', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'memory/memories.jsonl', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'sessions/agent-x.jsonl', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'workspace/__pycache__/x.pyc', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'leads.csv', metadata: '{"event_type":"create"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'done' }),
        ]);
        // Only the thing the user actually asked for.
        expect((turns[0] as AgentTurn).files.map(f => [f.file_path, f.event_type])).toEqual([['leads.csv', 'create']]);
    });

    it('does not count a read as a change', () => {
        reset();
        const turns = buildTurns([
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'notes.md', metadata: '{"event_type":"read"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'out.csv', metadata: '{"event_type":"write"}' }),
        ]);
        expect((turns[0] as AgentTurn).files.map(f => [f.file_path, f.event_type])).toEqual([['out.csv', 'write']]);
    });

    it('surfaces an orphaned tool result rather than dropping it', () => {
        reset();
        const turns = buildTurns([ev({ type: 'tool_result', cycle_id: 'c1', tool_name: 'apollo', tool_output: 'X', metadata: '{"call_id":"gone"}' })]);
        expect((turns[0] as AgentTurn).steps[0].result).toBe('X');
    });

    it('tolerates malformed metadata', () => {
        reset();
        expect(() => buildTurns([ev({ type: 'agent_msg', cycle_id: 'c1', content: 'hi', metadata: 'not json{' })])).not.toThrow();
    });
});

describe('isAckMarker', () => {
    it('is true only for a start-kind agent message', () => {
        reset();
        expect(isAckMarker(ev({ type: 'agent_msg', metadata: '{"kind":"start"}' }))).toBe(true);
        expect(isAckMarker(ev({ type: 'agent_msg', metadata: '{"kind":"result"}' }))).toBe(false);
        expect(isAckMarker(ev({ type: 'error', metadata: '{"kind":"start"}' }))).toBe(false);
    });
});

describe('turnsEqual', () => {
    // This comparator decides whether a turn re-renders. A false "equal" means the UI
    // silently goes stale, so every field the renderer reads gets a case here.
    const base: AgentTurn = {
        kind: 'agent', key: 'k1', cycleId: 'c1', active: false,
        text: 'done', error: undefined, sender: '🧑‍💼 Recruiter', source: undefined,
        timestamp: '2026-01-01T00:00:00Z',
        steps: [{ id: 's1', name: 'apollo', args: '{}', result: '12' }],
        files: [{ id: 'f1', file_path: 'leads.csv', event_type: 'create' }],
        approvals: [],
    };
    const clone = (over: Partial<AgentTurn> = {}): AgentTurn => ({
        ...base,
        steps: base.steps.map(s => ({ ...s })),
        files: base.files.map(f => ({ ...f })),
        // Copied for the same reason as steps and files: the "rebuilt-but-identical"
        // case below is only meaningful if the clone shares no arrays with base.
        approvals: base.approvals.map(a => ({ ...a })),
        ...over,
    });

    const approval = (over: Partial<TurnApproval> = {}): TurnApproval => ({
        id: 'ev1', approvalId: 'ap1', action: 'click', description: 'Submit payment',
        createdAt: '2026-01-01T00:00:00Z', timeoutMs: 30 * 60 * 1000, ...over,
    });

    it('is true for a rebuilt-but-identical turn (the whole point)', () => {
        // buildTurns produces fresh objects every event; identical content must compare
        // equal or nothing is ever memoized.
        expect(turnsEqual(base, clone())).toBe(true);
    });

    it('is false when any rendered field changes', () => {
        expect(turnsEqual(base, clone({ key: 'k2' }))).toBe(false);
        expect(turnsEqual(base, clone({ active: true }))).toBe(false);
        expect(turnsEqual(base, clone({ text: 'other' }))).toBe(false);
        expect(turnsEqual(base, clone({ error: 'boom' }))).toBe(false);
        expect(turnsEqual(base, clone({ sender: '✍️ Writer' }))).toBe(false);
        expect(turnsEqual(base, clone({ source: 'whatsapp' }))).toBe(false);
        expect(turnsEqual(base, clone({ timestamp: '2026-01-02T00:00:00Z' }))).toBe(false);
        expect(turnsEqual(base, clone({ cycleId: 'c2' }))).toBe(false);
    });

    it('is false when a tool result fills in — the live-streaming case', () => {
        const pending = clone({ steps: [{ id: 's1', name: 'apollo', args: '{}', result: undefined }] });
        expect(turnsEqual(pending, base)).toBe(false);
    });

    it('is false when a step or file is appended', () => {
        expect(turnsEqual(base, clone({ steps: [...base.steps, { id: 's2', name: 'web_fetch', args: '{}' }] }))).toBe(false);
        expect(turnsEqual(base, clone({ files: [...base.files, { id: 'f2', file_path: 'b.csv', event_type: 'write' }] }))).toBe(false);
    });

    it('is false when an approval card appears', () => {
        expect(turnsEqual(base, clone({ approvals: [approval()] }))).toBe(false);
    });

    it('is false when a human answers — the case the card exists for', () => {
        // `decision` filling in is the only field that changes on an approval after it is
        // created. If this compares equal the card never re-renders and the operator
        // watches a live countdown on a request they already answered.
        const pending = clone({ approvals: [approval()] });
        const answered = clone({ approvals: [approval({ decision: 'approved' })] });
        expect(turnsEqual(pending, answered)).toBe(false);
    });

    it('is true for two identical approval lists', () => {
        expect(turnsEqual(clone({ approvals: [approval()] }), clone({ approvals: [approval()] }))).toBe(true);
    });

    it('distinguishes user turns by their own fields', () => {
        const u = { kind: 'user', key: 'u1', text: 'hi', source: 'dashboard', timestamp: 't' } as const;
        expect(turnsEqual(u, { ...u })).toBe(true);
        expect(turnsEqual(u, { ...u, text: 'bye' })).toBe(false);
        expect(turnsEqual(u, { ...u, source: 'whatsapp' })).toBe(false);
        expect(turnsEqual(u, { ...u, timestamp: 't2' })).toBe(false);
    });

    it('never equates a user turn with an agent turn', () => {
        expect(turnsEqual({ kind: 'user', key: 'k1', text: 'done' }, base)).toBe(false);
    });
});

describe('mergeBySeq', () => {
    it('appends a new seq and replaces an existing one', () => {
        reset();
        const a = ev({ type: 'user_msg', content: 'a' });
        const b = ev({ type: 'user_msg', content: 'b' });
        expect(mergeBySeq([a], b)).toHaveLength(2);

        const bUpdated = { ...b, content: 'b2' };
        const merged = mergeBySeq([a, b], bUpdated);
        expect(merged).toHaveLength(2);          // replaced, not duplicated
        expect(merged[1].content).toBe('b2');
    });
});
