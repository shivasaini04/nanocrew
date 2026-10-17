/**
 * Stage 35 — the live cursor: "you can never miss an event" (Phase 2 criterion 4).
 *
 * classifyLiveEvent + mergeBySeq are the whole reconnect/gap-heal story, extracted
 * from the hook so the load-bearing logic is tested directly rather than trusted.
 * Each test drives a scenario the doc names — ordered delivery, a re-delivered
 * event, a socket-drop gap, a reconnect — through the exact functions the hook runs.
 */
import { describe, it, expect } from 'vitest';
import { classifyLiveEvent, mergeBySeq, type ConversationEvent } from './conversation-turns';

function ev(seq: number, over: Partial<ConversationEvent> = {}): ConversationEvent {
    return { id: `e${seq}`, conversation: 'agent:a1', seq, type: 'agent_msg', created_at: '', ...over };
}

/**
 * A tiny model of the hook's live loop: it applies classifyLiveEvent + mergeBySeq
 * exactly as the hook does, and records when it would have triggered a backfill.
 * `backfill(afterSeq)` stands in for fetchFrom — returns the events the server would
 * send, which the model then folds in, mirroring the real refetch.
 */
function makeClient(backfill: (afterSeq: number) => ConversationEvent[]) {
    let events: ConversationEvent[] = [];
    let cursor = 0;
    const backfills: number[] = [];

    function apply(incoming: ConversationEvent) {
        switch (classifyLiveEvent(cursor, incoming.seq)) {
            case 'replace':
                events = mergeBySeq(events, incoming).sort((a, b) => a.seq - b.seq);
                break;
            case 'append':
                cursor = incoming.seq;
                events = mergeBySeq(events, incoming);
                break;
            case 'backfill': {
                backfills.push(cursor);
                const missed = backfill(cursor);
                events = missed.reduce(mergeBySeq, events).sort((a, b) => a.seq - b.seq);
                for (const e of missed) cursor = Math.max(cursor, e.seq);
                break;
            }
        }
    }
    return {
        apply,
        seed(initial: ConversationEvent[]) { events = initial.slice(); cursor = initial.reduce((m, e) => Math.max(m, e.seq), 0); },
        get seqs() { return events.map(e => e.seq); },
        get cursor() { return cursor; },
        get backfills() { return backfills; },
    };
}

describe('classifyLiveEvent', () => {
    it('appends only the exact next seq; older is replace, further is backfill', () => {
        expect(classifyLiveEvent(5, 6)).toBe('append');
        expect(classifyLiveEvent(5, 5)).toBe('replace');
        expect(classifyLiveEvent(5, 3)).toBe('replace');
        expect(classifyLiveEvent(5, 7)).toBe('backfill');
        expect(classifyLiveEvent(0, 1)).toBe('append');   // first event of a fresh log
        expect(classifyLiveEvent(0, 5)).toBe('backfill');  // joined a conversation mid-stream
    });
});

describe('live cursor loop', () => {
    it('appends a clean in-order stream, cursor tracking the head', () => {
        const c = makeClient(() => []);
        [1, 2, 3, 4].forEach(s => c.apply(ev(s)));
        expect(c.seqs).toEqual([1, 2, 3, 4]);
        expect(c.cursor).toBe(4);
        expect(c.backfills).toEqual([]);   // no gaps → no refetch
    });

    it('replaces a re-delivered event in place instead of duplicating', () => {
        const c = makeClient(() => []);
        c.apply(ev(1)); c.apply(ev(2, { content: 'first' }));
        c.apply(ev(2, { content: 'updated' }));   // same seq re-delivered
        expect(c.seqs).toEqual([1, 2]);            // not [1,2,2]
        expect(c.cursor).toBe(2);
    });

    it('heals a socket-drop gap by backfilling from the cursor — no missed events', () => {
        // Deliver 1,2 then jump to 5: 3 and 4 were dropped. The gap must be filled,
        // not stepped over. This is the exact "drop the socket mid-cycle" criterion.
        const server = [1, 2, 3, 4, 5].map(s => ev(s));
        const c = makeClient(afterSeq => server.filter(e => e.seq > afterSeq));
        c.apply(ev(1)); c.apply(ev(2));
        c.apply(ev(5));   // gap
        expect(c.backfills).toEqual([2]);          // refetched from the cursor, not 0
        expect(c.seqs).toEqual([1, 2, 3, 4, 5]);   // nothing missed, nothing duplicated
        expect(c.cursor).toBe(5);
    });

    it('does not duplicate when the backfill overlaps the live event that triggered it', () => {
        // The refetch returns 3,4,5 — including the very seq=5 that exposed the gap.
        const server = [1, 2, 3, 4, 5].map(s => ev(s));
        const c = makeClient(afterSeq => server.filter(e => e.seq > afterSeq));
        c.apply(ev(1)); c.apply(ev(2));
        c.apply(ev(5));
        // If seq 5 both backfilled AND appended, it'd appear twice. mergeBySeq prevents it.
        expect(c.seqs.filter(s => s === 5)).toEqual([5]);
    });

    it('reconnect re-syncs from the cursor and recovers everything sent while away', () => {
        // On reconnect the hook calls fetchFrom(cursor). Model that directly: after a
        // silent drop where 3-6 happened server-side, the resync fetch folds them in.
        const server = [1, 2, 3, 4, 5, 6].map(s => ev(s));
        const resyncFetch = (afterSeq: number) => server.filter(e => e.seq > afterSeq);
        const c = makeClient(resyncFetch);
        c.apply(ev(1)); c.apply(ev(2));   // then the socket silently drops

        // Reconnect: fetchFrom(cursor) → fold results, advance cursor (mirrors fetchFrom).
        const recovered = resyncFetch(c.cursor);
        c.seed([...[1, 2].map(s => ev(s)), ...recovered]);
        expect(c.seqs).toEqual([1, 2, 3, 4, 5, 6]);
        expect(c.cursor).toBe(6);
    });

    it('a fresh subscriber that joins mid-stream backfills its whole history', () => {
        const server = [1, 2, 3, 4].map(s => ev(s));
        const c = makeClient(afterSeq => server.filter(e => e.seq > afterSeq));
        c.apply(ev(4));   // first thing this client ever sees is seq 4
        expect(c.backfills).toEqual([0]);          // backfilled from the very start
        expect(c.seqs).toEqual([1, 2, 3, 4]);
    });
});
