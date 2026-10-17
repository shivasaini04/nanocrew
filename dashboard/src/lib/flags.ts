/**
 * Feature flags (Stage 35).
 *
 * `conversationEvents` switches the agent and project chats from the legacy
 * three-fetch read path (message history + per-cycle activity-trace + per-cycle
 * file-events, reconciled by hand) to the single conversation_events log.
 *
 * **On by default.** The parity gap that kept it off is closed: job cards, artifact
 * cards, file diffs, timestamps, avatars, the WhatsApp badge and plain-reply bubble
 * chrome are all rendered by delegating to the same components the legacy row used,
 * so the two can't drift. That list came from reading every branch of AgentChatRow,
 * BotTurn and ChatBubbleInner rather than from finding gaps one at a time.
 *
 * Known and accepted: a just-attached image no longer shows in its bubble. Images
 * were client-only optimistic state (agentsStore.ts) and were never persisted, so
 * they cannot come from a server-side log — on the legacy path they vanished on
 * reload anyway.
 *
 * The legacy path stays behind `?conv=0` for one deploy cycle as a rollback, then
 * both it and this flag go.
 *
 * Note this flag gates only the *rendering*. Everything the backend gained is live
 * regardless: a failed cycle is marked failed and posts a distinct "⚠️ Cycle failed"
 * message, which the legacy renderer also shows (its ack filter strips ⚙️/⌛, not ⚠️).
 *
 *   ?conv=1  → event stream (sticky, the default)
 *   ?conv=0  → legacy path (sticky)
 *
 * The value is read once at module load and persisted in localStorage, so changing it
 * needs a full page load. A browser that previously pinned ?conv=0 STAYS on the legacy
 * path until it visits ?conv=1 — flipping this default does not reset it.
 */
const KEY = 'nc.flag.conversationEvents';

function readFlag(): boolean {
    try {
        const q = new URLSearchParams(window.location.search).get('conv');
        if (q === '1' || q === '0') {
            localStorage.setItem(KEY, q);
            return q === '1';
        }
        // Default ON: only an explicit, previously-set '0' opts back into the legacy path.
        return localStorage.getItem(KEY) !== '0';
    } catch {
        // No localStorage (private mode) — take the new path; it's the supported one.
        return true;
    }
}

export const FLAGS = {
    /** Read the chats from the conversation_events stream (Stage 35). */
    conversationEvents: readFlag(),
};
