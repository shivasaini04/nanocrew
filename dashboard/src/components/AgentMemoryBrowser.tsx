/**
 * AgentMemoryBrowser — searchable/filterable browser of everything the agent knows.
 * Shows memory entries by type, identity history with diff viewer, and manual add.
 */
import { useEffect, useState, useMemo } from 'react';
import { Plus, Trash2, ChevronDown, ChevronUp, X } from 'lucide-react';
import { withAlpha } from '../lib/cr'

type MemoryType = 'lesson' | 'pattern' | 'failure' | 'win' | 'icp_update';

interface AgentMemory {
    id: string;
    agent_id: string;
    type: MemoryType;
    content: string;
    source_cycle?: string;
    relevance: number;
    used_count: number;
    created_at: string;
}

interface IdentityVersion {
    version: number;
    path: string;
    modified: string;
}

interface AgentMemoryBrowserProps {
    agentId: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const TYPE_CONFIG: Record<MemoryType, { icon: string; label: string; color: string; bg: string }> = {
    lesson:     { icon: '📗', label: 'LESSON',     color: 'var(--accent-cyan)',   bg: 'var(--cr-cyan-low)'    },
    pattern:    { icon: '🔁', label: 'PATTERN',    color: 'var(--accent-green)',  bg: 'var(--cr-green-low)'   },
    failure:    { icon: '⚠️', label: 'FAILURE',    color: 'var(--accent-amber)',  bg: 'var(--cr-amber-low)'   },
    win:        { icon: '🏆', label: 'WIN',        color: 'var(--accent-green)',  bg: 'var(--cr-green-low)'   },
    icp_update: { icon: '📘', label: 'ICP UPDATE', color: 'var(--accent-purple)', bg: 'var(--cr-purple-low)'   },
};

const ALL_TYPES = Object.keys(TYPE_CONFIG) as MemoryType[];

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
}

// ─── Diff viewer ──────────────────────────────────────────────────────────────

function IdentityDiffModal({
    agentId, fromVersion, toVersion, onClose,
}: { agentId: string; fromVersion: number; toVersion: number; onClose: () => void }) {
    const [from, setFrom] = useState<string | null>(null);
    const [to, setTo] = useState<string | null>(null);

    useEffect(() => {
        Promise.all([
            fetch(`/api/agents/${agentId}/identity-history/${fromVersion}`).then(r => r.ok ? r.json() : null),
            fetch(`/api/agents/${agentId}/identity-history/${toVersion}`).then(r => r.ok ? r.json() : null),
        ]).then(([a, b]) => { setFrom(a?.content ?? null); setTo(b?.content ?? null); });
    }, [agentId, fromVersion, toVersion]);

    const diffLines = useMemo(() => {
        if (!from || !to) return [];
        const fromLines = from.split('\n');
        const toLines = to.split('\n');
        const result: { text: string; type: 'added' | 'removed' | 'same' }[] = [];
        // Simple line diff
        const toSet = new Set(toLines);
        const fromSet = new Set(fromLines);
        for (const l of fromLines) { if (!toSet.has(l)) result.push({ text: l, type: 'removed' }); }
        for (const l of toLines)   { if (!fromSet.has(l)) result.push({ text: l, type: 'added' }); }
        return result;
    }, [from, to]);

    return (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal-container" style={{ maxWidth: '720px', width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ fontWeight: 600, fontSize: '14px' }}>
                        Identity diff: v{fromVersion} → v{toVersion}
                    </h3>
                    <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                        <X size={18} />
                    </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: '11px', lineHeight: 1.6 }}>
                    {diffLines.length === 0 && (!from || !to) && (
                        <div style={{ color: 'var(--text-muted)', padding: '20px', textAlign: 'center' }}>Loading…</div>
                    )}
                    {diffLines.length === 0 && from && to && (
                        <div style={{ color: 'var(--text-muted)', padding: '20px', textAlign: 'center' }}>No differences found.</div>
                    )}
                    {diffLines.map((line, i) => (
                        <div key={i} style={{
                            padding: '1px 12px',
                            background: line.type === 'added' ? 'var(--cr-green-low)' : line.type === 'removed' ? 'var(--cr-error-low)' : 'transparent',
                            color: line.type === 'added' ? 'var(--accent-green)' : line.type === 'removed' ? 'var(--accent-red)' : 'var(--text-secondary)',
                            whiteSpace: 'pre-wrap',
                        }}>
                            {line.type === 'added' ? '+ ' : line.type === 'removed' ? '- ' : '  '}{line.text}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ─── Identity History section ─────────────────────────────────────────────────

function IdentityHistory({ agentId }: { agentId: string }) {
    const [versions, setVersions] = useState<IdentityVersion[]>([]);
    const [viewContent, setViewContent] = useState<string | null>(null);
    const [viewVersion, setViewVersion] = useState<number | null>(null);
    const [diffFrom, setDiffFrom] = useState<number | null>(null);
    const [diffTo, setDiffTo] = useState<number | null>(null);
    const [showDiff, setShowDiff] = useState(false);
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        fetch(`/api/agents/${agentId}/identity-history`)
            .then(r => r.ok ? r.json() : [])
            .then(setVersions)
            .catch(() => {});
    }, [agentId]);

    function viewVersion_(v: number) {
        fetch(`/api/agents/${agentId}/identity-history/${v}`)
            .then(r => r.ok ? r.json() : null)
            .then(d => { setViewContent(d?.content ?? null); setViewVersion(v); });
    }

    return (
        <div style={{ marginTop: '24px', borderTop: '1px solid var(--border-subtle)', paddingTop: '20px' }}>
            <button
                onClick={() => setExpanded(e => !e)}
                style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '13px', fontWeight: 600, padding: 0 }}
            >
                {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                Identity History ({versions.length} versions)
            </button>

            {expanded && (
                <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {versions.length === 0 && (
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No archived versions yet.</div>
                    )}
                    {versions.map((v, i) => (
                        <div key={v.version} style={{
                            display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px',
                            borderRadius: 'var(--radius-md)', background: 'var(--cr-tint-2)',
                            border: '1px solid var(--border-subtle)', fontSize: '12px',
                        }}>
                            <span style={{ fontFamily: 'monospace', color: 'var(--accent-cyan)', fontWeight: 600 }}>v{v.version}</span>
                            <span style={{ color: 'var(--text-muted)', flex: 1 }}>{new Date(v.modified).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                            <button
                                onClick={() => viewVersion_(v.version)}
                                style={{ color: 'var(--accent-cyan)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px' }}
                            >View</button>
                            {i < versions.length - 1 && (
                                <button
                                    onClick={() => { setDiffFrom(v.version); setDiffTo(versions[i + 1].version); setShowDiff(true); }}
                                    style={{ color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', fontSize: '11px' }}
                                >
                                    Compare v{v.version} → v{versions[i + 1].version}
                                </button>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* View modal */}
            {viewContent !== null && (
                <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) { setViewContent(null); setViewVersion(null); } }}>
                    <div className="modal-container" style={{ maxWidth: '680px', width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                            <h3 style={{ fontWeight: 600, fontSize: '14px' }}>IDENTITY.md — v{viewVersion}</h3>
                            <button onClick={() => { setViewContent(null); setViewVersion(null); }} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                                <X size={18} />
                            </button>
                        </div>
                        <pre style={{ flex: 1, overflowY: 'auto', fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', margin: 0, lineHeight: 1.6 }}>
                            {viewContent}
                        </pre>
                    </div>
                </div>
            )}

            {/* Diff modal */}
            {showDiff && diffFrom !== null && diffTo !== null && (
                <IdentityDiffModal agentId={agentId} fromVersion={diffFrom} toVersion={diffTo} onClose={() => setShowDiff(false)} />
            )}
        </div>
    );
}

// ─── Add Memory form ──────────────────────────────────────────────────────────

function AddMemoryForm({ agentId, onAdded }: { agentId: string; onAdded: (m: AgentMemory) => void }) {
    const [type, setType] = useState<MemoryType>('lesson');
    const [content, setContent] = useState('');
    const [saving, setSaving] = useState(false);

    async function handleAdd() {
        if (!content.trim() || saving) return;
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agentId}/memory`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, content: content.trim() }),
            });
            if (res.ok) {
                const mem: AgentMemory = await res.json();
                onAdded(mem);
                setContent('');
            }
        } finally { setSaving(false); }
    }

    return (
        <div style={{ padding: '14px', background: 'var(--cr-tint-1)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', marginBottom: '16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.08em' }}>ADD MEMORY</div>
            <div style={{ display: 'flex', gap: '8px' }}>
                <select
                    value={type}
                    onChange={e => setType(e.target.value as MemoryType)}
                    style={{ padding: '6px 10px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer' }}
                >
                    {ALL_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
                <textarea
                    value={content}
                    onChange={e => setContent(e.target.value)}
                    placeholder="Enter a specific, actionable insight or lesson…"
                    rows={2}
                    style={{ flex: 1, padding: '6px 10px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-primary)', fontSize: '12px', resize: 'none', fontFamily: 'inherit' }}
                    onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent-cyan)')}
                    onBlur={e => (e.currentTarget.style.borderColor = 'var(--border-default)')}
                />
                <button
                    onClick={handleAdd}
                    disabled={!content.trim() || saving}
                    style={{ padding: '6px 14px', borderRadius: 'var(--radius-md)', background: content.trim() ? 'var(--cr-cyan-low)' : 'var(--cr-tint-3)', border: '1px solid ' + (content.trim() ? 'var(--cr-cyan-line)' : 'var(--border-default)'), color: content.trim() ? 'var(--accent-cyan)' : 'var(--text-muted)', cursor: content.trim() ? 'pointer' : 'not-allowed', fontSize: '12px', fontWeight: 600, alignSelf: 'flex-end', flexShrink: 0 }}
                >
                    {saving ? '…' : 'Add'}
                </button>
            </div>
        </div>
    );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AgentMemoryBrowser({ agentId }: AgentMemoryBrowserProps) {
    const [memories, setMemories] = useState<AgentMemory[]>([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState<MemoryType | 'all'>('all');
    const [search, setSearch] = useState('');
    const [showAddForm, setShowAddForm] = useState(false);

    useEffect(() => {
        setLoading(true);
        fetch(`/api/agents/${agentId}/memory`)
            .then(r => r.ok ? r.json() : [])
            .then((d: AgentMemory[]) => { setMemories(d); setLoading(false); })
            .catch(() => setLoading(false));
    }, [agentId]);

    const displayed = useMemo(() => {
        let list = memories;
        if (filter !== 'all') list = list.filter(m => m.type === filter);
        if (search.trim()) list = list.filter(m => m.content.toLowerCase().includes(search.toLowerCase()));
        return list;
    }, [memories, filter, search]);

    const counts = useMemo(() => {
        const c: Partial<Record<MemoryType | 'all', number>> = { all: memories.length };
        for (const t of ALL_TYPES) c[t] = memories.filter(m => m.type === t).length;
        return c;
    }, [memories]);

    const lastUpdated = memories.length > 0
        ? timeAgo(memories.sort((a, b) => b.created_at.localeCompare(a.created_at))[0].created_at)
        : 'never';

    async function handleDelete(id: string) {
        setMemories(prev => prev.filter(m => m.id !== id)); // optimistic
        await fetch(`/api/agents/${agentId}/memory/${id}`, { method: 'DELETE' }).catch(() => {});
    }

    function handleAdded(mem: AgentMemory) {
        setMemories(prev => [mem, ...prev]);
        setShowAddForm(false);
    }

    return (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '0' }}>
            {/* Stats bar */}
            <div style={{ display: 'flex', gap: '20px', marginBottom: '16px', padding: '10px 14px', background: 'var(--cr-tint-1)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-subtle)', flexWrap: 'wrap' }}>
                <div>
                    <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent-cyan)' }}>{memories.length}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Total memories</div>
                </div>
                {ALL_TYPES.filter(t => (counts[t] ?? 0) > 0).map(t => {
                    const cfg = TYPE_CONFIG[t];
                    return (
                        <div key={t}>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: cfg.color }}>{counts[t]}</div>
                            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{t.replace('_', ' ')}</div>
                        </div>
                    );
                })}
                <div style={{ marginLeft: 'auto', alignSelf: 'center' }}>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Last updated: {lastUpdated}</div>
                </div>
            </div>

            {/* Controls */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', flex: 1 }}>
                    {(['all', ...ALL_TYPES] as const).map(t => {
                        const isAll = t === 'all';
                        const cfg = isAll ? null : TYPE_CONFIG[t];
                        const active = filter === t;
                        const count = counts[t] ?? 0;
                        if (!isAll && count === 0) return null;
                        return (
                            <button
                                key={t}
                                onClick={() => setFilter(t)}
                                style={{
                                    padding: '4px 10px', borderRadius: '100px', fontSize: '11px', cursor: 'pointer',
                                    fontWeight: active ? 700 : 400,
                                    background: active ? (cfg?.bg ?? 'var(--cr-cyan-low)') : 'var(--cr-tint-3)',
                                    border: active ? `1px solid ${cfg?.color ?? 'var(--accent-cyan)'}` : '1px solid var(--border-default)',
                                    color: active ? (cfg?.color ?? 'var(--accent-cyan)') : 'var(--text-muted)',
                                }}
                            >
                                {isAll ? `All (${count})` : `${cfg!.icon} ${t.replace('_', ' ')} (${count})`}
                            </button>
                        );
                    })}
                </div>
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search memories…"
                    style={{ padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'var(--bg-elevated)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: '12px', minWidth: '160px' }}
                />
                <button
                    onClick={() => setShowAddForm(s => !s)}
                    style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 10px', borderRadius: 'var(--radius-md)', background: 'var(--cr-cyan-low)', border: '1px solid var(--cr-cyan-line)', color: 'var(--accent-cyan)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                >
                    <Plus size={12} /> Add Memory
                </button>
            </div>

            {/* Add form */}
            {showAddForm && <AddMemoryForm agentId={agentId} onAdded={handleAdded} />}

            {/* Memory list */}
            {loading ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>
            ) : displayed.length === 0 ? (
                <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                    {memories.length === 0 ? 'No memories yet. Run a self_improve cycle to start learning.' : 'No matches.'}
                </div>
            ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {displayed.map(mem => {
                        const cfg = TYPE_CONFIG[mem.type];
                        return (
                            <div key={mem.id} style={{ display: 'flex', gap: '12px', padding: '10px 12px', borderRadius: 'var(--radius-md)', background: cfg.bg, border: `1px solid ${withAlpha(cfg.color, 20)}` }}>
                                <div style={{ flexShrink: 0, paddingTop: '2px' }}>
                                    <span style={{ fontSize: '10px', fontWeight: 700, color: cfg.color, padding: '2px 6px', borderRadius: '3px', background: `${withAlpha(cfg.color, 13)}`, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
                                        {cfg.icon} {cfg.label}
                                    </span>
                                </div>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: '5px' }}>
                                        {mem.content}
                                    </div>
                                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                                        <span>Added: {timeAgo(mem.created_at)}</span>
                                        <span>Used: {mem.used_count} times</span>
                                        <span>Relevance: {(mem.relevance * 100).toFixed(0)}%</span>
                                    </div>
                                </div>
                                <button
                                    onClick={() => handleDelete(mem.id)}
                                    style={{ flexShrink: 0, background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px', alignSelf: 'flex-start' }}
                                    title="Delete"
                                    onMouseEnter={e => (e.currentTarget.style.color = 'var(--accent-red)')}
                                    onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-muted)')}
                                >
                                    <Trash2 size={13} />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}

            {/* Identity History */}
            <IdentityHistory agentId={agentId} />
        </div>
    );
}
