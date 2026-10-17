import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CR, withAlpha } from '../lib/cr';

/**
 * A question the agent asked mid-task, answered in the chat (stage 60 phase 2).
 *
 * `clarify` check-ins used to render with the generic approval card — "Approval needed",
 * Approve / Reject — so "LinkedIn or the cloud sources?" could only be answered with
 * "approve". The run is blocked waiting (clarify.py polls for up to 10 minutes with the
 * browser still open), so the answer has to be one click: pick an option, or type.
 *
 * Options come structured from the check-in's action_payload. Rows written before that
 * existed carry only the rendered markdown, which is shown as-is with a free-text reply.
 */
export interface QuestionOption { label: string; detail?: string }

export function parseQuestion(checkin: { report_md?: string | null; action_payload?: string | null }): {
    question: string | null;
    context: string | null;
    options: QuestionOption[];
    multi: boolean;
    awaitUntil: number | null;
} {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(checkin.action_payload || '{}') ?? {}; } catch { /* legacy row */ }
    const options = Array.isArray(p.options)
        ? (p.options as unknown[])
            .filter((o): o is QuestionOption => !!o && typeof (o as QuestionOption).label === 'string' && (o as QuestionOption).label.trim() !== '')
        : [];
    const awaitUntil = Number(p.awaitUntil);
    return {
        question: typeof p.question === 'string' && p.question.trim() ? p.question : null,
        context: typeof p.context === 'string' && p.context.trim() ? p.context : null,
        options,
        multi: p.multi_select === true,
        awaitUntil: Number.isFinite(awaitUntil) ? awaitUntil : null,
    };
}

export function QuestionCard({ checkin, agentName, accent, onAnswer, mdComponents }: {
    checkin: { id: string; report_md?: string | null; action_payload?: string | null };
    agentName: string;
    accent: string;
    onAnswer: (reply: string) => Promise<void> | void;
    mdComponents?: Record<string, unknown>;
}) {
    const q = parseQuestion(checkin);
    const [picked, setPicked] = useState<number[]>([]);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);

    async function send(reply: string) {
        if (!reply.trim() || busy) return;
        setBusy(true);
        try { await onAnswer(reply.trim()); } finally { setBusy(false); }
    }

    // The agent gets the label, not just a number: a bare "2" is ambiguous if it later
    // re-reads the thread, and the label is what the person actually chose.
    const answerFor = (idxs: number[]) => idxs.map(i => `${i + 1}. ${q.options[i].label}`).join('; ');

    const expired = q.awaitUntil !== null && Date.now() > q.awaitUntil;

    return (
        <div style={{ background: CR.bgCard, border: `1px solid ${withAlpha(accent, 38)}`, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '2px 8px', borderRadius: 100, background: withAlpha(accent, 8), border: `1px solid ${withAlpha(accent, 30)}`, color: accent, textTransform: 'uppercase' }}>
                    {agentName} asks
                </span>
                {expired && <span style={{ fontFamily: CR.sans, fontSize: 11, color: CR.muted }}>It stopped waiting. Your answer reaches it on the next run.</span>}
            </div>

            {q.question ? (
                <>
                    <div style={{ fontFamily: CR.sans, fontSize: 13.5, color: CR.cream, lineHeight: 1.5, marginBottom: q.context ? 4 : 10 }}>{q.question}</div>
                    {q.context && <div style={{ fontFamily: CR.sans, fontSize: 11.5, color: CR.muted, lineHeight: 1.5, marginBottom: 10 }}>{q.context}</div>}
                </>
            ) : checkin.report_md ? (
                <div className="agent-md" style={{ fontSize: 12.5, color: CR.sub, lineHeight: 1.6, marginBottom: 10 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as never}>{checkin.report_md}</ReactMarkdown>
                </div>
            ) : null}

            {q.options.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {q.options.map((o, i) => {
                        const on = picked.includes(i);
                        return (
                            <button key={i} disabled={busy}
                                onClick={() => {
                                    if (q.multi) setPicked(p => on ? p.filter(x => x !== i) : [...p, i]);
                                    else void send(answerFor([i]));
                                }}
                                style={{
                                    display: 'flex', alignItems: 'flex-start', gap: 10, textAlign: 'left', width: '100%',
                                    padding: '8px 12px', borderRadius: 9, cursor: busy ? 'default' : 'pointer',
                                    background: on ? withAlpha(accent, 10) : CR.bgSurf,
                                    border: `1px solid ${on ? withAlpha(accent, 45) : CR.border}`,
                                    fontFamily: CR.sans, color: CR.text,
                                }}>
                                <span style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted, paddingTop: 1 }}>{q.multi ? (on ? '☑' : '☐') : i + 1}</span>
                                <span>
                                    <span style={{ display: 'block', fontSize: 12.5, color: CR.cream }}>{o.label}</span>
                                    {o.detail && <span style={{ display: 'block', fontSize: 11.5, color: CR.muted, marginTop: 1 }}>{o.detail}</span>}
                                </span>
                            </button>
                        );
                    })}
                    {q.multi && (
                        <button disabled={busy || picked.length === 0} onClick={() => void send(answerFor([...picked].sort((a, b) => a - b)))}
                            style={{ alignSelf: 'flex-start', padding: '6px 14px', borderRadius: 8, cursor: picked.length ? 'pointer' : 'default', background: picked.length ? withAlpha(accent, 12) : 'transparent', border: `1px solid ${withAlpha(accent, 38)}`, color: picked.length ? CR.cream : CR.muted, fontFamily: CR.sans, fontSize: 12 }}>
                            Send {picked.length || ''} selected
                        </button>
                    )}
                </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
                <input value={text} disabled={busy}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(text); } }}
                    placeholder={q.options.length ? 'Or tell it something else…' : 'Your answer…'}
                    style={{ flex: 1, background: CR.bgSurf, border: `1px solid ${CR.border}`, borderRadius: 8, padding: '7px 12px', color: CR.text, fontFamily: CR.sans, fontSize: 12.5, outline: 'none' }} />
                <button disabled={busy || !text.trim()} onClick={() => void send(text)}
                    style={{ padding: '7px 14px', borderRadius: 8, cursor: text.trim() ? 'pointer' : 'default', background: text.trim() ? withAlpha(accent, 12) : 'transparent', border: `1px solid ${withAlpha(accent, 38)}`, color: text.trim() ? CR.cream : CR.muted, fontFamily: CR.sans, fontSize: 12 }}>
                    {busy ? 'Sending…' : 'Answer'}
                </button>
            </div>
        </div>
    );
}
