/**
 * ConversationView — renders a conversation from the one ordered event log
 * (Stage 35 Phase 2).
 *
 * Everything here is a pure function of `events`. Live and reload feed this the
 * same shape from the same source, so the two cannot disagree — which is the point.
 *
 * What this component does NOT do, and used to have to:
 *   - fetch anything (the hook owns the one read; there are no per-cycle fetches,
 *     no module-level caches, no cache-a-failure-forever),
 *   - guess which tool trace belongs to which message (events carry cycle_id, and
 *     `seq` fixes the order — no `liveStepsRef` inheritance heuristic),
 *   - regex chat text to decide what's an ack marker (metadata.kind says so),
 *   - render a failure as a normal reply (an error is its own event type).
 */
import React from 'react';
import type { Components } from 'react-markdown';
import { CR, withAlpha } from '../lib/cr';
import { CycleTimeline } from './CycleTimeline';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatBubble, ArtifactCard, detectTurnArtifact, WaSourceBadge } from './ChatBubble';
import { TurnFileChanges } from './TurnFileChanges';
import { buildTurns, turnsEqual, type AgentTurn, type Turn, type ConversationEvent, type TurnApproval } from '../lib/conversation-turns';
import { useLiveBrowsersStore } from '../stores/liveBrowsersStore';

/** A turn whose reply is really a background-job card rather than prose. */
const JOB_MARKER = /\[job-(?:pending|id):/;

// A turn's sender arrives as one string ("🧑‍💼 Recruiter") because that's how
// _emitCycleChat composes it. The avatar wants the emoji and the name row wants the
// name, so split on the first space — the same shape parseSenderName expects.
function senderEmoji(sender?: string): string | undefined {
    const first = sender?.trim().split(/\s+/)[0];
    // Only treat it as an emoji if it isn't ordinary word characters.
    return first && !/^[\w'"-]+$/.test(first) ? first : undefined;
}
function senderName(sender?: string): string | undefined {
    if (!sender?.trim()) return undefined;
    const parts = sender.trim().split(/\s+/);
    return senderEmoji(sender) ? parts.slice(1).join(' ') || sender : sender;
}

/**
 * The distinct, unmissable failure state — the reason this stage exists.
 *
 * `title` is not decoration: "this turn failed" and "we couldn't load this
 * conversation" are different facts about different things (the agent vs the
 * network), and a reader who can't tell them apart can't tell whether their agent
 * is broken. Conflating states is the bug class this whole stage is about, so the
 * label has to say which one this is.
 */
function ErrorBlock({ text, title = 'This turn failed' }: { text: string; title?: string }) {
    return (
        <div style={{
            marginTop: 8, padding: '10px 12px', borderRadius: 8,
            border: '1px solid var(--cr-error-line)', background: 'var(--cr-error-low)',
            display: 'flex', gap: 9, alignItems: 'flex-start',
        }}>
            <span style={{ fontSize: 13, lineHeight: '1.4' }}>⚠️</span>
            <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: CR.mono, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cr-error)', marginBottom: 3 }}>
                    {title}
                </div>
                <div style={{ fontFamily: CR.sans, fontSize: 12.5, color: CR.text, lineHeight: 1.6, wordBreak: 'break-word', overflowWrap: 'anywhere' }}>
                    {text.replace(/^_|_$/g, '')}
                </div>
            </div>
        </div>
    );
}


/**
 * The body of an agent turn: its trace + whatever its reply really is.
 *
 * A reply isn't always prose. Some carry an HTML artifact, and old ones carry the
 * markers of the removed job system; the legacy chat row rendered both specially.
 * Delegating to the same components it used — rather than reimplementing them here —
 * is what keeps this a drop-in replacement: without it, an old job reply renders as the
 * literal text "[job-pending:abc123]" and an artifact loses its preview.
 */
function TurnBody({
    turn, agentColor, agentName, mdComponents, liveTokenCount, agentId,
}: {
    turn: AgentTurn;
    agentColor: string;
    agentName: string;
    agentId?: string;
    mdComponents?: Components;
    liveTokenCount?: number;
}) {
    const text = turn.text ?? '';

    // A reply from the removed job system (stage 57): ChatBubble strips its
    // [job-pending:]/[job-id:] markers, so hand it the turn as a message rather than
    // duplicating that here.
    if (text && JOB_MARKER.test(text)) {
        return (
            <>
                {turn.steps.length > 0 && (
                    <CycleTimeline steps={turn.steps} agentColor={agentColor} isActive={false} mdComponents={mdComponents} />
                )}
                <ChatBubble
                    message={{
                        id: turn.key,
                        sender: 'Assistant',
                        sender_name: turn.sender || agentName,
                        content: text,
                        timestamp: turn.timestamp ?? '',
                        is_from_me: false,
                    }}
                />
                {(turn.approvals ?? []).map(a => (
                    <ApprovalCard key={a.id} approval={a} agentName={turn.sender || agentName} agentId={agentId} />
                ))}
            </>
        );
    }

    // An HTML artifact, from the reply text or the turn's file-write steps.
    const artifact = text || turn.steps.length ? detectTurnArtifact(text, turn.steps) : null;

    // A turn with no trace is a plain reply, and the legacy row gives those bubble
    // chrome rather than a one-node timeline. Keeping that distinction matters: the
    // timeline's vertical rule reads as "here is the work I did", which is a lie for a
    // turn that did none.
    const isCycle = turn.steps.length > 0;

    return (
        <>
            {isCycle ? (
                <CycleTimeline
                    steps={turn.steps}
                    agentColor={agentColor}
                    isActive={turn.active && !turn.error}
                    finalAnswerText={text || undefined}
                    mdComponents={mdComponents}
                    tokenCount={turn.active ? liveTokenCount : undefined}
                />
            ) : turn.active && !turn.error ? (
                // Started, nothing yet — the timeline owns the "working…" affordance.
                <CycleTimeline steps={[]} agentColor={agentColor} isActive mdComponents={mdComponents} tokenCount={liveTokenCount} />
            ) : text ? (
                <div style={{
                    padding: '12px 16px', borderRadius: '4px 16px 16px 16px',
                    background: CR.bgCard, border: `1px solid ${CR.border}`,
                    boxShadow: '0 2px 8px var(--cr-shade-1)',
                    fontFamily: CR.sans, fontSize: 13.5, color: CR.text, lineHeight: 1.7,
                }}>
                    <div className="agent-md">
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>
                    </div>
                </div>
            ) : null}
            {/* The gate the agent is blocked on — after the trace, so it reads as the
                point work stopped, and before the artifact. */}
            {(turn.approvals ?? []).map(a => (
                <ApprovalCard key={a.id} approval={a} agentName={turn.sender || agentName} agentId={agentId} />
            ))}
            {/* No onOpen — matching AgentChatRow, which renders the card without one. */}
            {artifact && <ArtifactCard artifact={artifact} agentId={agentId} />}
        </>
    );
}

/**
 * A mid-cycle approval gate, rendered inline where the agent stopped.
 *
 * The agent is genuinely blocked on this — it is polling for the answer and will
 * resume the instant one arrives — so the card is deliberately loud, shows the real
 * remaining time (an unanswered gate lapses and the agent gives up), and settles
 * into a verdict in place rather than disappearing. The verdict is the audit trail:
 * "what did I approve last Tuesday" has to be answerable from the transcript.
 */
function ApprovalCard({ approval, agentName, agentId }: { approval: TurnApproval; agentName: string; agentId?: string }) {
    const [busy, setBusy] = React.useState(false);
    const [failed, setFailed] = React.useState<string | null>(null);
    // Re-render once a second so the countdown is honest while the agent waits.
    const [, setTick] = React.useState(0);
    const settled = approval.decision;

    React.useEffect(() => {
        if (settled) return;
        const t = setInterval(() => setTick(n => n + 1), 1000);
        return () => clearInterval(t);
    }, [settled]);

    const msLeft = approval.timeoutMs - (Date.now() - new Date(approval.createdAt).getTime());
    const lapsed = msLeft <= 0;

    async function decide(decision: 'approve' | 'deny') {
        setBusy(true);
        setFailed(null);
        try {
            const res = await fetch(`/api/computer-use/escalations/${approval.approvalId}/${decision}`, { method: 'POST' });
            if (!res.ok) throw new Error(String(res.status));
            // No local state update: the server re-appends the event under the same
            // id, which arrives over the socket and flips this card in every tab.
        } catch {
            setFailed('That request could not be answered — it may have already expired.');
            setBusy(false);
        }
    }

    const verdict = settled === 'approved' ? { icon: '✓', label: 'Approved', color: CR.green }
        : settled === 'denied' ? { icon: '✕', label: 'Denied', color: CR.red }
        : settled === 'expired' ? { icon: '⏱', label: 'Expired — no answer, treated as denied', color: CR.muted }
        : null;

    // Stage 49 phase 4. This read `element || target || url`, and for a `navigate` the
    // server sets `element` to `step.description` — which, with no target to name, is
    // the bare word "navigate". So the card said "navigate on navigate" and the operator
    // approved a destination they were never shown (seen live 2026-09-02, cycle
    // 1ffd9cb1). The URL was in the payload the whole time; only this precedence was
    // wrong. A label that just repeats the action name carries no information, so it
    // never wins over something that does.
    const actionName = (approval.action || '').trim().toLowerCase();
    const namedElement = approval.element && approval.element.trim().toLowerCase() !== actionName
        ? approval.element
        : null;
    const detail = (actionName === 'navigate' ? approval.url : null)
        || namedElement || approval.target || approval.url;
    // Where a click actually lands is as much a part of the decision as what it is
    // called, so show it whenever it is not already the headline.
    const destination = approval.url && approval.url !== detail ? approval.url : null;
    // Undefined for a project chat (no single agent), and absent once the browser has
    // closed — both render as no thumbnail rather than a stale one.
    const livePage = useLiveBrowsersStore(s => (agentId ? s.byAgent[agentId] : undefined));

    return (
        <div style={{
            marginTop: 8, padding: '12px 14px', borderRadius: 8,
            border: `1px solid ${verdict ? CR.border : CR.amberLine}`,
            background: verdict ? CR.bgCard : CR.amberLow,
        }}>
            <div style={{
                fontFamily: CR.mono, fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase',
                color: verdict ? CR.muted : CR.amber, marginBottom: 5,
            }}>
                {verdict ? 'Approval' : 'Approval needed'}
            </div>

            <div style={{ fontFamily: CR.sans, fontSize: 13, color: CR.text, lineHeight: 1.6, wordBreak: 'break-word' }}>
                {verdict ? null : <><strong>{agentName}</strong> is paused and wants to </>}
                <code style={{ fontFamily: CR.mono, fontSize: 12 }}>{approval.action}</code>
                {detail && <> on <strong>{detail}</strong></>}
            </div>

            {destination && (
                <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.sub, marginTop: 4, wordBreak: 'break-all' }}>
                    → {destination}
                </div>
            )}

            {/* The page this decision is about (stage 49 phase 4).
                An operator was asked to approve a click on `button.ax-btn-dark` and had
                no way to see what that was — the whole reason this phase exists. The
                frame is the one already streaming to the dashboard, so this costs no new
                request; it is simply shown where the decision is actually made. Only
                while the browser is live: a stale picture beside a live question would
                be worse than none. */}
            {livePage && !settled && (
                <div style={{ marginTop: 8, borderRadius: 6, overflow: 'hidden', border: `1px solid ${CR.border}` }}>
                    <img
                        src={livePage.dataUrl}
                        alt="The page this action would act on"
                        style={{ display: 'block', width: '100%', maxHeight: 220, objectFit: 'cover', objectPosition: 'top' }}
                    />
                </div>
            )}

            {approval.description && approval.description !== detail
                && approval.description.trim().toLowerCase() !== actionName && (
                <div style={{ fontFamily: CR.sans, fontSize: 12, color: CR.sub, marginTop: 4, wordBreak: 'break-word' }}>
                    {approval.description}
                </div>
            )}

            {failed && <div style={{ fontSize: 12, color: CR.red, marginTop: 8 }}>{failed}</div>}

            {verdict ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12, color: verdict.color }}>
                    <span>{verdict.icon}</span><span>{verdict.label}</span>
                </div>
            ) : lapsed ? (
                <div style={{ marginTop: 8, fontSize: 12, color: CR.muted }}>
                    ⏱ Expired — no answer, treated as denied
                </div>
            ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                    <button
                        onClick={() => decide('approve')}
                        disabled={busy}
                        style={{
                            fontSize: 12, padding: '5px 14px', borderRadius: 6,
                            border: `1px solid ${CR.accent}`, background: CR.accent, color: CR.onAccent,
                            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                        }}
                    >Approve</button>
                    <button
                        onClick={() => decide('deny')}
                        disabled={busy}
                        style={{
                            fontSize: 12, padding: '5px 14px', borderRadius: 6,
                            border: `1px solid ${CR.border}`, background: CR.bgCard, color: CR.text,
                            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
                        }}
                    >Deny</button>
                    <span style={{ fontSize: 11, color: CR.muted }}>
                        {Math.floor(msLeft / 60000)}m {Math.floor((msLeft % 60000) / 1000)}s left
                    </span>
                </div>
            )}
        </div>
    );
}

/** h:mm a, matching the legacy rows. Tolerates a missing/garbage timestamp. */
function TurnTime({ iso }: { iso?: string }) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return (
        <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted }}>
            {d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
    );
}

interface ConversationViewProps {
    /** Whose conversation this is — used to show that agent's live browser
     *  frame on an approval card (stage 49 phase 4). Optional: a project chat renders
     *  the same component without one, and simply gets no thumbnail. */
    agentId?: string;
    events: ConversationEvent[];
    agentColor: string;
    agentName?: string;
    agentEmoji?: string;
    mdComponents?: Components;
    loading?: boolean;
    error?: string | null;
    /**
     * Live cumulative token count for the in-flight turn. Not part of the event log —
     * it streams on its own `cycle_progress` channel as a running total, which is
     * telemetry about a turn rather than something that happened in the conversation.
     * Passed in so the running turn keeps the "· N tokens" readout the legacy
     * streaming view had.
     */
    liveTokenCount?: number;
    /** True while older history exists above what's loaded. */
    hasOlder?: boolean;
    loadingOlder?: boolean;
    onLoadOlder?: () => void;
}

function ConversationViewInner({
    events, agentColor, agentName = 'Agent', agentEmoji = '🤖', mdComponents, loading, error, liveTokenCount,
    hasOlder, loadingOlder, onLoadOlder, agentId,
}: ConversationViewProps) {
    const turns = React.useMemo(() => buildTurns(events), [events]);

    if (loading) {
        return <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, padding: 16 }}>Loading conversation…</div>;
    }
    if (error) {
        // A failed READ is distinct from a conversation that contains a failure, and
        // from an empty one. Showing nothing here is what taught us this lesson.
        return (
            <div style={{ padding: 16 }}>
                <ErrorBlock title="Couldn't load this conversation" text={error} />
            </div>
        );
    }
    if (turns.length === 0) {
        return <div style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, padding: 16 }}>No messages yet.</div>;
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            {/* Only the newest page loads up front — a long thread's full history is far
                too much to hand a browser at once — so older turns are fetched on demand. */}
            {hasOlder && (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <button
                        onClick={onLoadOlder}
                        disabled={loadingOlder}
                        style={{
                            padding: '5px 14px', borderRadius: 100, cursor: loadingOlder ? 'default' : 'pointer',
                            background: 'var(--cr-tint-2)', border: `1px solid ${CR.border}`,
                            color: CR.muted, fontFamily: CR.mono, fontSize: 10.5,
                        }}
                    >{loadingOlder ? 'loading…' : '↑ load earlier messages'}</button>
                </div>
            )}
            {turns.map(turn => (
                <TurnRow
                    key={turn.key}
                    turn={turn}
                    agentColor={agentColor}
                    agentName={agentName}
                    agentEmoji={agentEmoji}
                    agentId={agentId}
                    mdComponents={mdComponents}
                    // Only the running turn gets the ticking token count. Passing it to
                    // every row would change every row's props on each tick and undo the
                    // memo below.
                    liveTokenCount={turn.kind === 'agent' && turn.active ? liveTokenCount : undefined}
                />
            ))}
        </div>
    );
}

interface TurnRowProps {
    turn: Turn;
    agentColor: string;
    agentName: string;
    agentEmoji: string;
    /** Passed through to the approval card so it can show that agent's live browser
     *  frame. A plain string, so it does not disturb the memo below. */
    agentId?: string;
    mdComponents?: Components;
    liveTokenCount?: number;
}

function TurnRowInner({ turn, agentColor, agentName, agentEmoji, mdComponents, liveTokenCount, agentId }: TurnRowProps) {
    return (
        <>
            {turn.kind === 'user' ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                    <div style={{
                        maxWidth: '80%', padding: '12px 16px', borderRadius: '16px 4px 16px 16px',
                        background: `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})`,
                        boxShadow: `0 4px 16px ${CR.accent30}`,
                        fontFamily: CR.sans, fontSize: 13.5, color: 'var(--cr-on-accent)', lineHeight: 1.7,
                        wordBreak: 'break-word', overflowWrap: 'anywhere',
                    }}>
                        {turn.text}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexDirection: 'row-reverse', paddingRight: 4 }}>
                        <TurnTime iso={turn.timestamp} />
                        {turn.source === 'whatsapp' && <WaSourceBadge />}
                    </div>
                </div>
            ) : (
                // Icon + name is a small header, not a chat-bubble avatar column. Everything
                // below it — the trace, the answer — spans the row's full width instead of
                // being indented to start where the avatar left off: a tool card or the final
                // answer is the actual content people read, and indenting it under a 34px icon
                // bought it nothing but a narrower, less consistent column than the composer
                // sitting right below (see the width fix above this turn's history for why that
                // was already broken; this removes the leftover indent that caused it).
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        {/* Avatar. Where several agents share a thread, the turn's own sender
                            supplies the face — otherwise every turn wears the page's. */}
                        <div style={{
                            width: 26, height: 26, borderRadius: 8, flexShrink: 0,
                            background: `${withAlpha(agentColor, 8)}`, border: `1px solid ${withAlpha(agentColor, 19)}`,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13,
                        }}>{senderEmoji(turn.sender) ?? agentEmoji}</div>
                        {/* The turn names its own author when the events carry one — a project
                            thread has several agents in it, so a single page-level name would
                            attribute every turn to whoever the page happens to be about. */}
                        <span style={{ fontFamily: CR.sans, fontSize: 11, fontWeight: 600, color: agentColor }}>
                            {senderName(turn.sender) ?? agentName}
                        </span>
                        {turn.source === 'whatsapp' && <WaSourceBadge />}
                    </div>

                    {/* Full row width, matching the composer below — a plain-text reply gets
                        this too now: capping it narrower than the trace above it (76%, the
                        original chat-bubble convention) read as inconsistent once the trace
                        itself went full width, not as an intentional bubble shape. */}
                    <div style={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <TurnBody
                            turn={turn}
                            agentColor={agentColor}
                            agentName={agentName}
                            mdComponents={mdComponents}
                            liveTokenCount={liveTokenCount}
                            agentId={agentId}
                        />
                        {turn.error && <ErrorBlock text={turn.error} />}
                        {/* The same widget the legacy row uses — expandable, +/- counts, per-file
                            diffs — but handed its events instead of fetching them per cycle. */}
                        {turn.files.length > 0 && (
                            <TurnFileChanges
                                agentId=""
                                cycleId={turn.cycleId ?? ''}
                                accentColor={agentColor}
                                events={turn.files}
                            />
                        )}
                        {!turn.active && <TurnTime iso={turn.timestamp} />}
                    </div>
                </div>
            )}
        </>
    );
}

/**
 * Memoized per turn, by CONTENT rather than by reference.
 *
 * buildTurns rebuilds every turn from scratch whenever an event arrives, so turn
 * objects never keep their identity — a default React.memo would compare fresh
 * objects, always differ, and re-render (and re-parse the markdown of) every turn in
 * the thread for each event of a live cycle. turnsEqual compares what the row
 * actually renders, so only the turn that changed re-renders. It's exhaustively
 * tested because a comparator that wrongly reports "equal" shows stale content.
 *
 * The legacy path got this for free: its live turn lived in a separate StreamingTurn,
 * so history rows were never touched while streaming. Here everything is one log, so
 * the isolation has to be earned here instead.
 */
const TurnRow = React.memo(TurnRowInner, (a, b) =>
    turnsEqual(a.turn, b.turn)
    && a.agentColor === b.agentColor
    && a.agentName === b.agentName
    && a.agentEmoji === b.agentEmoji
    && a.mdComponents === b.mdComponents
    && a.liveTokenCount === b.liveTokenCount
);


/**
 * Memoized — and this is load-bearing, not an optimisation.
 *
 * Typing in the composer sets state on the chat page, so the page re-renders on every
 * keystroke. Without this, that re-renders the whole thread and ReactMarkdown
 * re-parses every answer in it — on every keystroke — so the composer gets slower the
 * longer the conversation is. That exact bug was fixed once before on the legacy path
 * (renderedHistory's useMemo plus a memoized AgentChatRow), and this component
 * silently reintroduced it.
 *
 * INVARIANT (do not break): every prop must be referentially stable across a keystroke
 * render, or this memo is a no-op and the lag comes straight back. Today `mdComponents`
 * is useMemo'd, `events` is the hook's own state,
 * `liveTokenCount` resolves to a primitive, and the rest are strings. An inline closure
 * or a fresh array/object literal in a caller's JSX would break it — which is exactly
 * how the lag returned to the agent page the last time this was fixed.
 */
export const ConversationView = React.memo(ConversationViewInner);
