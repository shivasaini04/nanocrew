/**
 * Stage 49 phase 4 — knowing which agents have a browser open, app-wide.
 *
 * The live view has streamed since stage 44, but only AgentProfilePage listened, so a
 * running browser was invisible from anywhere else — including the sidebar and the
 * approval card, the two places you would notice it. That is how an operator came to
 * approve a click on a page nobody had seen a live cycle, 2026-09-02).
 *
 * The part worth testing is liveness, because it is inferred rather than announced:
 * there is no "browser closed" event, only frames arriving at ~2fps and then not.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useLiveBrowsersStore, isBrowserLive, STALE_AFTER_MS } from './liveBrowsersStore';

const frame = (dataUrl = 'data:image/jpeg;base64,AAAA') => ({ dataUrl, url: 'https://x.test/a', title: 'A' });

beforeEach(() => {
    useLiveBrowsersStore.setState({ byAgent: {}, waiting: {} });
});

describe('liveBrowsersStore', () => {
    it('records a frame against its agent', () => {
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame());
        expect(isBrowserLive(useLiveBrowsersStore.getState().byAgent, 'agent-1')).toBe(true);
    });

    it('keeps one frame per agent rather than a history', () => {
        // Frames are whole-page data URLs arriving twice a second. Accumulating them
        // would grow without bound for a picture whose only value is being current.
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame('data:image/jpeg;base64,FIRST'));
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame('data:image/jpeg;base64,SECOND'));
        expect(useLiveBrowsersStore.getState().byAgent['agent-1'].dataUrl).toContain('SECOND');
        expect(Object.keys(useLiveBrowsersStore.getState().byAgent)).toEqual(['agent-1']);
    });

    it('tracks several agents independently', () => {
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame());
        useLiveBrowsersStore.getState().noteFrame('agent-2', frame());
        const { byAgent } = useLiveBrowsersStore.getState();
        expect(isBrowserLive(byAgent, 'agent-1')).toBe(true);
        expect(isBrowserLive(byAgent, 'agent-2')).toBe(true);
        expect(isBrowserLive(byAgent, 'agent-3')).toBe(false);
    });

    it('treats silence as the browser having closed', () => {
        // The whole liveness model: no event says the browser stopped, so a gap is the
        // only signal. Correct by default when a cycle dies without saying goodbye.
        useLiveBrowsersStore.setState({
            byAgent: { 'agent-1': { ...frame(), at: Date.now() - (STALE_AFTER_MS + 1000) } },
        });
        expect(isBrowserLive(useLiveBrowsersStore.getState().byAgent, 'agent-1')).toBe(false);
    });

    it('sweeps out what has gone quiet and keeps what has not', () => {
        useLiveBrowsersStore.setState({
            byAgent: {
                stale: { ...frame(), at: Date.now() - (STALE_AFTER_MS + 1000) },
                fresh: { ...frame(), at: Date.now() },
            },
        });
        useLiveBrowsersStore.getState().sweep();
        expect(Object.keys(useLiveBrowsersStore.getState().byAgent)).toEqual(['fresh']);
    });

    it('returns the identical object when a sweep changes nothing', () => {
        // The sweep runs on a timer for the life of the session. Returning a new object
        // each tick would re-render every subscriber — the sidebar included — forever.
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame());
        const before = useLiveBrowsersStore.getState().byAgent;
        useLiveBrowsersStore.getState().sweep();
        expect(useLiveBrowsersStore.getState().byAgent).toBe(before);
    });

    it('clears an agent explicitly without waiting for the gap', () => {
        useLiveBrowsersStore.getState().noteFrame('agent-1', frame());
        useLiveBrowsersStore.getState().clear('agent-1');
        expect(isBrowserLive(useLiveBrowsersStore.getState().byAgent, 'agent-1')).toBe(false);
    });

    it('is safe with no agent id at all', () => {
        // A project chat renders the same approval card with no single agent behind it.
        expect(isBrowserLive({}, undefined)).toBe(false);
    });
});

describe('waiting on a human (phase 5.4/5.5)', () => {
    it('records what the agent stopped for', () => {
        useLiveBrowsersStore.getState().noteTakeover('agent-1', { cycleId: 'c1', reason: 'Solve the CAPTCHA' });
        expect(useLiveBrowsersStore.getState().waiting['agent-1']).toEqual({ cycleId: 'c1', reason: 'Solve the CAPTCHA' });
    });

    it('does NOT expire an ask the way it expires a frame', () => {
        // The distinction that matters. A frame going quiet means the browser stopped;
        // an ask going quiet means nothing — the run sits there for up to fifteen minutes
        // precisely because nobody has answered yet. Expiring it would take the request
        // off the screen while the agent is still waiting for it.
        useLiveBrowsersStore.setState({
            byAgent: { 'agent-1': { ...frame(), at: Date.now() } },
            waiting: { 'agent-1': { cycleId: 'c1', reason: 'Solve the CAPTCHA' } },
        });
        useLiveBrowsersStore.getState().sweep();
        expect(useLiveBrowsersStore.getState().waiting['agent-1']).toBeTruthy();
    });

    it('drops the ask once the browser itself has gone', () => {
        // Nothing left to take over, so the invitation would be to drive a page that is
        // not there any more.
        useLiveBrowsersStore.setState({
            byAgent: { 'agent-1': { ...frame(), at: Date.now() - (STALE_AFTER_MS + 1000) } },
            waiting: { 'agent-1': { cycleId: 'c1', reason: 'Solve the CAPTCHA' } },
        });
        useLiveBrowsersStore.getState().sweep();
        expect(useLiveBrowsersStore.getState().waiting['agent-1']).toBeUndefined();
    });

    it('clears the ask when the human hands back', () => {
        useLiveBrowsersStore.getState().noteTakeover('agent-1', { cycleId: 'c1', reason: 'x' });
        useLiveBrowsersStore.getState().clearTakeover('agent-1');
        expect(useLiveBrowsersStore.getState().waiting['agent-1']).toBeUndefined();
    });

    it('keeps one agent’s ask separate from another’s', () => {
        useLiveBrowsersStore.getState().noteTakeover('agent-1', { cycleId: 'c1', reason: 'one' });
        useLiveBrowsersStore.getState().noteTakeover('agent-2', { cycleId: 'c2', reason: 'two' });
        useLiveBrowsersStore.getState().clearTakeover('agent-1');
        expect(useLiveBrowsersStore.getState().waiting['agent-2']?.reason).toBe('two');
    });
});
