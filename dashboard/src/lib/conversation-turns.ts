/**
 * Folding the conversation event log into renderable turns (Stage 35 Phase 2).
 *
 * Deliberately free of React and of any import with a runtime cost, so the logic
 * that decides "what happened in this conversation, in what order" is testable on
 * its own. That logic is where the old architecture's bugs lived, so it is the part
 * that most needs tests:
 *   - grouping is by cycle_id, ordering by seq — both facts in the data, not
 *     inferred by matching a message id against a live trace ref;
 *   - an error is its own turn state, so it can never render as a normal reply or
 *     as nothing at all.
 */

export type ConversationEventType =
    | 'user_msg' | 'agent_msg' | 'thinking' | 'tool_call' | 'tool_result'
    | 'file_change' | 'error' | 'cycle_start' | 'cycle_end'
    | 'approval_request';

/** `metadata` of an approval_request event — mirrors ApprovalRequestMeta on the server. */
export interface ApprovalRequestMeta {
    approval_id: string;
    action: string;
    target?: string;
    url?: string;
    element?: string;
    run_id?: string;
    timeout_ms: number;
    decision?: 'approved' | 'denied' | 'expired';
    decided_at?: string;
}

/** A mid-cycle approval gate, as the turn renders it. */
export interface TurnApproval {
    /** The conversation event's id — the React key, stable across the in-place update. */
    id: string;
    approvalId: string;
    action: string;
    target?: string;
    url?: string;
    element?: string;
    description: string;
    createdAt: string;
    timeoutMs: number;
    decision?: 'approved' | 'denied' | 'expired';
}

export interface ConversationEvent {
    id: string;
    conversation: string;
    seq: number;
    cycle_id?: string | null;
    type: ConversationEventType;
    role?: 'user' | 'assistant' | 'system' | null;
    content?: string | null;
    tool_name?: string | null;
    tool_input?: string | null;
    tool_output?: string | null;
    file_path?: string | null;
    diff_patch?: string | null;
    status?: 'ok' | 'error' | 'interrupted' | null;
    metadata?: string | null;
    created_at: string;
}

/** A step as CycleTimeline consumes it. */
export interface TurnStep {
    id?: string;
    name: string;
    args: string;
    result?: string;
}

export interface UserTurn { kind: 'user'; key: string; text: string; source?: string; timestamp?: string }
export interface AgentTurn {
    kind: 'agent';
    key: string;
    cycleId: string | null;
    steps: TurnStep[];
    /** Shaped for TurnFileChanges, which renders these directly — no fetch needed,
     *  because the event log already carries the diff. */
    files: Array<{ id: string; file_path: string; event_type: 'read' | 'write' | 'create' | 'delete'; diff_patch?: string }>;
    text?: string;
    error?: string;
    /**
     * Display name of the agent that produced this turn, e.g. "🧑‍💼 Recruiter",
     * when the events carry one. A project thread has a whole team in it, so the
     * turn — not the page — has to say who is speaking.
     */
    sender?: string;
    /** Channel the turn came in over (e.g. 'whatsapp') — badged in the UI. */
    source?: string;
    /** When the turn closed (its last event's created_at) — job cards show a time. */
    timestamp?: string;
    /** The cycle is still going: no closing answer or error has arrived. */
    active: boolean;
    /**
     * Mid-cycle approval gates raised during this turn, in order.
     *
     * Kept off `steps` deliberately: a step is a thing the agent did, whereas this
     * is a thing it is waiting on the human for — it needs buttons, a countdown and
     * a verdict, none of which the timeline's step renderer has any notion of.
     */
    approvals: TurnApproval[];
}
export type Turn = UserTurn | AgentTurn;

/**
 * Merge an event into an ordered list, REPLACING a same-seq entry rather than
 * appending. `seq` is the identity of a position in the log, so a re-delivered
 * event (a tool_result filling in, a backfill overlapping the live tail) updates
 * that slot instead of duplicating the timeline.
 */
export function mergeBySeq(events: ConversationEvent[], incoming: ConversationEvent): ConversationEvent[] {
    const at = events.findIndex(e => e.seq === incoming.seq);
    if (at >= 0) {
        const next = events.slice();
        next[at] = incoming;
        return next;
    }
    return [...events, incoming];
}

/**
 * What to do with a live event given the cursor (the highest contiguous seq we've
 * rendered). This is the load-bearing "you can't miss an event" decision, pulled
 * out of the hook's effect so it can be tested without React or a socket:
 *
 *   - 'replace'  seq <= cursor. Already rendered; a re-delivered/updated event
 *                (a tool_result filling in, a backfill overlapping the tail).
 *                Update in place — appending would duplicate it.
 *   - 'append'   seq === cursor + 1. The next event in order; the common case.
 *   - 'backfill' seq  >  cursor + 1. We missed something (socket drop, sleeping
 *                tab). Refetch from the cursor rather than leaving a hole.
 *
 * The invariant that makes the stream gapless: 'append' is the ONLY branch that
 * advances the cursor, so a gap can never be silently stepped over.
 */
export type LiveEventAction = 'replace' | 'append' | 'backfill';

export function classifyLiveEvent(cursor: number, incomingSeq: number): LiveEventAction {
    if (incomingSeq <= cursor) return 'replace';
    if (incomingSeq === cursor + 1) return 'append';
    return 'backfill';
}

// Internal bookkeeping the agent maintains for itself (telemetry logs, memory
// consolidation, identity/self-improve state, bytecode/test caches) — never work
// product a user asked for. Ported from TurnFileChanges, which owned this rule on
// the legacy path and is going away; this is now the one definition.
//
// `sessions/` is added to the list: it holds the agent's own conversation
// transcripts, which is exactly the "bookkeeping it keeps for itself" this list
// targets, and it's rewritten on EVERY cycle — so without it, every single turn
// reports a file change the user didn't ask for. Its absence looks like an
// oversight rather than intent, but flagging it here since it's a deliberate
// departure from what the old component showed.
const NOISE_PATH_PREFIXES = [
    '.nanocrew/', 'memory/', 'sessions/', '__pycache__/', '.pytest_cache/',
    '.git/', 'node_modules/', '.venv/', 'venv/',
];
const NOISE_EXACT_PATHS = new Set(['activity.json']);

export function isNoiseFilePath(p: string): boolean {
    if (NOISE_EXACT_PATHS.has(p)) return true;
    if (p.endsWith('.pyc')) return true;
    return NOISE_PATH_PREFIXES.some(prefix => p.startsWith(prefix) || p.includes('/' + prefix));
}

/**
 * Do two turns render identically?
 *
 * buildTurns rebuilds every turn from scratch on each event, so turn objects never
 * keep their identity and a plain React.memo can't help: one incoming event would
 * re-render — and re-parse the markdown of — every turn in the thread. This compares
 * CONTENT instead, so only the turn that actually changed re-renders.
 *
 * A comparator that returns true when something did change means stale UI, so this
 * must cover every field the renderer reads. It's exhaustively tested for exactly
 * that reason; if you add a field to a Turn that affects rendering, add it here and
 * add a case to conversation-turns.test.ts.
 *
 * Fields deliberately not compared: a step's `name`/`args` and a file's `diff_patch`
 * are fixed when the row is created (only `result` fills in later), so identity by
 * `id` covers them.
 */
export function turnsEqual(a: Turn, b: Turn): boolean {
    if (a.kind !== b.kind || a.key !== b.key) return false;

    if (a.kind === 'user') {
        const y = b as UserTurn;
        return a.text === y.text && a.source === y.source && a.timestamp === y.timestamp;
    }

    const x = a as AgentTurn;
    const y = b as AgentTurn;
    if (x.active !== y.active) return false;
    if (x.text !== y.text || x.error !== y.error) return false;
    if (x.sender !== y.sender || x.source !== y.source || x.timestamp !== y.timestamp) return false;
    if (x.cycleId !== y.cycleId) return false;
    if (x.steps.length !== y.steps.length || x.files.length !== y.files.length) return false;
    // `decision` fills in when a human answers — the one field that changes on an
    // approval after it is created, and the whole point of re-rendering the card.
    // Defaulted rather than dereferenced directly: a turn built before this field
    // existed (or by a caller constructing the shape by hand) must compare as
    // approval-free, not throw.
    const xa = x.approvals ?? [];
    const ya = y.approvals ?? [];
    if (xa.length !== ya.length) return false;
    for (let i = 0; i < xa.length; i++) {
        if (xa[i].id !== ya[i].id) return false;
        if (xa[i].decision !== ya[i].decision) return false;
    }
    for (let i = 0; i < x.steps.length; i++) {
        // `result` is the one field that fills in after a step is created.
        if (x.steps[i].id !== y.steps[i].id || x.steps[i].result !== y.steps[i].result) return false;
    }
    for (let i = 0; i < x.files.length; i++) {
        if (x.files[i].id !== y.files[i].id) return false;
    }
    return true;
}

export function eventMeta(e: ConversationEvent): Record<string, unknown> {
    try { return e.metadata ? JSON.parse(e.metadata) : {}; } catch { return {}; }
}

/**
 * The "_⚙️ Running … cycle…_" bookkeeping marker.
 *
 * The old page identified these by regex-matching the message text against five
 * patterns (`/^On it\b/`, `/^(⚙️|⌛)/`, …) — a guess about prose. The event carries
 * `metadata.kind`, so we can just ask.
 */
export function isAckMarker(e: ConversationEvent): boolean {
    return e.type === 'agent_msg' && eventMeta(e).kind === 'start';
}

export function buildTurns(events: ConversationEvent[]): Turn[] {
    const turns: Turn[] = [];
    let current: AgentTurn | null = null;

    // Tool calls awaiting a result, keyed by call_id, so a result attaches to the
    // call it belongs to rather than to whichever call happened to be last. (The
    // adapter dispatches tools concurrently, so completion order is not call order.)
    let pending = new Map<string, TurnStep>();

    const close = () => { current = null; pending = new Map(); };

    for (const e of events) {
        if (e.type === 'user_msg') {
            close();
            turns.push({ kind: 'user', key: e.id, text: e.content ?? '', source: eventMeta(e).source as string | undefined, timestamp: e.created_at });
            continue;
        }
        const cycleId = e.cycle_id ?? null;
        if (!current || current.cycleId !== cycleId) {
            close();
            current = { kind: 'agent', key: e.id, cycleId, steps: [], files: [], approvals: [], active: true };
            turns.push(current);
        }

        // Any event may name its author; the start marker does, which is why the ack
        // is harvested before being dropped — it's the FIRST event of the turn, so a
        // project thread can attribute a turn from the moment it begins rather than
        // waiting for the closing reply to say who was speaking.
        const sender = eventMeta(e).sender;
        if (typeof sender === 'string' && sender.trim()) current.sender ??= sender;
        const src = eventMeta(e).source;
        if (typeof src === 'string' && src) current.source ??= src;
        current.timestamp = e.created_at;   // last event wins — when the turn last moved

        if (isAckMarker(e)) continue;

        switch (e.type) {
            case 'thinking':
                current.steps.push({ id: e.id, name: 'thinking', args: '', result: e.content ?? '' });
                break;
            case 'tool_call': {
                const step: TurnStep = { id: e.id, name: e.tool_name ?? 'tool', args: e.tool_input ?? '{}' };
                current.steps.push(step);
                const callId = eventMeta(e).call_id as string | undefined;
                if (callId) pending.set(callId, step);
                break;
            }
            case 'tool_result': {
                const callId = eventMeta(e).call_id as string | undefined;
                const step = callId ? pending.get(callId) : undefined;
                if (step) {
                    step.result = e.tool_output ?? '';
                    if (callId) pending.delete(callId);
                } else {
                    // No matching call (history truncated mid-cycle, say) — surface the
                    // result rather than silently dropping it.
                    current.steps.push({ id: e.id, name: e.tool_name ?? 'tool', args: '{}', result: e.tool_output ?? '' });
                }
                break;
            }
            case 'file_change': {
                // A read isn't a change, and internal bookkeeping isn't work product —
                // both are dropped, matching what the legacy widget showed. The events
                // stay in the log either way; this is a display decision, not a write
                // one, so the audit trail keeps everything.
                const fpath = e.file_path ?? '';
                const etype = ((eventMeta(e).event_type as string) ?? 'write') as 'read' | 'write' | 'create' | 'delete';
                if (etype !== 'read' && !isNoiseFilePath(fpath)) {
                    current.files.push({
                        id: e.id, file_path: fpath, event_type: etype,
                        diff_patch: e.diff_patch ?? undefined,
                    });
                }
                break;
            }
            case 'approval_request': {
                const m = eventMeta(e) as unknown as ApprovalRequestMeta;
                if (!m?.approval_id) break;
                const approval: TurnApproval = {
                    id: e.id,
                    approvalId: m.approval_id,
                    action: m.action,
                    target: m.target,
                    url: m.url,
                    element: m.element,
                    description: e.content ?? `${m.action} ${m.target ?? m.url ?? ''}`.trim(),
                    createdAt: e.created_at,
                    timeoutMs: m.timeout_ms,
                    decision: m.decision,
                };
                // The settled event arrives under the same id as the ask (the server
                // re-appends to update in place), so replace rather than push —
                // otherwise the resolved card would render a second time below the
                // pending one.
                const at = current.approvals.findIndex(a => a.approvalId === approval.approvalId);
                if (at >= 0) current.approvals[at] = approval;
                else current.approvals.push(approval);
                break;
            }
            case 'agent_msg':
                current.text = e.content ?? '';
                current.active = false;
                break;
            case 'error':
                current.error = e.content ?? 'This turn failed.';
                current.active = false;
                break;
            case 'cycle_end':
                current.active = false;
                break;
            default:
                break;
        }
    }

    // The last thinking step of a settled turn is the model's pre-answer reasoning
    // that BECAME the answer — the runner builds the reply out of it (extractReply
    // strips the <summary>/<tasks_done> trailer off the same text). Rendering both
    // prints the answer twice, and the raw thinking still carries that trailer, so
    // the duplicate also trails a stray tasks_done number.
    //
    // Both legacy renderers drop it, and only once the turn has settled: while a
    // cycle is still running the thinking IS the live content and has to stay. A turn
    // that settled without an answer (an error, say) keeps it too — it's all there is.
    for (const t of turns) {
        if (t.kind !== 'agent' || t.active || !t.text) continue;
        const last = t.steps[t.steps.length - 1];
        if (last && last.name === 'thinking') t.steps.pop();
    }

    return turns;
}
