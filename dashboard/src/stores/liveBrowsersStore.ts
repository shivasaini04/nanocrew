import { create } from 'zustand';

/**
 * Which agents have a browser open right now, app-wide (stage 49 phase 4).
 *
 * The live view has worked since stage 44 — CDP screencast → `chat:frame` → the
 * dashboard — but only `AgentProfilePage` ever listened, so you could see it only by
 * already sitting on that agent's chat tab at the moment it ran. Nothing anywhere said
 * "a browser is open, come and look". browser-use has an icon that tells you; we had
 * the stream and no doorbell.
 *
 * This is the doorbell, and it deliberately adds no new backend signal: the same frames
 * that already arrive are recorded here once, app-level, and read by the sidebar (a
 * "watchable now" dot) and by the approval card (the page you are being asked to
 * approve a click on).
 *
 * **Liveness is inferred from silence.** Frames arrive at ~2fps while a browser is
 * open, so a gap of `STALE_AFTER_MS` means it has stopped — no "browser closed" event
 * to add, and correct by default if a cycle dies without saying goodbye. Being wrong
 * here is cheap and self-correcting: the worst case is a dot that lingers a few seconds.
 *
 * Exactly one frame is kept per agent and overwritten in place. Frames are data URLs of
 * a whole page; keeping a history would grow without bound for a picture whose only
 * value is being current.
 */

export interface LiveBrowser {
    dataUrl: string;
    url: string;
    title: string;
    cycleId?: string;
    /** `Date.now()` of the most recent frame — the whole basis for liveness. */
    at: number;
}

/** A browser that has sent nothing for this long is treated as closed. */
export const STALE_AFTER_MS = 6000;

/** A run that has stopped and is asking a person to do something (phase 5.4/5.5). */
export interface TakeoverAsk {
    cycleId: string;
    reason: string;
}

interface LiveBrowsersState {
    byAgent: Record<string, LiveBrowser>;
    /**
     * Which agents are waiting on a human, and what for.
     *
     * Deliberately NOT expired on silence the way a frame is. A frame going quiet means
     * the browser stopped; an ask going quiet means nothing at all — the run sits there
     * for up to fifteen minutes precisely because nobody has answered yet. It is cleared
     * when the human hands back, or when the browser goes away entirely.
     */
    waiting: Record<string, TakeoverAsk>;
    noteFrame: (agentId: string, frame: Omit<LiveBrowser, 'at'>) => void;
    noteTakeover: (agentId: string, ask: TakeoverAsk) => void;
    clearTakeover: (agentId: string) => void;
    /** Drop one agent explicitly — the cycle said it was done, so don't wait for silence. */
    clear: (agentId: string) => void;
    /** Remove anything that has gone quiet. Called on a timer by the app-level watcher. */
    sweep: (now?: number) => void;
}

export const useLiveBrowsersStore = create<LiveBrowsersState>((set) => ({
    byAgent: {},
    waiting: {},

    noteTakeover: (agentId, ask) => set((state) => ({
        waiting: { ...state.waiting, [agentId]: ask },
    })),

    clearTakeover: (agentId) => set((state) => {
        if (!state.waiting[agentId]) return state;
        const next = { ...state.waiting };
        delete next[agentId];
        return { waiting: next };
    }),

    noteFrame: (agentId, frame) => set((state) => ({
        byAgent: {
            ...state.byAgent,
            [agentId]: { ...frame, at: Date.now() },
        },
    })),

    clear: (agentId) => set((state) => {
        if (!state.byAgent[agentId]) return state;
        const next = { ...state.byAgent };
        delete next[agentId];
        return { byAgent: next };
    }),

    sweep: (now = Date.now()) => set((state) => {
        const live = Object.entries(state.byAgent).filter(([, f]) => now - f.at < STALE_AFTER_MS);
        // Same length means nothing expired — return the existing object rather than a
        // new one, so subscribers don't re-render on every tick of the sweep timer.
        if (live.length === Object.keys(state.byAgent).length) return state;
        // A browser that has gone means there is nothing left to take over, so an ask
        // that outlived it would be an invitation to drive a page that is not there.
        const stillLive = new Set(live.map(([agentId]) => agentId));
        const waiting = Object.fromEntries(
            Object.entries(state.waiting).filter(([agentId]) => stillLive.has(agentId)),
        );
        return { byAgent: Object.fromEntries(live), waiting };
    }),
}));

/** Is this agent's browser open right now? Safe to call with undefined. */
export function isBrowserLive(byAgent: Record<string, LiveBrowser>, agentId?: string, now = Date.now()): boolean {
    if (!agentId) return false;
    const frame = byAgent[agentId];
    return !!frame && now - frame.at < STALE_AFTER_MS;
}
