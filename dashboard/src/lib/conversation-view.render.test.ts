/**
 * Stage 35 — ConversationView actually renders (Phase 2/3 verification).
 *
 * Server-rendered, not a browser: this proves the component tree executes and puts
 * the right things on the page, which is the half of "does it work" that unit tests
 * on the fold can't reach. Layout/CSS still needs a real browser.
 *
 * Written with React.createElement rather than JSX so it runs under the backend's
 * vitest (which has no React/JSX plugin configured) — the dashboard has no test
 * runner of its own.
 *
 * The load-bearing assertion is the failure one: a turn that errored must render as
 * a visibly distinct thing, and must NOT render the previous reply's text. That is
 * the launch-day bug, checked at the level the user actually experiences it.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { ConversationEvent } from './conversation-turns';

// ConversationView → ChatBubble → lib/socket, which opens a socket.io connection
// against window.location at module load. There's no window here (and a server render
// wants no socket anyway), so stub the module.
vi.mock('./socket', () => ({
    socket: { on: () => {}, off: () => {}, emit: () => {} },
    connectSocket: () => ({}),
    getSocket: () => null,
}));

const { ConversationView } = await import('../components/ConversationView');

let seq = 0;
function ev(partial: Partial<ConversationEvent> & { type: ConversationEvent['type'] }): ConversationEvent {
    seq += 1;
    return { id: `e${seq}`, conversation: 'agent:a1', seq, created_at: '2026-07-16T00:00:00Z', ...partial };
}
// Inside a router, as it always is in the app: the artifact card opens pages with an
// in-app navigation, never a new window (see ChatBubble's ArtifactCard).
function render(events: ConversationEvent[], props: Record<string, unknown> = {}): string {
    return renderToStaticMarkup(
        createElement(MemoryRouter, null,
            createElement(ConversationView, { events, agentColor: '#c2410c', agentName: 'Recruiter', agentEmoji: '🧑‍💼', ...props } as never),
        ),
    );
}

describe('ConversationView rendering', () => {
    it('renders a user turn and an agent reply', () => {
        seq = 0;
        const html = render([
            ev({ type: 'user_msg', content: 'find me candidates' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Found 12 candidates.', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).toContain('find me candidates');
        expect(html).toContain('Found 12 candidates.');
        expect(html).toContain('Recruiter');
    });

    it('renders a failed turn as a distinct error, not as the previous reply', () => {
        seq = 0;
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Just need the website URL.', metadata: '{"kind":"result"}' }),
            ev({ type: 'user_msg', content: 'any update on the candidates?' }),
            ev({ type: 'error', cycle_id: 'c2', status: 'error', content: '_⚠️ Cycle failed: Authentication Fails_', metadata: '{"kind":"fail"}' }),
        ]);
        // The failure is on screen, labelled, with its cause.
        expect(html).toContain('This turn failed');
        expect(html).toContain('Authentication Fails');
        // And the launch-day symptom is absent: the previous reply is not the last
        // thing rendered — the error is.
        expect(html.lastIndexOf('This turn failed')).toBeGreaterThan(html.lastIndexOf('Just need the website URL.'));
    });

    it('renders tool calls inline with the reply', () => {
        seq = 0;
        const html = render([
            ev({ type: 'thinking', cycle_id: 'c1', content: 'planning the search' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo_search', tool_input: '{"q":"devs"}', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_output: '12 leads', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Found 12.', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).toContain('apollo search');   // CycleTimeline humanises the name
        expect(html).toContain('Found 12.');
    });

    it('labels a failed READ as a load failure, not as a failed turn', () => {
        // Three states that must never be confused: the agent errored, the fetch
        // errored, and nothing has happened yet. The read failure says so in its own
        // words — it is not the agent's fault and must not read as though it were.
        // (Rendered markup escapes the apostrophe, hence the split assertions.)
        const html = render([], { error: 'network down' });
        expect(html).toContain('load this conversation');
        expect(html).toContain('network down');
        expect(html).not.toContain('This turn failed');
    });

    it('distinguishes loading and empty from each other', () => {
        expect(render([], { loading: true })).toContain('Loading conversation');
        expect(render([])).toContain('No messages yet');
    });

    it('hides internal bookkeeping but shows real work product', () => {
        seq = 0;
        const html = render([
            ev({ type: 'file_change', cycle_id: 'c1', file_path: '.nanocrew/telemetry/x.jsonl', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'memory/memories.jsonl', metadata: '{"event_type":"write"}' }),
            ev({ type: 'file_change', cycle_id: 'c1', file_path: 'leads.csv', metadata: '{"event_type":"create"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'done', metadata: '{"kind":"result"}' }),
        ]);
        // Three file events in, ONE counted: the other two are the agent's own
        // bookkeeping. (The widget is collapsed by default — matching the legacy row —
        // so the filename itself is behind the expand toggle, not in the static markup.)
        expect(html).toContain('1 file changed');
        expect(html).not.toContain('telemetry');
    });

    it('shows a turn\'s file changes with no fetch — the diff is already in the log', () => {
        seq = 0;
        // TurnFileChanges used to fetch per cycle and cache the result forever. Handed
        // the events, it renders the same widget with no request at all.
        const html = render([
            ev({
                type: 'file_change', cycle_id: 'c1', file_path: 'leads.csv',
                diff_patch: '--- a/leads.csv\n+++ b/leads.csv\n@@ -1,1 +1,2 @@\n a\n+b\n',
                metadata: '{"event_type":"write"}',
            }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'done', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).toContain('1 file changed');
        expect(html).toContain('+1');   // the diff's line count, straight from the event
    });

    it('attributes turns to their own agent in a multi-agent thread', () => {
        seq = 0;
        // The sender arrives as one "<emoji> <name>" string; the emoji goes to the
        // avatar and the name to the name row, matching the legacy layout.
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'sourced', metadata: '{"kind":"result","sender":"🧑‍💼 Recruiter"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c2', content: 'drafted', metadata: '{"kind":"result","sender":"✍️ Writer"}' }),
        ], { agentName: 'Crew' });
        expect(html).toContain('Recruiter');
        expect(html).toContain('🧑‍💼');
        expect(html).toContain('Writer');
        expect(html).toContain('✍️');
    });

    it('renders a job reply as a job card, never as raw marker text', () => {
        seq = 0;
        // Parity with the legacy chat row. Without the delegation this renders the
        // literal string "[job-pending:job-abc]" to the user.
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: '⚡ Spawned a background job.\n[job-pending:job-abc]', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).not.toContain('[job-pending:job-abc]');
    });

    it('renders a completed-job reply as a card, stripping the id marker', () => {
        seq = 0;
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: '✅ Job complete — "research task"\n[job-id:job-xyz]\nHere is the result.', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).not.toContain('[job-id:job-xyz]');
        expect(html).toContain('research task');
    });

    it('surfaces an HTML artifact written by a turn as a card', () => {
        seq = 0;
        const page = '<!DOCTYPE html><html><head><title>Sales Report</title></head><body>hi</body></html>';
        const html = render([
            ev({
                type: 'tool_call', cycle_id: 'c1', tool_name: 'write_file',
                tool_input: JSON.stringify({ path: 'report.html', content: page }),
                metadata: '{"call_id":"t1"}',
            }),
            ev({ type: 'tool_result', cycle_id: 'c1', tool_output: 'ok', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Wrote the report.', metadata: '{"kind":"result"}' }),
        ]);
        // The card names the artifact by its <title>.
        expect(html).toContain('Sales Report');
        expect(html).toContain('Wrote the report.');
    });

    it('does not mistake ordinary prose for a job or an artifact', () => {
        seq = 0;
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'I finished the job you asked about.', metadata: '{"kind":"result"}' }),
        ]);
        expect(html).toContain('I finished the job you asked about.');
    });

    it('shows a timestamp on settled turns, and none while one is running', () => {
        seq = 0;
        const done = render([ev({ type: 'agent_msg', cycle_id: 'c1', content: 'done', metadata: '{"kind":"result"}' })]);
        expect(done).toMatch(/\d{1,2}:\d{2}/);
        seq = 0;
        const running = render([ev({ type: 'tool_call', cycle_id: 'c1', tool_name: 'apollo' })]);
        expect(running).not.toMatch(/\d{1,2}:\d{2}\s*(AM|PM)?<\/span>/);
    });

    it('badges a turn that arrived over WhatsApp', () => {
        seq = 0;
        const html = render([
            ev({ type: 'user_msg', content: 'hi from my phone', metadata: '{"source":"whatsapp"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'replied', metadata: '{"kind":"result","source":"whatsapp"}' }),
        ]);
        expect((html.match(/>WA</g) ?? []).length).toBe(2);   // both sides badged
    });

    it('does not badge a dashboard turn', () => {
        seq = 0;
        const html = render([ev({ type: 'user_msg', content: 'hi', metadata: '{"source":"dashboard"}' })]);
        expect(html).not.toContain('>WA<');
    });

    it('gives a plain reply bubble chrome, not a one-node timeline', () => {
        seq = 0;
        // A turn that did no work shouldn't render the timeline's vertical rule — that
        // reads as "here is the work I did".
        const plain = render([ev({ type: 'agent_msg', cycle_id: 'c1', content: 'Just a reply.', metadata: '{"kind":"result"}' })]);
        expect(plain).toContain('Just a reply.');
        expect(plain).not.toContain('border-left');

        seq = 0;
        const cycle = render([
            ev({ type: 'tool_call', cycle_id: 'c2', tool_name: 'apollo', metadata: '{"call_id":"t1"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c2', content: 'Did work.', metadata: '{"kind":"result"}' }),
        ]);
        expect(cycle).toContain('border-left');   // the timeline's rule
    });

    it('gives each turn its own avatar emoji in a multi-agent thread', () => {
        seq = 0;
        const html = render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: 'a', metadata: '{"kind":"result","sender":"🎯 Strategist"}' }),
            ev({ type: 'agent_msg', cycle_id: 'c2', content: 'b', metadata: '{"kind":"result","sender":"🔍 Researcher"}' }),
        ], { agentName: 'Crew', agentEmoji: '🤖' });
        expect(html).toContain('🎯');
        expect(html).toContain('🔍');
        expect(html).toContain('Strategist');
        expect(html).toContain('Researcher');
        expect(html).not.toContain('🤖');   // the page-level fallback isn't used
    });

    it('renders malformed events without crashing', () => {
        seq = 0;
        expect(() => render([
            ev({ type: 'agent_msg', cycle_id: 'c1', content: null, metadata: 'not json{' }),
            ev({ type: 'tool_call', cycle_id: 'c1', tool_name: null, tool_input: 'not json' }),
            ev({ type: 'error', cycle_id: 'c1', content: null }),
        ])).not.toThrow();
    });
});
