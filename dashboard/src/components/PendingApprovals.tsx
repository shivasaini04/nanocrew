import { useEffect, useState } from 'react';
import { socket } from '../lib/socket';
import { getPendingApprovals, respondToApproval, type ToolApproval } from '../lib/api';
import { CR } from '../lib/cr';
import { useAgentsStore } from '../stores/agentsStore';

/**
 * Outside-world tool calls held by the Strict posture.
 *
 * Unlike a check-in, the agent is *frozen* on each of these — it stopped
 * mid-task and is polling for an answer. That shapes the whole component: the
 * remaining time is shown because it is real (an unanswered request lapses to
 * denied and the agent gives up), and answering removes the row immediately
 * rather than waiting for a refetch.
 */

/** Mirrors TOOL_APPROVAL_TTL_MS on the server. */
const TTL_MS = 10 * 60 * 1000;

function remaining(createdAt: string): string {
    const left = TTL_MS - (Date.now() - new Date(createdAt).getTime());
    if (left <= 0) return 'expired';
    const mins = Math.floor(left / 60000);
    const secs = Math.floor((left % 60000) / 1000);
    return mins > 0 ? `${mins}m ${secs}s left` : `${secs}s left`;
}

export default function PendingApprovals() {
    const { agents, fetchAgents } = useAgentsStore();
    const [approvals, setApprovals] = useState<ToolApproval[]>([]);
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [error, setError] = useState<string | null>(null);
    // Drives the countdown; the agent is waiting, so a stale timer is misleading.
    const [, setTick] = useState(0);

    async function refresh() {
        try {
            setApprovals(await getPendingApprovals());
        } catch {
            /* transient — the socket or the next tick will re-sync */
        }
    }

    useEffect(() => {
        if (!agents.length) fetchAgents();
        refresh();
        const onChanged = () => refresh();
        socket.on('agent:approval_required', onChanged);
        socket.on('agent:approval_resolved', onChanged);
        const timer = setInterval(() => setTick(t => t + 1), 1000);
        return () => {
            socket.off('agent:approval_required', onChanged);
            socket.off('agent:approval_resolved', onChanged);
            clearInterval(timer);
        };
    }, []);

    async function decide(approval: ToolApproval, decision: 'approve' | 'deny') {
        setBusy(b => ({ ...b, [approval.id]: true }));
        setError(null);
        try {
            await respondToApproval(approval.agent_id, approval.id, decision);
            setApprovals(list => list.filter(a => a.id !== approval.id));
        } catch {
            // Almost always a 409: it lapsed while the tab sat open and the agent
            // already moved on. Re-reading is the honest recovery.
            setError('That request was already settled — it may have expired. Refreshing.');
            refresh();
        } finally {
            setBusy(b => ({ ...b, [approval.id]: false }));
        }
    }

    if (!approvals.length) return null;

    return (
        <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
                <h2 style={{ fontSize: 15, fontWeight: 600, color: CR.text, margin: 0 }}>
                    Waiting on you
                </h2>
                <span style={{ fontSize: 12, color: CR.sub }}>
                    {approvals.length} {approvals.length === 1 ? 'agent is' : 'agents are'} paused mid-task
                </span>
            </div>

            {error && (
                <div style={{ fontSize: 12, color: CR.red, marginBottom: 8 }}>{error}</div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {approvals.map(approval => {
                    const agent = agents.find(a => a.id === approval.agent_id);
                    const left = remaining(approval.created_at);
                    return (
                        <div
                            key={approval.id}
                            style={{
                                border: `1px solid ${CR.amberLine}`,
                                background: CR.amberLow,
                                borderRadius: 8,
                                padding: '12px 14px',
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <div style={{ minWidth: 0, flex: 1 }}>
                                    <div style={{ fontSize: 13, color: CR.text, fontWeight: 600 }}>
                                        {agent?.emoji ?? '🤖'} {agent?.name ?? approval.agent_id} wants to run{' '}
                                        <code style={{ fontFamily: 'monospace' }}>{approval.tool}</code>
                                    </div>
                                    {approval.reason && (
                                        <div style={{ fontSize: 12, color: CR.sub, marginTop: 2 }}>{approval.reason}</div>
                                    )}
                                    {approval.args_preview && (
                                        <pre
                                            style={{
                                                fontSize: 11,
                                                color: CR.sub,
                                                background: CR.bgSurf,
                                                border: `1px solid ${CR.borderSub}`,
                                                borderRadius: 6,
                                                padding: '6px 8px',
                                                marginTop: 8,
                                                marginBottom: 0,
                                                overflowX: 'auto',
                                                whiteSpace: 'pre-wrap',
                                                wordBreak: 'break-word',
                                            }}
                                        >
                                            {approval.args_preview}
                                        </pre>
                                    )}
                                </div>

                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
                                    <span style={{ fontSize: 11, color: left === 'expired' ? CR.red : CR.sub }}>{left}</span>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <button
                                            onClick={() => decide(approval, 'deny')}
                                            disabled={busy[approval.id]}
                                            style={{
                                                fontSize: 12,
                                                padding: '5px 12px',
                                                borderRadius: 6,
                                                border: `1px solid ${CR.border}`,
                                                background: CR.bgCard,
                                                color: CR.text,
                                                cursor: busy[approval.id] ? 'default' : 'pointer',
                                            }}
                                        >
                                            Deny
                                        </button>
                                        <button
                                            onClick={() => decide(approval, 'approve')}
                                            disabled={busy[approval.id]}
                                            style={{
                                                fontSize: 12,
                                                padding: '5px 12px',
                                                borderRadius: 6,
                                                border: `1px solid ${CR.accent}`,
                                                background: CR.accent,
                                                color: CR.onAccent,
                                                cursor: busy[approval.id] ? 'default' : 'pointer',
                                            }}
                                        >
                                            Approve
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
