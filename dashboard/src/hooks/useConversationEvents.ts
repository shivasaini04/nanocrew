/**
 * useConversationEvents — the single read path for a conversation (Stage 35 Phase 2).
 *
 * Replaces the three independent fetches (message history + per-cycle activity-trace
 * + per-cycle file-events) and two socket channels the chat used to reconcile by
 * hand. There is one ordered log per conversation, so this hook only has to do two
 * things: read it, and stay caught up.
 *
 * Staying caught up is the whole trick, and `seq` makes it mechanical:
 *   - a live event whose seq is exactly lastSeq + 1 is appended;
 *   - a gap (seq > lastSeq + 1) means we missed something, so we refetch from
 *     `after_seq=lastSeq` and continue. A socket drop mid-cycle heals itself on the
 *     next event, and a reconnect re-syncs from the cursor.
 *   - a replay (seq <= lastSeq) replaces that event in place rather than appending,
 *     so a re-delivered event can't duplicate the timeline.
 *
 * The old code had no way to notice a missed event at all — which is half of why a
 * conversation could render as stale.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { socket } from '../lib/socket';
import { mergeBySeq, classifyLiveEvent, type ConversationEvent } from '../lib/conversation-turns';

export type { ConversationEvent } from '../lib/conversation-turns';

interface State {
    events: ConversationEvent[];
    loading: boolean;
    error: string | null;
    /** The conversation's true first seq — we've reached the start when our oldest === this. */
    tailSeq: number;
    loadingOlder: boolean;
}

const EMPTY: State = { events: [], loading: false, error: null, tailSeq: 0, loadingOlder: false };

export function useConversationEvents(conversation: string | null, enabled = true) {
    const [state, setState] = useState<State>({ ...EMPTY, loading: !!conversation });

    // The cursor. A ref, not state: the socket handler must read the current value
    // without being re-subscribed on every event.
    const lastSeqRef = useRef(0);
    const conversationRef = useRef(conversation);
    conversationRef.current = conversation;
    // Guards against two backfills racing and double-appending.
    const backfillingRef = useRef(false);

    const fetchFrom = useCallback(async (afterSeq: number) => {
        const conv = conversationRef.current;
        if (!conv) return;
        const res = await fetch(`/api/conversations/${encodeURIComponent(conv)}/events?after_seq=${afterSeq}`);
        if (!res.ok) throw new Error(`Failed to load conversation (${res.status})`);
        const body = await res.json() as { events: ConversationEvent[]; tail_seq?: number };
        const incoming = body.events ?? [];
        setState(prev => {
            // afterSeq === 0 is a full reload; anything else extends what we have.
            const base = afterSeq === 0 ? [] : prev.events;
            const merged = incoming.reduce(mergeBySeq, base);
            merged.sort((a, b) => a.seq - b.seq);
            return { ...prev, events: merged, loading: false, error: null, tailSeq: body.tail_seq ?? prev.tailSeq };
        });
        for (const e of incoming) lastSeqRef.current = Math.max(lastSeqRef.current, e.seq);
    }, []);

    /**
     * Load the page of history immediately before what we already hold.
     *
     * The initial read deliberately returns only the newest page — one conversation's
     * full history serialised to 241 MB, which is not something to hand a browser (or
     * stringify on a shared orchestrator). So older history is reachable, but only when
     * asked for. Prepending never disturbs the live cursor: it only ever adds events
     * BELOW our oldest, and lastSeqRef tracks the head.
     */
    const loadOlder = useCallback(async () => {
        const conv = conversationRef.current;
        if (!conv) return;
        const oldest = stateRef.current.events[0]?.seq;
        if (!oldest || oldest <= stateRef.current.tailSeq || stateRef.current.loadingOlder) return;

        setState(prev => ({ ...prev, loadingOlder: true }));
        try {
            const res = await fetch(`/api/conversations/${encodeURIComponent(conv)}/events?before_seq=${oldest}`);
            if (!res.ok) throw new Error(`Failed to load older messages (${res.status})`);
            const body = await res.json() as { events: ConversationEvent[]; tail_seq?: number };
            setState(prev => {
                const merged = (body.events ?? []).reduce(mergeBySeq, prev.events);
                merged.sort((a, b) => a.seq - b.seq);
                return { ...prev, events: merged, loadingOlder: false, tailSeq: body.tail_seq ?? prev.tailSeq };
            });
        } catch {
            setState(prev => ({ ...prev, loadingOlder: false }));
        }
    }, []);

    // Mirror state into a ref so loadOlder can read the current values without being
    // re-created on every event (which would make it an unstable prop and defeat the
    // memoized rows downstream).
    const stateRef = useRef(state);
    stateRef.current = state;

    // Initial load / conversation switch.
    useEffect(() => {
        if (!conversation || !enabled) {
            setState(EMPTY);
            return;
        }
        lastSeqRef.current = 0;
        setState({ ...EMPTY, loading: true });
        fetchFrom(0).catch(err => setState({ ...EMPTY, loading: false, error: String(err.message ?? err) }));
    }, [conversation, enabled, fetchFrom]);

    // Live tail.
    useEffect(() => {
        if (!conversation || !enabled) return;

        const onEvent = (ev: ConversationEvent) => {
            if (ev.conversation !== conversationRef.current) return;

            switch (classifyLiveEvent(lastSeqRef.current, ev.seq)) {
                case 'replace':
                    // Already seen (a tool_result filling in, say): update in place.
                    setState(prev => ({ ...prev, events: mergeBySeq(prev.events, ev).sort((a, b) => a.seq - b.seq) }));
                    return;
                case 'append':
                    // The next event in order — the only branch that advances the cursor.
                    lastSeqRef.current = ev.seq;
                    setState(prev => ({ ...prev, events: mergeBySeq(prev.events, ev) }));
                    return;
                case 'backfill':
                    // A gap: we missed events (socket drop, tab asleep). Refetch from
                    // the cursor rather than appending out of order and rendering a hole.
                    if (!backfillingRef.current) {
                        backfillingRef.current = true;
                        fetchFrom(lastSeqRef.current)
                            .catch(() => { /* next event triggers another attempt */ })
                            .finally(() => { backfillingRef.current = false; });
                    }
                    return;
            }
        };

        // A reconnect may have missed events entirely; re-sync from the cursor.
        const onConnect = () => { fetchFrom(lastSeqRef.current).catch(() => { /* retried on next event */ }); };

        socket.on('conversation:event', onEvent);
        socket.on('connect', onConnect);
        return () => {
            socket.off('conversation:event', onEvent);
            socket.off('connect', onConnect);
        };
    }, [conversation, enabled, fetchFrom]);

    return {
        events: state.events,
        loading: state.loading,
        error: state.error,
        loadingOlder: state.loadingOlder,
        /** False once the oldest event we hold is the conversation's first. */
        hasOlder: state.events.length > 0 && state.events[0].seq > state.tailSeq,
        loadOlder,
        reload: () => fetchFrom(0),
    };
}
