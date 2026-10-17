/**
 * Agent-to-agent exchanges, read as a transcript.
 *
 * ONE renderer, used by the Handoffs page and by an agent's own Manage → Handoffs tab.
 * There were two hand-written versions for a day and they disagreed about everything that
 * mattered — the agent tab still used the pre-stage-56 status names, never showed the
 * answer, and rendered the raw payload JSON alongside a formatted copy of the same text
 * and the note, so a single reply appeared on screen three times. That is the same
 * two-places disease the handoff ROUTES had, in the UI layer.
 *
 * The rules this file exists to hold in one place:
 *
 *  - A question shows the question; an answer shows the answer. The `result` column on a
 *    request row is a denormalised copy of its reply, and showing it there prints the same
 *    sentence twice under two different names.
 *  - Text beats JSON. The payload is shown only when there is no readable text, because
 *    for a reply the payload is a wrapper around text that is already on screen.
 *  - Never truncate what one agent told another. The whole point of the channel is that
 *    the sender's own words arrive intact.
 */
import { useState } from 'react';
import { CR, withAlpha } from '../lib/cr';

export interface ConversationMessage {
    id: string;
    fromId: string; from: string;
    toId: string;   to: string;
    performative: string;
    status: string;
    note: string | null;
    result: string | null;
    reason: string | null;
    payload: string;
    createdAt: string;
    deadlineAt: string | null;
}

export interface Conversation {
    threadId: string;
    participants: string[];
    messages: ConversationMessage[];
    lastAt: string;
    status: string;
    unanswered: boolean;
}

export const CONVO_STATUS_COLOR: Record<string, string> = {
    pending:   'var(--cr-warn)',
    seen:      'var(--cr-muted)',
    agreed:    'var(--cr-blue)',
    completed: 'var(--cr-green)',
    refused:   'var(--cr-error)',
    cannot:    'var(--cr-purple)',
    failed:    'var(--cr-error)',
    expired:   'var(--cr-muted)',
    archived:  'var(--cr-muted)',
};

const STATUS_BG: Record<string, string> = {
    pending:   'var(--cr-amber-low)',
    agreed:    'var(--cr-blue-low)',
    completed: 'var(--cr-green-low)',
    refused:   'var(--cr-error-low)',
    cannot:    'var(--cr-purple-low)',
    failed:    'var(--cr-error-low)',
};

/** What each verb means, in plain words, so the reader never decodes jargon. */
const VERB_LABEL: Record<string, string> = {
    request: 'asked',
    inform:  'told',
    agree:   'agreed with',
    result:  'answered',
    refuse:  'refused',
    cannot:  'could not help',
    failure: 'failed for',
    expire:  'never answered',
};

const ANSWER_VERBS = new Set(['agree', 'result', 'refuse', 'cannot', 'failure', 'expire']);

function fmtRel(d: string) {
    const delta = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

/** The one place that decides what text a message shows. */
export function messageBody(m: ConversationMessage): { text: string; isRaw: boolean } {
    const isAnswer = ANSWER_VERBS.has(m.performative);
    const text = (isAnswer ? m.result : null) ?? m.note ?? '';
    if (text.trim()) return { text: text.trim(), isRaw: false };

    // No prose — fall back to the payload, but only if it carries something. An empty
    // `{}` rendered as a code block is a large box that says nothing, which is worse
    // than an honest one-line note.
    const raw = (m.payload ?? '').trim();
    if (!raw || raw === '{}' || raw === 'null') return { text: '', isRaw: false };
    return { text: raw.length > 1200 ? `${raw.slice(0, 1200)}…` : raw, isRaw: true };
}

export function AgentConversations({ threads, loading, emoji, onOpenAgent, dense }: {
    threads: Conversation[];
    loading: boolean;
    /** agent id → emoji, so each page can use whatever it already has. */
    emoji?: (agentId: string) => string;
    onOpenAgent?: (agentId: string) => void;
    /** Agent-scoped views are already inside a card; skip the outer chrome. */
    dense?: boolean;
}) {
    const [open, setOpen] = useState<Record<string, boolean>>({});
    const [onlyUnanswered, setOnlyUnanswered] = useState(false);

    const shown = onlyUnanswered ? threads.filter(t => t.unanswered) : threads;
    const unansweredCount = threads.filter(t => t.unanswered).length;

    if (loading && threads.length === 0) {
        return <div style={{ color: CR.muted, fontSize: 13, padding: '40px 0', textAlign: 'center' }}>Loading conversations…</div>;
    }
    if (threads.length === 0) {
        return (
            <div style={{ color: CR.muted, fontSize: 13, padding: '40px 0', textAlign: 'center' }}>
                No conversations yet. Agents hand work over with <code>handoff_to</code> and answer with{' '}
                <code>reply_to_handoff</code>.
            </div>
        );
    }

    return (
        <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: dense ? 12 : 14 }}>
                <span style={{ color: CR.muted, fontSize: 12 }}>
                    {shown.length} conversation{shown.length === 1 ? '' : 's'}
                </span>
                {unansweredCount > 0 && (
                    <button
                        onClick={() => setOnlyUnanswered(v => !v)}
                        style={{
                            padding: '4px 10px', borderRadius: 100, cursor: 'pointer',
                            background: onlyUnanswered ? 'var(--cr-amber-low)' : 'transparent',
                            border: `1px solid ${onlyUnanswered ? 'var(--cr-amber-line)' : CR.border}`,
                            color: onlyUnanswered ? 'var(--cr-warn)' : CR.muted,
                            fontFamily: CR.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
                        }}>
                        {unansweredCount} awaiting an answer
                    </button>
                )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {shown.map(t => {
                    const isOpen = open[t.threadId] ?? shown.length <= 3;
                    const color  = CONVO_STATUS_COLOR[t.status] ?? CR.muted;
                    const bg     = STATUS_BG[t.status] ?? 'transparent';
                    const opener = t.messages[0];
                    const preview = opener ? messageBody(opener).text.replace(/\s+/g, ' ') : '';

                    return (
                        <div key={t.threadId} style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10, overflow: 'hidden' }}>
                            <div
                                onClick={() => setOpen(o => ({ ...o, [t.threadId]: !isOpen }))}
                                style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', borderBottom: isOpen ? `1px solid ${CR.border}` : 'none' }}
                            >
                                <span style={{ color: CR.cream, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                                    {t.participants.slice(0, 2).join(' ⇄ ')}
                                </span>
                                <span style={{ color: CR.muted, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {preview}
                                </span>
                                <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, flexShrink: 0 }}>
                                    {t.messages.length} turn{t.messages.length === 1 ? '' : 's'}
                                </span>
                                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '2px 8px', borderRadius: 100, background: bg, border: `1px solid ${withAlpha(color, 19)}`, color, textTransform: 'uppercase', flexShrink: 0 }}>
                                    {t.status}
                                </span>
                                <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, flexShrink: 0 }}>{fmtRel(t.lastAt)}</span>
                                <span style={{ color: CR.muted, fontSize: 12, transform: isOpen ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>›</span>
                            </div>

                            {isOpen && (
                                <div>
                                    {t.messages.map((m, i) => {
                                        const { text, isRaw } = messageBody(m);
                                        const mColor = CONVO_STATUS_COLOR[m.status] ?? CR.muted;
                                        const isOpenQuestion = m.performative === 'request'
                                            && !['completed', 'refused', 'cannot', 'failed', 'expired'].includes(m.status);
                                        return (
                                            <div key={m.id} style={{
                                                padding: '12px 16px',
                                                borderTop: i === 0 ? 'none' : `1px solid ${CR.border}`,
                                                borderLeft: `2px solid ${withAlpha(mColor, 30)}`,
                                            }}>
                                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 5, flexWrap: 'wrap' }}>
                                                    {emoji && <span style={{ fontSize: 13 }}>{emoji(m.fromId)}</span>}
                                                    <span
                                                        onClick={() => onOpenAgent?.(m.fromId)}
                                                        style={{ color: CR.cream, fontSize: 12.5, fontWeight: 600, cursor: onOpenAgent ? 'pointer' : 'default' }}>
                                                        {m.from}
                                                    </span>
                                                    <span style={{ color: CR.muted, fontSize: 11.5 }}>
                                                        {VERB_LABEL[m.performative] ?? m.performative} {m.to}
                                                    </span>
                                                    <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted, marginLeft: 'auto' }}>
                                                        {new Date(m.createdAt).toLocaleString()}
                                                    </span>
                                                </div>

                                                {text && (
                                                    isRaw ? (
                                                        <pre style={{ margin: '0 0 0 20px', fontFamily: CR.mono, fontSize: 11, color: CR.sub, lineHeight: 1.55, whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto' }}>{text}</pre>
                                                    ) : (
                                                        <p style={{ margin: '0 0 0 20px', fontFamily: CR.sans, fontSize: 12.5, color: CR.text, lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>{text}</p>
                                                    )
                                                )}
                                                {m.reason && (
                                                    <p style={{ margin: '6px 0 0 20px', fontFamily: CR.sans, fontSize: 11.5, color: mColor }}>
                                                        {m.performative === 'cannot' ? 'Missing: ' : m.performative === 'failure' ? 'Error: ' : 'Reason: '}{m.reason}
                                                    </p>
                                                )}
                                                {isOpenQuestion && m.deadlineAt && (
                                                    <p style={{ margin: '6px 0 0 20px', fontFamily: CR.mono, fontSize: 10, color: 'var(--cr-warn)' }}>
                                                        awaiting an answer · expires {new Date(m.deadlineAt).toLocaleString()}
                                                    </p>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
