import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentsStore, type AgentCheckin } from '../stores/agentsStore';
import { CR } from '../lib/cr';
import PendingApprovals from '../components/PendingApprovals';
import { useIsMobile } from '../hooks/useIsMobile';

interface EmailFields { to: string; subject: string; body: string; }

function parsePayload(checkin: AgentCheckin): EmailFields {
    try {
        const p = JSON.parse(checkin.action_payload ?? '{}');
        return { to: p.to ?? '', subject: p.subject ?? '', body: p.body ?? '' };
    } catch { return { to: '', subject: '', body: '' }; }
}

export default function CheckinsInboxPage() {
    const navigate = useNavigate();
    // Stage 64 phase 1: the link in a WhatsApp approval opens this page on a phone.
    const isMobile = useIsMobile();
    const { agents, pendingCheckins, fetchPendingCheckins, fetchAgents } = useAgentsStore();
    const [replies, setReplies]     = useState<Record<string, string>>({});
    const [sending, setSending]     = useState<Record<string, boolean>>({});
    const [sent, setSent]           = useState<Record<string, boolean>>({});
    const [expanded, setExpanded]   = useState<Record<string, boolean>>({});
    const [loading, setLoading]     = useState(true);
    const [editMode, setEditMode]   = useState<Record<string, boolean>>({});
    const [editFields, setEditFields] = useState<Record<string, EmailFields>>({});
    const [selected, setSelected]   = useState<Record<string, boolean>>({});
    const [batching, setBatching]   = useState(false);
    const [batchNote, setBatchNote] = useState<string | null>(null);

    useEffect(() => {
        if (!agents.length) fetchAgents();
        fetchPendingCheckins().finally(() => setLoading(false));
    }, []);

    function agentFor(c: AgentCheckin) {
        return agents.find(a => a.id === c.agent_id);
    }

    function fmtRel(d: string) {
        const delta = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
        if (delta < 60) return 'just now';
        if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
        if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
        return `${Math.floor(delta / 86400)}d ago`;
    }

    async function postReply(checkin: AgentCheckin, reply: string, actionPayloadOverride?: string) {
        setSending(s => ({ ...s, [checkin.id]: true }));
        try {
            const body: Record<string, string> = { reply };
            if (actionPayloadOverride) body.action_payload_override = actionPayloadOverride;
            const res = await fetch(`/api/agents/${checkin.agent_id}/checkins/${checkin.id}/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) {
                setSent(s => ({ ...s, [checkin.id]: true }));
                setReplies(r => ({ ...r, [checkin.id]: '' }));
                setTimeout(() => fetchPendingCheckins(), 1200);
            }
        } catch (err) { console.error(err); }
        finally { setSending(s => ({ ...s, [checkin.id]: false })); }
    }

    async function handleReply(checkin: AgentCheckin) {
        const reply = replies[checkin.id]?.trim();
        if (!reply) return;
        await postReply(checkin, reply);
    }

    async function handleApprove(checkin: AgentCheckin) {
        await postReply(checkin, 'approve');
    }

    async function handleApproveWithEdit(checkin: AgentCheckin) {
        const fields = editFields[checkin.id];
        if (!fields?.body?.trim() || !fields?.to?.trim()) return;
        let overridePayload: string | undefined;
        if (checkin.action_payload) {
            try {
                const p = JSON.parse(checkin.action_payload);
                overridePayload = JSON.stringify({ ...p, to: fields.to, subject: fields.subject, body: fields.body });
            } catch { overridePayload = checkin.action_payload; }
        }
        await postReply(checkin, 'approve', overridePayload);
    }

    async function handleReject(checkin: AgentCheckin) {
        await postReply(checkin, 'reject');
    }

    const selectedIds = pendingCheckins.filter(c => selected[c.id]).map(c => c.id);

    /**
     * Decide every selected check-in in one pass. The endpoint is per-agent — it resumes
     * that agent in a single follow-up turn — so a selection spanning agents is sent as
     * one request each rather than one request per check-in.
     */
    async function handleBatch(reply: 'approve' | 'reject') {
        if (!selectedIds.length || batching) return;
        if (reply === 'reject' && !confirm(`Reject ${selectedIds.length} check-in(s)?`)) return;

        setBatching(true);
        setBatchNote(null);
        try {
            const byAgent = new Map<string, string[]>();
            for (const c of pendingCheckins) {
                if (!selected[c.id]) continue;
                byAgent.set(c.agent_id, [...(byAgent.get(c.agent_id) ?? []), c.id]);
            }

            let ok = 0, bad = 0;
            for (const [agentId, ids] of byAgent) {
                const res = await fetch(`/api/agents/${agentId}/checkins/batch-respond`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids, reply }),
                });
                if (res.ok) {
                    const data = await res.json();
                    ok  += data.succeeded ?? 0;
                    bad += data.failed ?? 0;
                } else {
                    bad += ids.length;
                }
            }

            // Say what actually happened per item — a send can fail on one address while
            // the rest go through, and silently dropping that would be the worst outcome.
            setBatchNote(bad ? `${ok} done, ${bad} failed — see the remaining cards` : `${ok} done`);
            setSelected({});
            setTimeout(() => fetchPendingCheckins(), 1200);
        } catch (err) {
            console.error(err);
            setBatchNote('Batch failed — nothing was changed for the remaining items');
        } finally {
            setBatching(false);
        }
    }

    function openEdit(c: AgentCheckin) {
        setEditFields(f => ({ ...f, [c.id]: parsePayload(c) }));
        setEditMode(m => ({ ...m, [c.id]: true }));
    }

    function updateField(id: string, key: keyof EmailFields, value: string) {
        setEditFields(f => ({ ...f, [id]: { ...f[id], [key]: value } }));
    }

    const fieldStyle: React.CSSProperties = {
        width: '100%', padding: '8px 12px', borderRadius: 6, resize: 'none' as const,
        background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`,
        color: CR.cream, fontFamily: CR.sans, fontSize: 13, outline: 'none',
        boxSizing: 'border-box' as const,
    };

    return (
        <div style={{ flex: 1, overflow: 'auto', background: CR.bgMain, padding: isMobile ? '16px 12px' : '32px 36px', fontFamily: CR.sans }}>
            <div style={{ marginBottom: 28 }}>
                <h1 style={{ fontFamily: CR.serif, fontSize: 26, fontWeight: 400, color: CR.cream, margin: 0 }}>Check-in Inbox</h1>
                <p style={{ color: CR.muted, fontSize: 13, margin: '4px 0 0' }}>
                    Agents waiting for your feedback before continuing
                </p>
            </div>

            {/* Blocked tool calls come first: unlike a check-in, the agent is frozen
                on these and each one lapses to denied if nobody answers in time. */}
            <PendingApprovals />

            {loading ? (
                <div style={{ color: CR.muted, fontSize: 13 }}>Loading…</div>
            ) : pendingCheckins.length === 0 ? (
                <div style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 12, padding: 48, textAlign: 'center' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
                    <div style={{ color: CR.cream, fontSize: 15, marginBottom: 6 }}>All caught up</div>
                    <div style={{ color: CR.muted, fontSize: 13 }}>No agents are waiting for your reply right now</div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {/* Batch bar — the queue is the unit of work, not the individual card */}
                    <div style={{
                        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
                        background: CR.bgCard, border: `1px solid ${selectedIds.length ? 'var(--cr-purple-line)' : CR.border}`,
                        borderRadius: 10, padding: '10px 14px',
                    }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', color: CR.muted, fontSize: 12 }}>
                            <input
                                type="checkbox"
                                checked={selectedIds.length > 0 && selectedIds.length === pendingCheckins.length}
                                ref={el => { if (el) el.indeterminate = selectedIds.length > 0 && selectedIds.length < pendingCheckins.length; }}
                                onChange={e => setSelected(e.target.checked
                                    ? Object.fromEntries(pendingCheckins.map(c => [c.id, true]))
                                    : {})}
                                style={{ cursor: 'pointer' }}
                            />
                            Select all
                        </label>
                        <span style={{ color: selectedIds.length ? CR.cream : CR.muted, fontSize: 12 }}>
                            {selectedIds.length ? `${selectedIds.length} selected` : 'none selected'}
                        </span>
                        <div style={{ flex: 1 }} />
                        {batchNote && <span style={{ color: CR.muted, fontSize: 12 }}>{batchNote}</span>}
                        <button
                            disabled={!selectedIds.length || batching}
                            onClick={() => handleBatch('reject')}
                            style={{
                                padding: '6px 12px', borderRadius: 6, fontSize: 12, fontFamily: CR.sans,
                                background: 'transparent', border: `1px solid ${CR.border}`,
                                color: selectedIds.length && !batching ? CR.cream : CR.muted,
                                cursor: selectedIds.length && !batching ? 'pointer' : 'not-allowed',
                            }}
                        >
                            Reject selected
                        </button>
                        <button
                            disabled={!selectedIds.length || batching}
                            onClick={() => handleBatch('approve')}
                            style={{
                                padding: '6px 14px', borderRadius: 6, fontSize: 12, fontFamily: CR.sans, fontWeight: 600,
                                background: selectedIds.length && !batching ? 'var(--cr-green-low)' : 'transparent',
                                border: `1px solid ${selectedIds.length && !batching ? 'var(--cr-green-line)' : CR.border}`,
                                color: selectedIds.length && !batching ? CR.green : CR.muted,
                                cursor: selectedIds.length && !batching ? 'pointer' : 'not-allowed',
                            }}
                        >
                            {batching ? 'Working…' : `✓ Approve & Send${selectedIds.length ? ` (${selectedIds.length})` : ''}`}
                        </button>
                    </div>

                    {pendingCheckins.map(c => {
                        const agent     = agentFor(c);
                        const isOpen    = expanded[c.id] !== false;
                        const isSent    = sent[c.id];
                        const hasAction = !!c.action_type;
                        const isEditing = editMode[c.id];
                        const fields    = editFields[c.id];

                        return (
                            <div key={c.id} style={{
                                background: CR.bgCard,
                                border: `1px solid ${isSent ? 'var(--cr-green-line)' : hasAction ? 'var(--cr-purple-line)' : CR.border}`,
                                borderRadius: 12, overflow: 'hidden', transition: 'border-color 0.3s',
                            }}>
                                {/* Card header */}
                                <div
                                    onClick={() => setExpanded(e => ({ ...e, [c.id]: !isOpen }))}
                                    style={{ padding: isMobile ? '12px 12px' : '14px 18px', display: 'flex', alignItems: 'center', gap: isMobile ? 8 : 12, cursor: 'pointer', borderBottom: isOpen ? `1px solid ${CR.border}` : 'none' }}
                                >
                                    <input
                                        type="checkbox"
                                        checked={!!selected[c.id]}
                                        onClick={e => e.stopPropagation()}
                                        onChange={e => setSelected(s => ({ ...s, [c.id]: e.target.checked }))}
                                        style={{ cursor: 'pointer', flexShrink: 0 }}
                                        aria-label="Select this check-in"
                                    />
                                    <div style={{ width: 32, height: 32, borderRadius: 8, flexShrink: 0, background: 'var(--cr-accent-25)', border: '1px solid var(--cr-accent-30)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
                                        {agent?.emoji ?? '🤖'}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                            <span style={{ color: CR.cream, fontSize: 14, fontWeight: 600 }}>{agent?.name ?? 'Unknown Agent'}</span>
                                            {isSent ? (
                                                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 7px', borderRadius: 100, background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)', color: CR.green, textTransform: 'uppercase' }}>done</span>
                                            ) : hasAction ? (
                                                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 7px', borderRadius: 100, background: 'var(--cr-purple-low)', border: '1px solid var(--cr-purple-line)', color: 'var(--cr-purple)', textTransform: 'uppercase' }}>approval needed</span>
                                            ) : (
                                                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 7px', borderRadius: 100, background: 'var(--cr-amber-low)', border: '1px solid var(--cr-amber-line)', color: 'var(--cr-warn)', textTransform: 'uppercase' }}>awaiting reply</span>
                                            )}
                                            {hasAction && c.action_type && (
                                                <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 7px', borderRadius: 100, background: 'var(--cr-tint-4)', border: `1px solid ${CR.border}`, color: CR.muted, textTransform: 'uppercase' }}>{c.action_type}</span>
                                            )}
                                        </div>
                                        <div style={{ color: CR.muted, fontSize: 11, marginTop: 2 }}>{fmtRel(c.created_at)}</div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                        <button
                                            onClick={e => { e.stopPropagation(); navigate(`/agents/${c.agent_id}/checkin/${c.id}`); }}
                                            style={{ padding: '4px 10px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.sans, fontSize: 11 }}
                                        >
                                            {isMobile ? 'Open' : 'Full view'}
                                        </button>
                                        <span style={{ color: CR.muted, fontSize: 12, transform: isOpen ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>›</span>
                                    </div>
                                </div>

                                {/* Expanded body */}
                                {isOpen && (
                                    <div style={{ padding: isMobile ? '14px 12px' : '18px 20px' }}>
                                        {/* Report */}
                                        {c.report_md ? (
                                            <div style={{ background: 'var(--cr-tint-1)', border: `1px solid ${CR.border}`, borderRadius: 8, padding: '14px 16px', marginBottom: 16, fontSize: 13, color: CR.text, lineHeight: 1.7, maxHeight: 320, overflow: 'auto' }}>
                                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{c.report_md}</ReactMarkdown>
                                            </div>
                                        ) : (
                                            <div style={{ color: CR.muted, fontSize: 13, marginBottom: 16 }}>No report attached.</div>
                                        )}

                                        {!isSent ? (
                                            hasAction ? (
                                                <div>
                                                    {isEditing && fields ? (
                                                        /* ── Edit mode: To / Subject / Body ── */
                                                        <div style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                            <div>
                                                                <div style={{ color: CR.muted, fontSize: 11, marginBottom: 4 }}>To</div>
                                                                <input
                                                                    type="email"
                                                                    value={fields.to}
                                                                    onChange={e => updateField(c.id, 'to', e.target.value)}
                                                                    style={{ ...fieldStyle, resize: undefined }}
                                                                />
                                                            </div>
                                                            <div>
                                                                <div style={{ color: CR.muted, fontSize: 11, marginBottom: 4 }}>Subject</div>
                                                                <input
                                                                    type="text"
                                                                    value={fields.subject}
                                                                    onChange={e => updateField(c.id, 'subject', e.target.value)}
                                                                    style={{ ...fieldStyle, resize: undefined }}
                                                                />
                                                            </div>
                                                            <div>
                                                                <div style={{ color: CR.muted, fontSize: 11, marginBottom: 4 }}>Body</div>
                                                                <textarea
                                                                    value={fields.body}
                                                                    onChange={e => updateField(c.id, 'body', e.target.value)}
                                                                    rows={5}
                                                                    style={fieldStyle}
                                                                />
                                                            </div>
                                                        </div>
                                                    ) : null}

                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        {isEditing ? (
                                                            <>
                                                                <button
                                                                    onClick={() => handleApproveWithEdit(c)}
                                                                    disabled={sending[c.id]}
                                                                    style={{ padding: '8px 18px', borderRadius: 8, cursor: 'pointer', background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)', color: CR.green, fontFamily: CR.sans, fontSize: 12, fontWeight: 600, opacity: sending[c.id] ? 0.6 : 1 }}
                                                                >
                                                                    {sending[c.id] ? 'Sending…' : '✓ Send edited'}
                                                                </button>
                                                                <button
                                                                    onClick={() => setEditMode(m => ({ ...m, [c.id]: false }))}
                                                                    style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'transparent', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.sans, fontSize: 12 }}
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </>
                                                        ) : (
                                                            <>
                                                                <button
                                                                    onClick={() => handleApprove(c)}
                                                                    disabled={sending[c.id]}
                                                                    style={{ padding: '8px 18px', borderRadius: 8, cursor: 'pointer', background: 'var(--cr-green-low)', border: '1px solid var(--cr-green-line)', color: CR.green, fontFamily: CR.sans, fontSize: 12, fontWeight: 600, opacity: sending[c.id] ? 0.6 : 1 }}
                                                                >
                                                                    {sending[c.id] ? 'Sending…' : '✓ Approve & Send'}
                                                                </button>
                                                                <button
                                                                    onClick={() => openEdit(c)}
                                                                    style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'transparent', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.sans, fontSize: 12 }}
                                                                >
                                                                    ✎ Edit
                                                                </button>
                                                                <button
                                                                    onClick={() => handleReject(c)}
                                                                    disabled={sending[c.id]}
                                                                    style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'transparent', border: '1px solid var(--cr-error-line)', color: 'var(--cr-error)', fontFamily: CR.sans, fontSize: 12, opacity: sending[c.id] ? 0.6 : 1 }}
                                                                >
                                                                    ✕ Reject
                                                                </button>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            ) : (
                                                /* ── Standard reply box ── */
                                                <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
                                                    <textarea
                                                        value={replies[c.id] ?? ''}
                                                        onChange={e => setReplies(r => ({ ...r, [c.id]: e.target.value }))}
                                                        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleReply(c); }}
                                                        placeholder="Type your feedback… (Ctrl+Enter to send)"
                                                        rows={3}
                                                        style={{ flex: 1, padding: '10px 12px', borderRadius: 8, resize: 'vertical', background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`, color: CR.cream, fontFamily: CR.sans, fontSize: 13, outline: 'none' }}
                                                    />
                                                    <button
                                                        onClick={() => handleReply(c)}
                                                        disabled={sending[c.id] || !replies[c.id]?.trim()}
                                                        style={{ padding: '0 18px', borderRadius: 8, cursor: sending[c.id] ? 'default' : 'pointer', background: replies[c.id]?.trim() ? 'var(--cr-green-low)' : 'var(--cr-tint-3)', border: `1px solid ${replies[c.id]?.trim() ? 'var(--cr-green-line)' : CR.border}`, color: replies[c.id]?.trim() ? CR.green : CR.muted, fontFamily: CR.sans, fontSize: 12, fontWeight: 600, alignSelf: 'flex-end', height: 40, opacity: sending[c.id] ? 0.6 : 1 }}
                                                    >
                                                        {sending[c.id] ? 'Sending…' : 'Send'}
                                                    </button>
                                                </div>
                                            )
                                        ) : (
                                            <div style={{ color: CR.green, fontSize: 13 }}>
                                                ✓ {hasAction ? 'Action fired — email sent' : 'Reply sent — agent will continue shortly'}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

