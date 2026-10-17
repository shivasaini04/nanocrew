import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentsStore } from '../stores/agentsStore';
import { CR, withAlpha } from '../lib/cr';
import { socket } from '../lib/socket';
import { AgentConversations, type Conversation } from '../components/AgentConversations';

interface Handoff {
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    type: string;
    payload: string;
    note?: string;
    // Stage 56 vocabulary. `acknowledged` became `seen` because that is all it ever
    // meant — a cycle ran with the message in context — and it read as "handled" on 347
    // rows. The answered states are the ones that carry information now.
    status: 'pending' | 'seen' | 'agreed' | 'completed' | 'refused' | 'cannot' | 'failed';
    created_at: string;
    completed_at?: string;
    performative?: string;
    reply_to?: string;
    result?: string;
    result_reason?: string;
    replied_at?: string;
}

const STATUS_COLOR: Record<string, string> = {
    pending:   'var(--cr-warn)',
    seen:      'var(--cr-muted)',
    agreed:    'var(--cr-blue)',
    completed: 'var(--cr-green)',
    refused:   'var(--cr-error)',
    cannot:    'var(--cr-purple)',
    failed:    'var(--cr-error)',
};
const STATUS_BG: Record<string, string> = {
    pending:   'var(--cr-amber-low)',
    seen:      'transparent',
    agreed:    'var(--cr-blue-low)',
    completed: 'var(--cr-green-low)',
    refused:   'var(--cr-error-low)',
    cannot:    'var(--cr-purple-low)',
    failed:    'var(--cr-error-low)',
};

type SortKey = 'newest' | 'oldest' | 'duration' | 'type' | 'from' | 'to';
type DateRange = 'all' | 'today' | 'week' | 'month';
type Direction = 'all' | 'inbound' | 'outbound';

function fmtDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
}

function fmtRel(d: string) {
    const delta = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
}

export default function HandoffsInboxPage() {
    const navigate = useNavigate();
    const { agents, fetchAgents } = useAgentsStore();
    const [handoffs, setHandoffs] = useState<Handoff[]>([]);
    const [loading, setLoading]   = useState(true);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [view, setView] = useState<'messages' | 'conversations'>('conversations');
    const [threads, setThreads] = useState<Conversation[]>([]);

    // Filters
    const [statusFilter, setStatusFilter] = useState<'all' | Handoff['status']>('all');
    const [search, setSearch]             = useState('');
    const [sortKey, setSortKey]           = useState<SortKey>('newest');
    const [dateRange, setDateRange]       = useState<DateRange>('all');
    const [direction, setDirection]       = useState<Direction>('all');
    const [agentFilter, setAgentFilter]   = useState<string>(''); // agent id to filter by (either side)
    const [limit, setLimit]               = useState(50);

    useEffect(() => {
        if (!agents.length) fetchAgents();
        load();
        // Real-time updates from the new agent:handoff_updated event
        const onUpdate = () => load();
        socket.on('agent:handoff_updated', onUpdate);
        socket.on('agent:handoff_created', onUpdate);
        return () => {
            socket.off('agent:handoff_updated', onUpdate);
            socket.off('agent:handoff_created', onUpdate);
        };
    }, [limit]);

    async function load() {
        setLoading(true);
        try {
            const [flat, convo] = await Promise.all([
                fetch(`/api/agents/handoffs/recent?limit=${limit}`),
                fetch(`/api/agents/conversations?limit=${limit}`),
            ]);
            if (flat.ok)  setHandoffs(await flat.json());
            if (convo.ok) setThreads(await convo.json());
        } catch { /* silent */ }
        finally { setLoading(false); }
    }

    function agentInfo(id: string) {
        const a = agents.find(x => x.id === id);
        return { name: a?.name ?? id.slice(0, 8) + '…', emoji: a?.emoji ?? '🤖' };
    }

    // Build the filtered + sorted list
    const visible = useMemo(() => {
        const now = Date.now();
        const cutoff = dateRange === 'today' ? now - 24 * 3600 * 1000
                     : dateRange === 'week'  ? now - 7 * 24 * 3600 * 1000
                     : dateRange === 'month' ? now - 30 * 24 * 3600 * 1000
                     : 0;
        const q = search.trim().toLowerCase();
        const filt = handoffs.filter(h => {
            if (statusFilter !== 'all' && h.status !== statusFilter) return false;
            if (cutoff && new Date(h.created_at).getTime() < cutoff) return false;
            if (agentFilter && h.from_agent_id !== agentFilter && h.to_agent_id !== agentFilter) return false;
            if (direction === 'inbound'  && (!agentFilter || h.to_agent_id !== agentFilter)) {
                // Without an agent selected, inbound/outbound is meaningless — skip the filter
                if (agentFilter) return false;
            }
            if (direction === 'outbound' && (!agentFilter || h.from_agent_id !== agentFilter)) {
                if (agentFilter) return false;
            }
            if (!q) return true;
            const fromName = agentInfo(h.from_agent_id).name.toLowerCase();
            const toName   = agentInfo(h.to_agent_id).name.toLowerCase();
            const haystack = `${fromName} ${toName} ${h.type} ${h.note ?? ''} ${h.payload}`.toLowerCase();
            return haystack.includes(q);
        });

        const cmp = (a: Handoff, b: Handoff) => {
            switch (sortKey) {
                case 'newest':   return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
                case 'oldest':   return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
                case 'type':     return a.type.localeCompare(b.type);
                case 'from':     return agentInfo(a.from_agent_id).name.localeCompare(agentInfo(b.from_agent_id).name);
                case 'to':       return agentInfo(a.to_agent_id).name.localeCompare(agentInfo(b.to_agent_id).name);
                case 'duration': {
                    const da = a.completed_at ? new Date(a.completed_at).getTime() - new Date(a.created_at).getTime() : Number.POSITIVE_INFINITY;
                    const db = b.completed_at ? new Date(b.completed_at).getTime() - new Date(b.created_at).getTime() : Number.POSITIVE_INFINITY;
                    return da - db;
                }
                default: return 0;
            }
        };
        return [...filt].sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [handoffs, statusFilter, search, sortKey, dateRange, direction, agentFilter, agents]);

    const statusCounts = useMemo(() => {
        const c: Record<string, number> = {};
        for (const h of handoffs) c[h.status] = (c[h.status] ?? 0) + 1;
        return c;
    }, [handoffs]);

    const pendingCount = statusCounts.pending ?? 0;

    return (
        <div style={{ flex: 1, overflow: 'auto', background: CR.bgMain, padding: '32px 36px', fontFamily: CR.sans }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
                <div>
                    <h1 style={{ fontFamily: CR.serif, fontSize: 26, fontWeight: 400, color: CR.cream, margin: 0 }}>Handoffs</h1>
                    <p style={{ color: CR.muted, fontSize: 13, margin: '4px 0 0' }}>
                        Agent-to-agent task transfers · showing {visible.length} of {handoffs.length}
                        {pendingCount > 0 && <span style={{ color: 'var(--cr-warn)', marginLeft: 8 }}>· {pendingCount} pending</span>}
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    {/* Conversations vs the flat list. Threads are the default: an answer
                        read apart from the question it answers is how "24 sent" gets
                        attached to the wrong batch. */}
                    <div style={{ display: 'flex', background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`, borderRadius: 8, padding: 2 }}>
                        {(['conversations', 'messages'] as const).map(v => (
                            <button key={v} onClick={() => setView(v)} style={{
                                padding: '5px 12px', borderRadius: 6, cursor: 'pointer', border: 'none',
                                background: view === v ? CR.bgCard : 'transparent',
                                color: view === v ? CR.cream : CR.muted,
                                fontFamily: CR.sans, fontSize: 11.5, fontWeight: view === v ? 600 : 400,
                            }}>
                                {v === 'conversations' ? 'Conversations' : 'All messages'}
                            </button>
                        ))}
                    </div>
                    <button onClick={load} style={{ background: 'none', border: 'none', color: 'var(--cr-accent)', cursor: 'pointer', fontFamily: CR.mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 0' }}>
                        ↺ Refresh
                    </button>
                </div>
            </div>

            {view === 'conversations' ? (
                <AgentConversations
                    threads={threads}
                    loading={loading}
                    emoji={id => agentInfo(id).emoji}
                    onOpenAgent={id => navigate(`/agents/${id}`)}
                />
            ) : (
            <>
            {/* Filter bar */}
            <div style={{
                background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 10,
                padding: '12px 14px', marginBottom: 16,
                display: 'flex', flexDirection: 'column', gap: 10,
            }}>
                {/* Row 1: search + sort */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="🔍 Search by note, payload, agent name, or type"
                        style={{
                            flex: 1, padding: '8px 12px', borderRadius: 8,
                            background: 'var(--cr-well)', border: `1px solid ${CR.border}`,
                            color: CR.cream, fontFamily: CR.sans, fontSize: 13, outline: 'none',
                        }}
                    />
                    <select
                        value={sortKey}
                        onChange={e => setSortKey(e.target.value as SortKey)}
                        title="Sort by"
                        style={{
                            padding: '8px 10px', borderRadius: 8,
                            background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`,
                            color: CR.cream, fontFamily: CR.sans, fontSize: 12, cursor: 'pointer',
                        }}>
                        <option value="newest">Newest first</option>
                        <option value="oldest">Oldest first</option>
                        <option value="duration">Shortest duration</option>
                        <option value="type">By type</option>
                        <option value="from">By sender</option>
                        <option value="to">By recipient</option>
                    </select>
                </div>

                {/* Row 2: status + date + agent + direction */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    {/* Status pills */}
                    {(['all', 'pending', 'seen', 'agreed', 'completed', 'refused', 'cannot', 'failed'] as const).map(f => {
                        const count = f === 'all' ? handoffs.length : (statusCounts[f] ?? 0);
                        const c = f === 'all' ? 'var(--cr-accent)' : STATUS_COLOR[f];
                        const active = statusFilter === f;
                        return (
                            <button key={f} onClick={() => setStatusFilter(f)} style={{
                                padding: '4px 10px', borderRadius: 100, cursor: 'pointer',
                                fontFamily: CR.mono, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: '0.05em',
                                background: active ? `${withAlpha(c, 13)}` : 'transparent',
                                border: `1px solid ${active ? withAlpha(c, 31) : CR.border}`,
                                color: active ? c : CR.muted,
                                display: 'inline-flex', alignItems: 'center', gap: 5,
                            }}>
                                {f}<span style={{ opacity: 0.6 }}>{count}</span>
                            </button>
                        );
                    })}
                    <span style={{ width: 1, height: 16, background: CR.border, margin: '0 4px' }} />

                    {/* Date range */}
                    <select
                        value={dateRange}
                        onChange={e => setDateRange(e.target.value as DateRange)}
                        title="Date range"
                        style={{
                            padding: '4px 8px', borderRadius: 100, cursor: 'pointer',
                            background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`,
                            color: CR.sub, fontFamily: CR.mono, fontSize: 9.5, textTransform: 'uppercase',
                        }}>
                        <option value="all">📅 All time</option>
                        <option value="today">📅 Today</option>
                        <option value="week">📅 7 days</option>
                        <option value="month">📅 30 days</option>
                    </select>

                    {/* Agent filter */}
                    <select
                        value={agentFilter}
                        onChange={e => setAgentFilter(e.target.value)}
                        title="Filter by agent (either side)"
                        style={{
                            padding: '4px 8px', borderRadius: 100, cursor: 'pointer',
                            background: agentFilter ? 'var(--cr-purple-low)' : 'var(--cr-tint-3)',
                            border: `1px solid ${agentFilter ? 'var(--cr-purple-line)' : CR.border}`,
                            color: agentFilter ? 'var(--cr-purple)' : CR.sub,
                            fontFamily: CR.mono, fontSize: 9.5, textTransform: 'uppercase',
                            maxWidth: 200,
                        }}>
                        <option value="">🤖 Any agent</option>
                        {agents.map(a => (
                            <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                    </select>

                    {/* Direction (only meaningful when agent selected) */}
                    {agentFilter && (
                        <div style={{ display: 'inline-flex', borderRadius: 100, border: `1px solid ${CR.border}`, overflow: 'hidden' }}>
                            {(['all', 'inbound', 'outbound'] as const).map(d => (
                                <button key={d} onClick={() => setDirection(d)} style={{
                                    padding: '4px 10px', cursor: 'pointer',
                                    background: direction === d ? 'var(--cr-purple-low)' : 'transparent',
                                    border: 'none',
                                    color: direction === d ? 'var(--cr-purple)' : CR.muted,
                                    fontFamily: CR.mono, fontSize: 9, textTransform: 'uppercase',
                                }}>
                                    {d === 'all' ? 'both' : d === 'inbound' ? '↓ in' : '↑ out'}
                                </button>
                            ))}
                        </div>
                    )}

                    {/* Clear filters */}
                    {(search || statusFilter !== 'all' || dateRange !== 'all' || agentFilter || direction !== 'all') && (
                        <button onClick={() => { setSearch(''); setStatusFilter('all'); setDateRange('all'); setAgentFilter(''); setDirection('all'); }}
                            style={{ padding: '4px 10px', borderRadius: 100, cursor: 'pointer', background: 'transparent', border: `1px dashed ${CR.border}`, color: CR.muted, fontFamily: CR.mono, fontSize: 9.5 }}>
                            ✕ clear filters
                        </button>
                    )}
                </div>
            </div>

            {loading ? (
                <div style={{ color: CR.muted, fontSize: 13 }}>Loading…</div>
            ) : visible.length === 0 ? (
                <div style={{ background: CR.bgCard, border: `1px solid ${CR.border}`, borderRadius: 12, padding: 48, textAlign: 'center' }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>🤝</div>
                    <div style={{ color: CR.cream, fontSize: 15, marginBottom: 6 }}>
                        {handoffs.length === 0 ? 'No handoffs yet' : 'No handoffs match your filters'}
                    </div>
                    <div style={{ color: CR.muted, fontSize: 13 }}>
                        {handoffs.length === 0 ? 'Agent-to-agent task transfers will appear here' : 'Try clearing filters or expanding the date range.'}
                    </div>
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {visible.map(h => {
                        const isOpen   = !!expanded[h.id];
                        const payload  = (() => { try { return JSON.parse(h.payload); } catch { return h.payload; } })();
                        const color    = STATUS_COLOR[h.status] ?? CR.muted;
                        const bg       = STATUS_BG[h.status]    ?? 'transparent';
                        const from     = agentInfo(h.from_agent_id);
                        const to       = agentInfo(h.to_agent_id);
                        const duration = h.completed_at ? new Date(h.completed_at).getTime() - new Date(h.created_at).getTime() : null;

                        return (
                            <div key={h.id} style={{
                                background: CR.bgCard, border: `1px solid ${CR.border}`,
                                borderRadius: 10, overflow: 'hidden',
                            }}>
                                <div
                                    onClick={() => setExpanded(e => ({ ...e, [h.id]: !isOpen }))}
                                    style={{ padding: '13px 18px', display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer', borderBottom: isOpen ? `1px solid ${CR.border}` : 'none' }}
                                >
                                    {/* From → To */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                        <span style={{ fontSize: 18 }} title={from.name}>{from.emoji}</span>
                                        <span style={{ color: CR.muted, fontSize: 13 }}>→</span>
                                        <span style={{ fontSize: 18 }} title={to.name}>{to.emoji}</span>
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                            <span style={{ color: CR.cream, fontSize: 13, fontWeight: 600 }}>{from.name}</span>
                                            <span style={{ color: CR.muted, fontSize: 12 }}>→</span>
                                            <span style={{ color: CR.cream, fontSize: 13, fontWeight: 600 }}>{to.name}</span>
                                            <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '1px 7px', borderRadius: 4, background: 'var(--cr-tint-4)', border: `1px solid ${CR.border}`, color: CR.muted, textTransform: 'uppercase' }}>
                                                {h.type}
                                            </span>
                                        </div>
                                        {h.note && (
                                            <div style={{ color: CR.muted, fontSize: 12, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {h.note}
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                                        <span style={{ fontFamily: CR.mono, fontSize: 9, padding: '2px 8px', borderRadius: 100, background: bg, border: `1px solid ${withAlpha(color, 19)}`, color, textTransform: 'uppercase' }}>
                                            {h.status}
                                        </span>
                                        {duration !== null && (
                                            <span title="time from created → completed" style={{ fontFamily: CR.mono, fontSize: 10, color: CR.sub }}>
                                                ⏱ {fmtDuration(duration)}
                                            </span>
                                        )}
                                        <span style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted }}>{fmtRel(h.created_at)}</span>
                                        <span style={{ color: CR.muted, fontSize: 12, transform: isOpen ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>›</span>
                                    </div>
                                </div>

                                {isOpen && (
                                    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button onClick={() => navigate(`/agents/${h.from_agent_id}`)} style={{ padding: '4px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.sans, fontSize: 11 }}>
                                                ↗ Open sender ({from.name})
                                            </button>
                                            <button onClick={() => navigate(`/agents/${h.to_agent_id}`)} style={{ padding: '4px 12px', borderRadius: 6, cursor: 'pointer', background: 'transparent', border: `1px solid ${CR.border}`, color: CR.muted, fontFamily: CR.sans, fontSize: 11 }}>
                                                ↗ Open recipient ({to.name})
                                            </button>
                                        </div>
                                        {/* The answer. Before stage 56 there was nowhere to put one, so
                                            every row in this list ended at "delivered". */}
                                        {h.result && (
                                            <div>
                                                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                                                    {to.name} answered — {h.status}
                                                </div>
                                                <div style={{ background: withAlpha(STATUS_COLOR[h.status] ?? CR.muted, 10), border: `1px solid ${withAlpha(STATUS_COLOR[h.status] ?? CR.border, 25)}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: CR.text, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                                    {h.result}
                                                    {h.result_reason && (
                                                        <div style={{ marginTop: 8, color: CR.muted, fontSize: 12 }}>
                                                            {h.status === 'cannot' ? 'Missing: ' : h.status === 'failed' ? 'Error: ' : 'Reason: '}{h.result_reason}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        {h.note && (
                                            <div>
                                                <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Note</div>
                                                <div style={{ background: 'var(--cr-tint-2)', border: `1px solid ${CR.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: CR.text, lineHeight: 1.6 }}>
                                                    {h.note}
                                                </div>
                                            </div>
                                        )}
                                        <div>
                                            <div style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Payload</div>
                                            <pre style={{
                                                background: 'var(--cr-well)', border: `1px solid ${CR.border}`, borderRadius: 8,
                                                padding: '12px 14px', fontFamily: CR.mono, fontSize: 11, color: CR.text,
                                                margin: 0, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                                maxHeight: 240,
                                            }}>
                                                {typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}
                                            </pre>
                                        </div>
                                        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', fontFamily: CR.mono, fontSize: 10, color: CR.muted }}>
                                            <span>created: {new Date(h.created_at).toLocaleString()}</span>
                                            {h.completed_at && <span>completed: {new Date(h.completed_at).toLocaleString()}</span>}
                                            {duration !== null && <span>duration: {fmtDuration(duration)}</span>}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Pagination — load more */}
            {!loading && handoffs.length >= limit && (
                <div style={{ marginTop: 20, textAlign: 'center' }}>
                    <button onClick={() => setLimit(l => l + 50)} style={{
                        padding: '8px 22px', borderRadius: 8, cursor: 'pointer',
                        background: 'var(--cr-tint-3)', border: `1px solid ${CR.border}`,
                        color: CR.sub, fontFamily: CR.sans, fontSize: 12,
                    }}>
                        Load 50 more (current limit: {limit})
                    </button>
                </div>
            )}
            </>
            )}
        </div>
    );
}


