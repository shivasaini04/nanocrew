import { useEffect, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

interface EscalationStep {
    action: string;
    target?: string;
    url?: string;
    description?: string;
    isExternal?: boolean;
    isDangerous?: boolean;
    step?: number;
    text?: string;
}

interface Escalation {
    id: string;
    agentId: string;
    runId: string;
    step: EscalationStep;
    createdAt: string;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes, matches server

function useCountdown(createdAt: string): string {
    const [remaining, setRemaining] = useState('');

    useEffect(() => {
        function update() {
            const elapsed = Date.now() - new Date(createdAt).getTime();
            const left = TIMEOUT_MS - elapsed;
            if (left <= 0) { setRemaining('expired'); return; }
            const m = Math.floor(left / 60000);
            const s = Math.floor((left % 60000) / 1000);
            setRemaining(`${m}:${s.toString().padStart(2, '0')}`);
        }
        update();
        const t = setInterval(update, 1000);
        return () => clearInterval(t);
    }, [createdAt]);

    return remaining;
}

function EscalationCard({
    esc,
    onApprove,
    onDeny,
    busy,
}: {
    esc: Escalation;
    onApprove: (id: string) => void;
    onDeny: (id: string) => void;
    busy: boolean;
}) {
    const navigate = useNavigate();
    const countdown = useCountdown(esc.createdAt);
    const isExpiring = (() => {
        const left = TIMEOUT_MS - (Date.now() - new Date(esc.createdAt).getTime());
        return left < 60000;
    })();

    const desc = esc.step.description ?? `${esc.step.action} ${esc.step.target ?? esc.step.url ?? ''}`;

    return (
        <div style={{
            background: 'var(--cr-surface2)',
            border: `1px solid ${isExpiring ? 'var(--cr-error-str)' : 'var(--cr-border)'}`,
            borderRadius: '12px',
            padding: '20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
        }}>
            {/* Header row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: '6px',
                    background: 'var(--cr-error-low)',
                    color: 'var(--cr-error-str)',
                    letterSpacing: '0.04em',
                    textTransform: 'uppercase',
                }}>⚠ Approval Required</span>
                <span
                    onClick={() => navigate(`/agents/${esc.agentId}`)}
                    style={{ fontSize: '12px', color: 'var(--cr-accent)', cursor: 'pointer', textDecoration: 'underline' }}
                >Agent {esc.agentId.slice(0, 8)}…</span>
                <span style={{ fontSize: '11px', color: 'var(--cr-muted)', fontFamily: 'monospace' }}>
                    run {esc.runId.slice(0, 8)}…
                </span>
                <span style={{
                    marginLeft: 'auto',
                    fontSize: '13px',
                    fontWeight: 600,
                    color: isExpiring ? 'var(--cr-error-str)' : 'var(--cr-muted)',
                    fontFamily: 'monospace',
                }}>{countdown === 'expired' ? 'Auto-denied (expired)' : `⏱ ${countdown}`}</span>
            </div>

            {/* Action description */}
            <div style={{ fontSize: '14px', color: 'var(--cr-text)', lineHeight: 1.5 }}>
                <span style={{ fontWeight: 600 }}>Action: </span>
                <code style={{ fontFamily: 'monospace', fontSize: '13px', color: 'var(--cr-accent)' }}>{esc.step.action}</code>
                {esc.step.target && (
                    <> on <code style={{ fontFamily: 'monospace', fontSize: '13px' }}>{esc.step.target}</code></>
                )}
            </div>
            <div style={{ fontSize: '13px', color: 'var(--cr-muted)', lineHeight: 1.5 }}>{desc}</div>

            {esc.step.url && (
                <div style={{ fontSize: '12px', color: 'var(--cr-muted)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                    URL: {esc.step.url}
                </div>
            )}

            {esc.step.text && (
                <div style={{ fontSize: '12px', color: 'var(--cr-muted)' }}>
                    Text to type: <code style={{ fontFamily: 'monospace' }}>{esc.step.text}</code>
                </div>
            )}

            {/* Buttons */}
            {countdown !== 'expired' && (
                <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                    <button
                        onClick={() => onApprove(esc.id)}
                        disabled={busy}
                        style={{
                            flex: 1,
                            padding: '9px 0',
                            borderRadius: '8px',
                            border: 'none',
                            background: 'var(--cr-green)',
                            color: 'var(--cr-on-accent)',
                            fontWeight: 600,
                            fontSize: '13px',
                            cursor: busy ? 'default' : 'pointer',
                            opacity: busy ? 0.6 : 1,
                        }}
                    >✓ Approve</button>
                    <button
                        onClick={() => onDeny(esc.id)}
                        disabled={busy}
                        style={{
                            flex: 1,
                            padding: '9px 0',
                            borderRadius: '8px',
                            border: '1px solid var(--cr-error-str)',
                            background: 'transparent',
                            color: 'var(--cr-error-str)',
                            fontWeight: 600,
                            fontSize: '13px',
                            cursor: busy ? 'default' : 'pointer',
                            opacity: busy ? 0.6 : 1,
                        }}
                    >✕ Deny</button>
                </div>
            )}
        </div>
    );
}

export default function ApprovalsPage() {
    const [escalations, setEscalations] = useState<Escalation[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const fetchEscalations = useCallback(async () => {
        try {
            const res = await fetch('/api/computer-use/escalations');
            const data = await res.json();
            setEscalations(data.escalations ?? []);
        } catch { /* ignore */ }
    }, []);

    useEffect(() => {
        setLoading(true);
        fetchEscalations().finally(() => setLoading(false));

        // Poll every 15s as fallback
        pollRef.current = setInterval(fetchEscalations, 15000);

        // Listen for socket-pushed refresh events
        const handler = () => fetchEscalations();
        window.addEventListener('escalation:refresh', handler);

        return () => {
            if (pollRef.current) clearInterval(pollRef.current);
            window.removeEventListener('escalation:refresh', handler);
        };
    }, [fetchEscalations]);

    async function decide(approvalId: string, decision: 'approve' | 'deny') {
        setBusy(approvalId);
        try {
            await fetch(`/api/computer-use/escalations/${approvalId}/${decision}`, { method: 'POST' });
            setEscalations(prev => prev.filter(e => e.id !== approvalId));
        } catch (e: any) {
            alert(e.message);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div style={{ padding: '32px', maxWidth: '760px', margin: '0 auto', fontFamily: 'var(--cr-font-sans)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                <h1 style={{ fontSize: '22px', fontWeight: 700, color: 'var(--cr-text)', margin: 0 }}>Approvals</h1>
                {escalations.length > 0 && (
                    <span style={{
                        background: 'var(--cr-error-str)',
                        color: 'var(--cr-on-accent)',
                        borderRadius: '999px',
                        fontSize: '11px',
                        fontWeight: 700,
                        padding: '2px 8px',
                    }}>{escalations.length}</span>
                )}
            </div>
            <p style={{ fontSize: '13px', color: 'var(--cr-muted)', marginBottom: '24px' }}>
                Browser-automation agents are paused waiting for your approval on dangerous actions.
                Auto-denied after 5 minutes.
            </p>

            {loading && (
                <div style={{ textAlign: 'center', padding: '60px', color: 'var(--cr-muted)', fontSize: '13px' }}>Loading…</div>
            )}

            {!loading && escalations.length === 0 && (
                <div style={{
                    textAlign: 'center',
                    padding: '80px 0',
                    color: 'var(--cr-muted)',
                    fontSize: '14px',
                }}>
                    <div style={{ fontSize: '36px', marginBottom: '12px' }}>✓</div>
                    No pending approvals — all clear.
                </div>
            )}

            {!loading && escalations.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                    {escalations.map(esc => (
                        <EscalationCard
                            key={esc.id}
                            esc={esc}
                            onApprove={id => decide(id, 'approve')}
                            onDeny={id => decide(id, 'deny')}
                            busy={busy === esc.id}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}
